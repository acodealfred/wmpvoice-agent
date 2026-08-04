"""HTTP route handlers for report generation (deterministic + on-demand LLM + SSoT)."""
import asyncio
import json
import logging

from aiohttp import web

from ciq.common.json_utils import parse_llm_json, safe_json, strip_llm_error
from ciq.kb.mithra_client import call_mithra_kb_chat, call_report_llm
from ciq.reports.prompts import (
    build_analysis_prompt,
    build_biometric_facts,
    build_consultative_prompt,
    build_consultative_prompt_sections,
    build_report_context,
)
from db import (
    ensure_survey_record,
    merge_survey_record_json,
    save_bat4_scores,
    save_behaviour_snapshot_after,
    save_behaviour_snapshot_before,
    save_cbi3_scores,
    save_survey_item_responses,
    save_survey_record_results,
    save_survey_record_snapshot,
    update_survey_record_ssot,
)
from survey_loader import (
    compute_survey_summary,
    effective_score,
    serialize_survey_results,
)

logger = logging.getLogger("voicerag")

# Keeps references to fire-and-forget post-behaviour persistence tasks alive
# (asyncio drops a task with no other referent) until they finish on their own.
_background_tasks: set[asyncio.Task] = set()


async def analyze_report(request):
    """Build the DETERMINISTIC burnout report (no LLM) and persist it.

    The two AI text generations (behavioral analysis + consultative summary) are NOT run
    here — they are produced on demand via /report/behavioral-analysis and
    /report/consultative-summary, so the report appears near-instantly after a survey.
    """
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        survey_run_id = data.get("survey_run_id", "")
        survey_type = data.get("survey_type", "")
        snapshots = data.get("snapshots", [])

        if not snapshots:
            return web.json_response({"error": "No snapshot data provided"}, status=400)

        rtmt = request.app.get("rtmt")
        if not rtmt:
            return web.json_response({"error": "Analysis service not available"}, status=503)
        survey_config = rtmt.get_survey_config_for_session(session_id)

        # ── Deterministic scoring (no LLM) via the shared source of truth. ──
        summary = compute_survey_summary(survey_config, snapshots)
        domain_totals = summary["domainTotals"]
        survey_results_snapshot = serialize_survey_results(snapshots)

        # Surveys with independent scoringSections (e.g. PILOT's BAT-4 / CBI-WRB3) report
        # `sections` instead of one combined totalScore/riskLevel — see compute_survey_summary.
        if "sections" in summary:
            technical_report = {"analysis": {}, "sections": summary["sections"], "domainTotals": domain_totals}
            response_body = {"analysis": {}, "agentResponse": "", "sections": summary["sections"], "domainTotals": domain_totals}
        else:
            technical_report = {
                "analysis": {},
                "totalScore": summary["totalScore"],
                "riskLevel": summary["riskLevel"],
                "interpretation": summary["interpretation"],
                "domainTotals": domain_totals,
            }
            response_body = {
                "analysis": {},
                "agentResponse": "",
                "totalScore": summary["totalScore"],
                "maxScore": summary["maxScore"],
                "riskLevel": summary["riskLevel"],
                "interpretation": summary["interpretation"],
                "domainTotals": domain_totals,
            }

        # Persist the deterministic report immediately so the history row is guaranteed.
        if request.get("auth_session") and survey_run_id:
            try:
                await ensure_survey_record(
                    survey_run_id, request["auth_session"]["user_id"],
                    request["session_token"], session_id, survey_type,
                )
                await save_survey_record_results(
                    survey_run_id,
                    survey_results_snapshot,
                    technical_report,
                    {"snapshotCount": len(snapshots), "agentResponse": ""},
                )
                logger.info("[APP] Deterministic report persisted to DB for run %s", survey_run_id[:8])
            except Exception as db_err:
                logger.error("[APP] Report persist failed: %s", db_err)

            try:
                await save_survey_item_responses(
                    survey_run_id, request["auth_session"]["user_id"], session_id,
                    survey_config, snapshots,
                )
            except Exception as item_err:
                logger.error("[APP] Item-level response persist failed: %s", item_err)

            if survey_type == "PILOT":
                try:
                    await _persist_pilot_subscales(
                        rtmt, survey_config, summary, snapshots,
                        survey_run_id, request["auth_session"]["user_id"], session_id,
                    )
                except Exception as pilot_err:
                    logger.error("[APP] Pilot BAT4/CBI3/behaviour persist failed: %s", pilot_err)

        # Seed the agent's follow-up Q&A context with the deterministic report.
        if session_id:
            rtmt.set_conversation_state_for_session(
                session_id, "report_delivered", build_report_context(summary, snapshots)
            )
        logger.info("[APP] ★ Deterministic report ready, state=report_delivered")

        return web.json_response(response_body)

    except Exception as e:
        logger.error(f"Report analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


_BAT4_QUESTION_IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4"]
_CBI3_QUESTION_IDS = ["cbi_q1", "cbi_q2", "cbi_q3"]


async def _persist_pilot_subscales(
    rtmt, survey_config: dict, summary: dict, snapshots: list,
    survey_run_id: str, user_id: str, session_id: str,
) -> None:
    """Write the BAT-4 / CBI-WRB3 / behaviour rows for one PILOT survey run.

    Purely additive to the existing survey_records JSON blob — reuses the same
    reverse-aware `effective_score` and `compute_section_scores` output
    (`summary["sections"]`) the deterministic report already computed, so these
    tables can never diverge from the persisted technical_report.
    """
    by_id = {s.get("questionId"): s.get("score") for s in snapshots}
    sections_by_id = {s["id"]: s for s in summary.get("sections", [])}

    bat4_section = sections_by_id.get("bat4")
    if bat4_section:
        responses = {q: by_id.get(q) for q in _BAT4_QUESTION_IDS}
        answered = [
            effective_score(survey_config, q, v) for q, v in responses.items() if v is not None
        ]
        total_score = sum(answered) if answered else None
        await save_bat4_scores(
            survey_run_id, user_id, session_id, responses, total_score,
            bat4_section.get("score"), bat4_section.get("riskLevel"),
        )

    cbi3_section = sections_by_id.get("cbi_wrb3")
    if cbi3_section:
        item_7_raw, item_11_raw, item_13_raw = (by_id.get(q) for q in _CBI3_QUESTION_IDS)
        item_13_reversed = (
            effective_score(survey_config, "cbi_q3", item_13_raw) if item_13_raw is not None else None
        )
        answered = [
            effective_score(survey_config, q, by_id.get(q))
            for q in _CBI3_QUESTION_IDS if by_id.get(q) is not None
        ]
        total_score = sum(answered) if answered else None
        await save_cbi3_scores(
            survey_run_id, user_id, session_id,
            item_7_raw, item_11_raw, item_13_raw, item_13_reversed, total_score,
            cbi3_section.get("score"), cbi3_section.get("riskLevel"),
        )

    pre_snap = rtmt.get_behaviour_snapshots_for_session(session_id).get("pre")
    if pre_snap:
        await save_behaviour_snapshot_before(
            survey_run_id, user_id, session_id,
            pre_snap.get("blink_rate"), pre_snap.get("pupil_dilation"),
        )

    # The post-survey 10s capture window starts the moment the last question is
    # scored — the same event that triggers this whole request — so it is almost
    # never ready yet. Persist it in the background instead of awaiting it here:
    # /analyze-report must stay near-instant (its whole point per its docstring),
    # so the up-to-~10s wait must never block the report the user is looking at.
    _schedule_post_behaviour_persist(rtmt, session_id, survey_run_id, user_id)


def _schedule_post_behaviour_persist(rtmt, session_id: str, survey_run_id: str, user_id: str) -> None:
    """Fire-and-forget: wait for the post-survey capture window, then persist it."""
    async def _run():
        await rtmt.await_post_behaviour_capture(session_id)
        post_snap = rtmt.get_behaviour_snapshots_for_session(session_id).get("post")
        if post_snap:
            try:
                await save_behaviour_snapshot_after(
                    survey_run_id, user_id, session_id,
                    post_snap.get("blink_rate"), post_snap.get("pupil_dilation"), post_snap.get("response_latency_ms"),
                )
            except Exception as e:
                logger.error("[APP] Post-behaviour snapshot persist failed: %s", e)

    task = asyncio.create_task(_run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def report_behavioral_analysis(request):
    """POST /report/behavioral-analysis — run the behavioral-analysis LLM on demand."""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        survey_run_id = data.get("survey_run_id", "")
        snapshots = data.get("snapshots", [])
        if not snapshots:
            return web.json_response({"error": "No snapshot data provided"}, status=400)

        rtmt = request.app.get("rtmt")
        if not rtmt:
            return web.json_response({"error": "Analysis service not available"}, status=503)
        survey_config = rtmt.get_survey_config_for_session(session_id)

        analysis_result_str = await rtmt.analyze_with_prompt(build_analysis_prompt(survey_config, snapshots))
        analysis_result_str = strip_llm_error(analysis_result_str)
        if not analysis_result_str:
            return web.json_response({"error": "Behavioral analysis is unavailable right now."}, status=503)
        analysis_data = parse_llm_json(analysis_result_str)
        if analysis_data is None:
            analysis_data = {"raw": analysis_result_str}

        # Persist analysis into the existing history row + refresh the agent's context.
        summary = compute_survey_summary(survey_config, snapshots)
        if request.get("auth_session") and survey_run_id:
            try:
                await merge_survey_record_json(
                    survey_run_id, technical_report_patch={"analysis": analysis_data}
                )
            except Exception as db_err:
                logger.error("[APP] Failed to persist behavioral analysis: %s", db_err)
        if session_id:
            rtmt.set_conversation_state_for_session(
                session_id, "report_delivered",
                build_report_context(summary, snapshots, analysis_data=analysis_data),
            )

        return web.json_response({"analysis": analysis_data})
    except Exception as e:
        logger.error(f"Behavioral analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def report_consultative_summary(request):
    """POST /report/consultative-summary — run the consultative-summary LLM on demand.

    Accepts an optional `analysis` (the already-generated behavioral analysis) so the
    summary can reference it; works fine without it (deterministic score/risk + biometrics).
    """
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        survey_run_id = data.get("survey_run_id", "")
        snapshots = data.get("snapshots", [])
        analysis_data = data.get("analysis") or None
        if not snapshots:
            return web.json_response({"error": "No snapshot data provided"}, status=400)

        rtmt = request.app.get("rtmt")
        if not rtmt:
            return web.json_response({"error": "Analysis service not available"}, status=503)
        survey_config = rtmt.get_survey_config_for_session(session_id)

        summary = compute_survey_summary(survey_config, snapshots)
        biometric_facts = build_biometric_facts(snapshots)
        analysis_str = json.dumps(analysis_data) if isinstance(analysis_data, dict) else ""

        if "sections" in summary:
            prompt = build_consultative_prompt_sections(summary["sections"], biometric_facts, analysis_str)
        else:
            prompt = build_consultative_prompt(
                summary["totalScore"], summary["maxScore"], summary["interpretation"],
                biometric_facts, analysis_str,
            )
        response_text = await rtmt.analyze_with_prompt(prompt)
        response_text = strip_llm_error(response_text)
        if not response_text:
            return web.json_response({"error": "Consultative summary is unavailable right now."}, status=503)

        # Persist the spoken summary + enrich the agent's context so it can reference it.
        if request.get("auth_session") and survey_run_id:
            try:
                await merge_survey_record_json(
                    survey_run_id, prompt_info_patch={"agentResponse": response_text}
                )
            except Exception as db_err:
                logger.error("[APP] Failed to persist consultative summary: %s", db_err)
        if session_id:
            rtmt.set_conversation_state_for_session(
                session_id, "report_delivered",
                build_report_context(summary, snapshots, response_text=response_text, analysis_data=analysis_data),
            )

        return web.json_response({"agentResponse": response_text})
    except Exception as e:
        logger.error(f"Consultative summary error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def generate_ssot_report(request):
    """POST /ssot-report — build a templated query from survey snapshots and return the Mithra KB answer."""
    try:
        data = await request.json()
        snapshots = data.get("snapshots", [])
        session_id = data.get("session_id", "")
        survey_run_id = data.get("survey_run_id", "")
        survey_type = data.get("survey_type", "")

        query_override = data.get("query_override", "").strip()
        if not snapshots and not query_override:
            return web.json_response({"error": "Provide either snapshots or a query_override"}, status=400)

        # Canonical, reverse-aware scoring — same source of truth as /analyze-report.
        rtmt = request.app.get("rtmt")
        survey_config = rtmt.get_survey_config_for_session(session_id) if rtmt else {}
        summary = compute_survey_summary(survey_config, snapshots) if snapshots else {
            "totalScore": 0, "riskLevel": "Low", "interpretation": "Low burnout risk", "domainTotals": {}
        }
        if "sections" in summary:
            risk_phrase = " and ".join(f"{s['riskLevel']} {s['label']}" for s in summary["sections"]) + " burnout risk"
        else:
            risk_phrase = f"{summary['riskLevel']} burnout risk"
        sorted_domains = sorted(summary["domainTotals"].items(), key=lambda x: x[1], reverse=True)

        # Persist survey snapshots so they appear in the user's History tab.
        if request.get("auth_session") and snapshots and survey_run_id:
            survey_results_snapshot = serialize_survey_results(snapshots)
            if "sections" in summary:
                technical_snapshot = {
                    "sections": summary["sections"],
                    "domainTotals": summary["domainTotals"],
                    "analysis": {},
                }
            else:
                technical_snapshot = {
                    "totalScore": summary["totalScore"],
                    "riskLevel": summary["riskLevel"],
                    "interpretation": summary["interpretation"],
                    "domainTotals": summary["domainTotals"],
                    "analysis": {},
                }
            try:
                await ensure_survey_record(
                    survey_run_id,
                    request["auth_session"]["user_id"],
                    request["session_token"],
                    session_id,
                    survey_type,
                )
                await save_survey_record_snapshot(
                    survey_run_id,
                    survey_results_snapshot,
                    technical_snapshot,
                )
            except Exception as snap_err:
                logger.error("[APP] Failed to save survey snapshot from SSoT: %s", snap_err)

            try:
                await save_survey_item_responses(
                    survey_run_id, request["auth_session"]["user_id"], session_id,
                    survey_config, snapshots,
                )
            except Exception as item_err:
                logger.error("[APP] Item-level response persist failed (SSoT path): %s", item_err)

        # Allow the frontend (test generator) to supply a custom query.
        if query_override:
            mithra_query = query_override
            logger.info("[APP] /ssot-report using query_override: %s", mithra_query[:200])
        else:
            top2_domains = " and ".join(name for name, _ in sorted_domains[:2])
            mithra_query = (
                f"What are the root cause and recommendation for a person suffering with "
                f"{risk_phrase} caused by {top2_domains}."
            )
            logger.info("[APP] /ssot-report query (generated): %s", mithra_query[:200])

        # Stage 1: Mithra KB — raw facts + citations
        mithra_raw = await call_mithra_kb_chat(mithra_query)
        if not mithra_raw:
            if request.get("auth_session") and survey_run_id:
                try:
                    await update_survey_record_ssot(
                        survey_run_id,
                        {"error": "Knowledge Base unreachable — ensure documents are uploaded and MITHRA_APP_TOKEN is set."},
                    )
                except Exception:
                    pass
            return web.json_response(
                {"error": "Could not reach Knowledge Base. "
                          "Check MITHRA_APP_TOKEN and ensure documents are uploaded."},
                status=503,
            )

        # Stage 2 (optional): dedicated reporting LLM → physiometric consultative report.
        mithra_answer = mithra_raw.get("answer", "")
        mithra_citations = mithra_raw.get("citations", [])

        report_text = await call_report_llm(mithra_answer, mithra_citations)
        llm_used = bool(report_text)
        ssot_report = {
            "answer": report_text if llm_used else mithra_answer,
            "citations": mithra_citations,
        }
        logger.info("[APP] /ssot-report complete — llm_used=%s answer_len=%d citations=%d",
                    llm_used, len(ssot_report["answer"]), len(ssot_report["citations"]))

        # Persist SSoT result to DB for history view
        if request.get("auth_session") and survey_run_id:
            try:
                await update_survey_record_ssot(survey_run_id, ssot_report)
            except Exception as db_err:
                logger.error("[APP] Failed to persist SSoT report: %s", db_err)

        # Store conversation state so the agent can answer follow-up Q&A
        rtmt_instance = request.app.get("rtmt")
        if session_id and rtmt_instance:
            ctx = f"KB Report: {(report_text or mithra_answer)[:500]}"
            rtmt_instance.set_conversation_state_for_session(session_id, "report_delivered", ctx)

        return web.json_response(safe_json({
            "mithraRaw": mithra_raw,
            "ssotReport": ssot_report,
            "llmUsed": llm_used,
            "query": mithra_query,
        }))

    except Exception as e:
        logger.error("generate_ssot_report error: %s", e)
        return web.json_response({"error": str(e)}, status=500)
