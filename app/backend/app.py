import base64
import json
import logging
import os
from pathlib import Path

import aiohttp
import boto3
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential
from dotenv import load_dotenv

from auth import auth_middleware, login, logout, me
from biometric_interpreter import analyze_stress
from db import (
    ensure_survey_record,
    save_survey_record_results,
    save_survey_record_snapshot,
    update_survey_record_ssot,
    get_user_survey_records,
)
from db_init import init_db
from rtmt import RTMiddleTier

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("voicerag")
logger.setLevel(logging.INFO)

_APP_VERSION = "v2025-admin-routes"  # bump this string whenever you need to verify deployment
logger.info("=== CIQ backend starting — build %s ===", _APP_VERSION)


def _blink_band(change_pct) -> str:
    """Map a baseline-relative blink-rate change (%) to a Low/Medium/High category.

    Bands from the CIQ Signal-Thresholds reference (blink rate is baseline-relative):
      Normal:   |Δ| ≤ 15%
      Elevated: 15% < |Δ| ≤ 40%
      High:     |Δ| > 40%
    Direction is retained because it changes meaning — suppression (below baseline)
    indicates focused visual attention; an increase (above baseline) indicates fatigue
    or higher arousal. Stress must NOT be inferred from blink rate alone.
    """
    if change_pct is None:
        return "Unknown"
    mag = abs(change_pct)
    if mag <= 15:
        return "Normal"
    level = "Elevated" if mag <= 40 else "High"
    direction = "above baseline" if change_pct > 0 else "below baseline"
    return f"{level} ({direction})"


def _pupil_band(mm_change) -> str:
    """Map pupil-dilation change (mm vs baseline) to a category.

    Bands from the CIQ Signal-Thresholds reference (pupil dilation / TEPR):
      Low:    Δ ≤ +0.1 mm  (includes constriction)
      Medium: +0.1 < Δ ≤ +0.3 mm
      High:   Δ > +0.3 mm
    Caveat: dominated by the pupillary light reflex — webcam estimates are coarse.
    """
    if mm_change is None:
        return "Unknown"
    if mm_change <= 0.1:
        return "Low"
    if mm_change <= 0.3:
        return "Medium"
    return "High"


async def analyze_report(request):
    """Analyze the detailed burnout report using behavioral analysis engine"""
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
        from survey_loader import effective_score
        survey_config = rtmt._survey_config

        # Ground truth for analysis — biometric behavioral rules, expressed as the
        # categorical (Low/Medium/High) bands from the CIQ Signal-Thresholds reference.
        research_rules = """
Blink-rate category (relative to the person's own calibrated baseline):
- "Normal": blink rate within ±15% of baseline.
- "Elevated": a sustained 15–40% change from baseline.
- "High": a sustained change greater than 40% from baseline (treat as significant only
  if corroborated by another signal).
Direction matters and is encoded in the category:
- "below baseline" (suppression) is associated with focused visual attention / engagement.
- "above baseline" (increase) is associated with fatigue or higher arousal / non-visual load.

Pupil-dilation category (change in mm vs the person's baseline):
- "Low": ≤ +0.1 mm (includes constriction).
- "Medium": +0.1 to +0.3 mm — moderate cognitive load.
- "High": > +0.3 mm — high cognitive load.
Caveat: pupil size is dominated by the light reflex; webcam estimates are coarse.

Do NOT infer stress from any single signal — none of these has a validated stress threshold.
The "burnout_score" per question is already burnout-direction (positive items reverse-scored).
"""

        # Build input data from snapshots — biometrics are provided as CATEGORIES (not raw
        # numbers) and the score is burnout-direction (reverse items already flipped).
        input_data = []
        for s in snapshots:
            input_data.append({
                "question": s.get("questionId", ""),
                "domain": s.get("domain", ""),
                "burnout_score": effective_score(survey_config, s.get("questionId", ""), s.get("score", 0)),
                "voice_sentiment": s.get("voiceSentiment", "neutral"),
                "blink_rate_category": _blink_band(s.get("blinkRateChange")),
                "pupil_dilation_category": _pupil_band(s.get("pupilMmChange")),
                "gaze_position": s.get("gazePosition", "Center"),
            })

        # System prompt for the analysis engine
        system_prompt = f"""You are a behavioral analysis engine.

You MUST follow these rules strictly:

GROUNDING RULES:
- Use ONLY the provided "Research Rules" and "Input Data"
- Do NOT use external knowledge, assumptions, or general psychology
- If a conclusion cannot be derived from the rules, return "insufficient_evidence"

RESEARCH RULES:
{research_rules}

INPUT DATA:
{input_data}

EVIDENCE REQUIREMENT:
- Every insight MUST include: the exact rule used, the exact data point used

OUTPUT RULES:
- Output MUST be valid JSON
- No explanations outside JSON
- No additional commentary

ANALYSIS RULES:
- Identify correlations between score and biometric change
- Highlight contradictions (e.g., high score + stress signal)
- Detect repeated patterns across questions
- Be conservative: prefer "insufficient_evidence" over guessing

CONFIDENCE:
- High: clear rule match + strong signal
- Medium: partial match
- Low: weak or borderline signal

Output JSON format:
{{
  "correlations": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "contradictions": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "patterns": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "summary": "Consultative summary of findings"
}}
"""

        # ── Deterministic scoring (no LLM) — computed up-front via the shared source
        # of truth so /analyze-report, /ssot-report and the agent never diverge, and so
        # the survey is persisted to history BEFORE any LLM call (record guaranteed even
        # if behavioral analysis / the consultative response below fails). ──
        from survey_loader import compute_survey_summary, serialize_survey_results
        summary = compute_survey_summary(survey_config, snapshots)
        total_score = summary["totalScore"]
        max_score = summary["maxScore"]
        risk_level = summary["riskLevel"]
        interpretation = summary["interpretation"]
        domain_totals = summary["domainTotals"]
        domain_summary = "\n".join(f"- {dom}: {score} points" for dom, score in domain_totals.items())
        survey_results_snapshot = serialize_survey_results(snapshots)

        # Early persistence: write survey results + deterministic report NOW so the
        # history row is guaranteed even if the LLM calls below fail. COALESCE-based, so
        # the later full save (which adds the behavioral analysis) enriches the same row.
        if request.get("auth_session") and survey_run_id:
            try:
                await ensure_survey_record(
                    survey_run_id, request["auth_session"]["user_id"],
                    request["session_token"], session_id, survey_type,
                )
                await save_survey_record_snapshot(
                    survey_run_id,
                    survey_results_snapshot,
                    {
                        "analysis": {},
                        "totalScore": total_score,
                        "riskLevel": risk_level,
                        "interpretation": interpretation,
                        "domainTotals": domain_totals,
                    },
                )
                logger.info("[APP] Survey pre-persisted to DB for run %s", survey_run_id[:8])
            except Exception as db_err:
                logger.error("[APP] Early survey persist failed: %s", db_err)

        # Call LLM for behavioral analysis
        analysis_result_str = await rtmt.analyze_with_prompt(system_prompt)

        # Parse analysis result
        try:
            analysis_data = json.loads(analysis_result_str)
        except json.JSONDecodeError:
            analysis_data = {"raw": analysis_result_str}

        # (total_score, risk_level, interpretation, domain_totals and domain_summary
        # are computed up-front above, before the LLM calls, so the survey is persisted
        # regardless of LLM outcome.)

        # Snapshot lines — biometrics stated as categories, not raw numbers.
        snapshot_lines = []
        for s in snapshots:
            snapshot_lines.append(
                f"Q{s.get('questionId','')}: score={s.get('score',0)}, domain={s.get('domain','')}, "
                f"voice_sentiment={s.get('voiceSentiment','')}, blink_rate={_blink_band(s.get('blinkRateChange'))}, "
                f"pupil_dilation={_pupil_band(s.get('pupilMmChange'))}, gaze_position={s.get('gazePosition','')}"
            )
        snapshot_summary = "\n".join(snapshot_lines)

        # Aggregate biometric readings to STATE factually in the spoken report
        # (no interpretation, no link to burnout — just the categories/values).
        blink_changes = [s.get("blinkRateChange") or 0 for s in snapshots]
        avg_blink_change = sum(blink_changes) / len(blink_changes) if blink_changes else 0
        overall_blink_category = _blink_band(avg_blink_change)
        pupil_changes = [s.get("pupilMmChange") or 0 for s in snapshots]
        avg_pupil_change = sum(pupil_changes) / len(pupil_changes) if pupil_changes else 0
        overall_pupil_category = _pupil_band(avg_pupil_change)
        gaze_counts: dict = {}
        for s in snapshots:
            g = s.get("gazePosition") or "Center"
            gaze_counts[g] = gaze_counts.get(g, 0) + 1
        dominant_gaze = max(gaze_counts, key=gaze_counts.get) if gaze_counts else "Center"
        per_q_blink = ", ".join(
            f"{s.get('questionId','')}={_blink_band(s.get('blinkRateChange'))}" for s in snapshots
        )
        per_q_pupil = ", ".join(
            f"{s.get('questionId','')}={_pupil_band(s.get('pupilMmChange'))}" for s in snapshots
        )
        per_q_gaze = ", ".join(
            f"{s.get('questionId','')}={s.get('gazePosition') or 'Center'}" for s in snapshots
        )
        biometric_facts = (
            f"- Overall blink-rate category: {overall_blink_category}\n"
            f"- Blink-rate category per question: {per_q_blink}\n"
            f"- Overall pupil-dilation category: {overall_pupil_category}\n"
            f"- Pupil-dilation category per question: {per_q_pupil}\n"
            f"- Most frequent eye-gaze position: {dominant_gaze}\n"
            f"- Eye-gaze position per question: {per_q_gaze}"
        )

        # Build consultative prompt that explicitly states score/risk
        consultative_prompt = f"""You are a workplace wellbeing consultant reviewing the burnout assessment results.

FACTUAL SUMMARY (START YOUR RESPONSE BY STATING THIS):
- Total Burnout Score: {total_score} out of {max_score}
- Burnout Risk Level: {interpretation}

BEHAVIORAL ANALYSIS (for your reference):
{analysis_result_str}

BIOMETRIC READINGS (state these as plain facts — do NOT interpret them):
{biometric_facts}

Please provide a consultative response that:
1. Begins by clearly stating the total score and burnout risk level.
2. Highlights key findings from the analysis (correlations, contradictions, patterns).
3. Explains what the score means in practical terms.
4. Offers actionable insights and next steps based on the burnout findings.
5. Maintains a warm, supportive, professional tone.
6. Ends with a SEPARATE final paragraph that begins with the word "Also" and simply
   STATES the biometric readings above (blink-rate category, pupil-dilation category and
   eye-gaze position) as plain facts.

STRICT RULES FOR THE FINAL "Also" BIOMETRIC PARAGRAPH:
- Only report the biometric values exactly as given in BIOMETRIC READINGS.
- Do NOT explain, interpret, or speculate on what the biometrics mean.
- Do NOT connect the biometrics to burnout, stress, the score, or the user's wellbeing in any way.
- Keep it to one or two short factual sentences.

Keep your response conversational and audio-friendly (short paragraphs, clear points).
IMPORTANT: Speak this response aloud to the user. Do NOT include JSON or code formatting."""

        response_text = await rtmt.analyze_with_prompt(consultative_prompt)

        # If the chat-completions deployment is unavailable, analyze_with_prompt returns
        # an {"error": ...} JSON string. Blank both outputs so the report simply omits the
        # analysis section (as if the feature isn't there) instead of surfacing a raw error.
        # The deterministic score/risk computed above are unaffected.
        try:
            _parsed = json.loads(response_text)
            if isinstance(_parsed, dict) and "error" in _parsed:
                response_text = ""
        except Exception:
            pass
        if isinstance(analysis_data, dict) and "error" in analysis_data:
            analysis_data = {}

        # The Mithra/KB evidence report is generated separately by the UI's
        # "Generate AI Report" button (POST /ssot-report), so /analyze-report no
        # longer makes a redundant KB call here — keeping it fast and focused on
        # the data-driven risk + behavioral analysis + consultative summary.

        # Build comprehensive report context for follow-up Q&A
        analysis_block = json.dumps(analysis_data, indent=2) if isinstance(analysis_data, dict) else str(analysis_data)
        report_context_full = f"""=== BURNOUT ASSESSMENT REPORT (COMPLETE) ===
TOTAL SCORE: {total_score}/{max_score}
RISK LEVEL: {risk_level} ({interpretation})

=== DOMAIN TOTALS ===
{domain_summary}

=== QUESTION DETAILS ===
{snapshot_summary}

=== AGENT CONSULTATIVE RESPONSE (spoken to user) ===
{response_text}

=== BEHAVIORAL ANALYSIS (JSON) ===
{analysis_block}
=== END REPORT ===
"""
        if session_id:
            rtmt.set_conversation_state_for_session(session_id, "report_delivered", report_context_full)
        logger.info("[APP] ★ Report delivered, state=report_delivered with full context including burnout state")

        # Persist results to DB if the request is from an authenticated user.
        # Reuses the canonical survey_results_snapshot built up-front; the full save
        # adds the behavioral analysis on top of the deterministic figures.
        if request.get("auth_session") and survey_run_id:
            technical_report_data = {
                "analysis": analysis_data,
                "totalScore": total_score,
                "riskLevel": risk_level,
                "interpretation": interpretation,
                "domainTotals": domain_totals,
            }
            prompt_info_data = {
                "snapshotCount": len(snapshots),
                "promptPreview": consultative_prompt[:300],
                "agentResponse": response_text,
            }
            try:
                await ensure_survey_record(
                    survey_run_id,
                    request["auth_session"]["user_id"],
                    request["session_token"],
                    session_id,
                    survey_type,
                )
                await save_survey_record_results(
                    survey_run_id,
                    survey_results_snapshot,
                    technical_report_data,
                    prompt_info_data,
                )
                logger.info("[APP] Report persisted to DB for survey run %s", survey_run_id[:8])
            except Exception as db_err:
                logger.error("[APP] Failed to persist report to DB: %s", db_err)

        return web.json_response({
            "analysis": analysis_data,
            "agentResponse": response_text,
            # Data-driven values computed from the active survey's thresholds/interpretation
            # (single source of truth for the report UI — replaces the old hardcoded bands).
            "totalScore": total_score,
            "maxScore": max_score,
            "riskLevel": risk_level,
            "interpretation": interpretation,
            "domainTotals": domain_totals,
        })

    except Exception as e:
        logger.error(f"Report analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


# ── KB document metadata persistence (flat JSON file) ──────────────────────
# Survives browser refreshes and is visible from any browser/device hitting
# the same container. Does NOT survive container restarts — for a POC this
# is sufficient. Mount a persistent volume for true durability.

_KB_DOCS_FILE = Path(__file__).parent / "data" / "kb_documents.json"


def _load_kb_docs() -> list:
    try:
        if _KB_DOCS_FILE.exists():
            return json.loads(_KB_DOCS_FILE.read_text(encoding="utf-8"))
        return []
    except Exception:
        return []


def _save_kb_docs(docs: list) -> None:
    _KB_DOCS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _KB_DOCS_FILE.write_text(json.dumps(docs, indent=2), encoding="utf-8")


async def admin_kb_list_documents(request):
    """GET /admin/kb/documents — return persisted document metadata."""
    return web.json_response({"documents": _load_kb_docs()})


async def admin_list_users(request: web.Request) -> web.Response:
    """GET /admin/users — list all users with session stats."""
    from db import get_all_users_with_session_info
    users = await get_all_users_with_session_info()
    return web.json_response({"users": users})


async def user_sessions_history(request: web.Request) -> web.Response:
    """GET /api/history — return the logged-in user's completed survey runs."""
    user_id = request["auth_session"]["user_id"]
    records = await get_user_survey_records(user_id)
    for r in records:
        for col in ("survey_results", "technical_report", "prompt_info"):
            if r.get(col):
                try:
                    r[col] = json.loads(r[col])
                except Exception:
                    pass
    return web.json_response({"records": records})


# ── SSOT report ─────────────────────────────────────────────────────────────

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

        # Canonical, reverse-aware scoring — same source of truth as /analyze-report
        # and the agent's query_survey_results tool (no raw sums or hardcoded thresholds).
        from survey_loader import compute_survey_summary, serialize_survey_results
        rtmt = request.app.get("rtmt")
        survey_config = rtmt._survey_config if rtmt else {}
        summary = compute_survey_summary(survey_config, snapshots) if snapshots else {
            "totalScore": 0, "riskLevel": "Low", "interpretation": "Low burnout risk", "domainTotals": {}
        }
        risk_phrase = f"{summary['riskLevel']} burnout risk"
        sorted_domains = sorted(summary["domainTotals"].items(), key=lambda x: x[1], reverse=True)

        # Persist survey snapshots so they appear in the user's History tab.
        # Uses COALESCE so it never overwrites data saved by /analyze-report.
        if request.get("auth_session") and snapshots and survey_run_id:
            survey_results_snapshot = serialize_survey_results(snapshots)
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

        # Allow the frontend (test generator) to supply a custom query.
        # If query_override is provided and non-empty, use it directly.
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
        mithra_raw = await _call_mithra_kb_chat(mithra_query)
        if not mithra_raw:
            # Persist failure so history tab can show "KB unavailable" message
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
        # Falls back to raw Mithra answer if REPORT_OPENAI_* env vars are not configured.
        mithra_answer = mithra_raw.get("answer", "")
        mithra_citations = mithra_raw.get("citations", [])

        report_text = await _call_report_llm(mithra_answer, mithra_citations)
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

        return web.json_response(_safe_json({
            "mithraRaw": mithra_raw,
            "ssotReport": ssot_report,
            "llmUsed": llm_used,
            "query": mithra_query,
        }))

    except Exception as e:
        logger.error("generate_ssot_report error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def analyze_face(request, rtmt: RTMiddleTier):
    """Analyze face from image data using AWS Rekognition"""
    try:
        data = await request.json()
        image_data = data.get("image", "")

        if not image_data:
            return web.json_response({"error": "No image data provided"}, status=400)

        aws_region = os.environ.get("AWS_REGION", "us-east-1")
        aws_access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        aws_secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")

        client_kwargs = {"region_name": aws_region}
        if (
            aws_access_key
            and aws_secret_key
            and not aws_secret_key.startswith("secretref:")
        ):
            client_kwargs["aws_access_key_id"] = aws_access_key
            client_kwargs["aws_secret_access_key"] = aws_secret_key

        rekognition = boto3.client("rekognition", **client_kwargs)

        image_bytes = base64.b64decode(image_data.split(",")[1])

        response = rekognition.detect_faces(
            Image={"Bytes": image_bytes}, Attributes=["ALL"]
        )

        face_details = response.get("FaceDetails", [])

        if not face_details:
            return web.json_response({"emotion": "No face detected", "confidence": 0})

        if len(face_details) > 1:
            return web.json_response(
                {"emotion": "multiple_faces_detected", "confidence": 100}
            )

        emotions = face_details[0].get("Emotions", [])
        if not emotions:
            return web.json_response(
                {"emotion": "No emotion detected", "confidence": 0}
            )

        top_emotion = max(emotions, key=lambda x: x.get("Confidence", 0))

        return web.json_response(
            {
                "emotion": top_emotion.get("Type", "UNKNOWN"),
                "confidence": top_emotion.get("Confidence", 0),
                "allEmotions": [
                    {"type": e["Type"], "confidence": e["Confidence"]} for e in emotions
                ],
            }
        )

    except Exception as e:
        logger.error(f"Face analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def get_config(request):
    """Return current feature configuration to frontend"""
    rtmt = request.app.get("rtmt")
    return web.json_response(
        {
            "enableSentimentAnalysis": os.environ.get(
                "ENABLE_SENTIMENT_ANALYSIS", "false"
            ).lower()
            == "true",
            "enableSurveyMode": os.environ.get("ENABLE_SURVEY_MODE", "false").lower()
            == "true",
            "surveyTypeOverridden": rtmt.survey_type_overridden if rtmt else False,
            "activeSurveyType": rtmt.active_survey_type if rtmt else "TEST",
            "availableSurveyTypes": ["TEST", "BATFULL", "CBTFULL"],
            "biometricGuardrailEnabled": rtmt.biometric_guardrail_enabled if rtmt else True,
        }
    )


async def set_survey_type(request):
    """Update the active survey type (blocked when overridden by ENV)"""
    rtmt = request.app.get("rtmt")
    if not rtmt:
        return web.json_response({"error": "Service not available"}, status=503)
    if rtmt.survey_type_overridden:
        return web.json_response({"error": "Survey type is locked by environment configuration"}, status=403)
    data = await request.json()
    survey_type = data.get("surveyType", "TEST").upper()
    rtmt.set_survey_type(survey_type)
    return web.json_response({"activeSurveyType": rtmt.active_survey_type})


async def set_biometric_guardrail(request):
    """Toggle the biometric descriptive-only guardrail at runtime (from the Admin tab).

    POC NOTE: this is gated only by auth_middleware (any logged-in user), NOT by an
    admin role — the app has no role tier yet, so the Admin tab is not a hardened
    authorization boundary. Acceptable here because all accounts are trusted operators.
    Takes effect on the next conversation turn / new session (instructions are injected
    per session.update), like the survey-type change.
    """
    rtmt = request.app.get("rtmt")
    if not rtmt:
        return web.json_response({"error": "Service not available"}, status=503)
    data = await request.json()
    enabled = bool(data.get("enabled", True))
    rtmt.set_biometric_guardrail(enabled)
    return web.json_response({"biometricGuardrailEnabled": rtmt.biometric_guardrail_enabled})


async def get_version(request):
    """Return build version and REAL registered routes from the live router."""
    live_routes = [str(r) for r in request.app.router.resources()]
    admin_registered = any("admin" in r for r in live_routes)
    return web.json_response({
        "version": _APP_VERSION,
        "admin_routes_registered": admin_registered,
        "all_routes": live_routes,
    })


async def update_stress_state(request, rtmt: RTMiddleTier):
    """Update the stress state for adaptive communication"""
    try:
        data = await request.json()
        stress_state = data.get("stress_state", "normal")

        valid_states = ["stressed", "relaxed", "normal"]
        if stress_state not in valid_states:
            return web.json_response(
                {"error": f"Invalid stress state. Must be one of: {valid_states}"},
                status=400,
            )

        logger.info(f"[APP] ★ Received stress state update request: {stress_state}")
        rtmt.set_stress_state(stress_state)
        logger.info(f"[APP] ★ Stress state updated to: {stress_state}")

        return web.json_response({"success": True, "stress_state": stress_state})
    except Exception as e:
        logger.error(f"Error updating stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_stress_state(request, rtmt: RTMiddleTier):
    """Clear the stress state after survey completion"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        sess = rtmt.get_or_create_session(session_id)
        sess.stress_state = "normal"
        sess.blink_rate_history.clear()
        sess.face_emotion_history.clear()
        sess.current_blink_rate_change = 0.0
        sess.current_face_emotion = "NEUTRAL"
        sess.current_gaze_position = "Center"
        logger.info("[APP] ★ Stress state and biometric history cleared (session=%s)", session_id)
        return web.json_response({"success": True, "stress_state": "normal"})
    except Exception as e:
        logger.error(f"Error clearing stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_conversation_state(request, rtmt: RTMiddleTier):
    """Reset conversation state when starting a fresh interaction"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        rtmt.clear_conversation_state_for_session(session_id)
        logger.info("[APP] ★ Conversation state cleared (session=%s)", session_id)
        return web.json_response({"success": True, "state": "active"})
    except Exception as e:
        logger.error(f"Error clearing conversation state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def update_biometrics(request, rtmt: RTMiddleTier):
    """Update current biometric data for survey response capture"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        sentiment = data.get("sentiment", "neutral")
        blink_rate_change = data.get("blink_rate_change_percent", 0.0)
        face_emotion = data.get("face_emotion", "NEUTRAL")
        gaze_position = data.get("gaze_position", "Center")
        pupil_mm_change = data.get("pupil_mm_change", 0.0)

        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)

        sess = rtmt.get_or_create_session(session_id)
        sess.current_sentiment = sentiment
        sess.current_blink_rate_change = blink_rate_change
        sess.current_face_emotion = face_emotion
        sess.current_gaze_position = gaze_position
        sess.current_pupil_mm_change = pupil_mm_change
        rtmt._update_biometric_history_for_session(sess, blink_rate_change, face_emotion)

        logger.info(
            f"[APP] ★ Biometrics updated: sentiment={sentiment}, blink_change={blink_rate_change}%, emotion={face_emotion}, gaze={gaze_position} (session={session_id})"
        )
        logger.info(
            f"[APP] ★ History Debug - blink_history length: {len(sess.blink_rate_history)}, "
            f"emotion_history length: {len(sess.face_emotion_history)}, "
            f"emotion history: {sess.face_emotion_history[-5:] if sess.face_emotion_history else 'empty'}"
        )

        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error updating biometrics: {e}")
        return web.json_response({"error": str(e)}, status=500)


def _mithra_headers() -> dict:
    """Auth header for all Mithra API calls.
    Azure Container Apps: create secret named 'mithra-app-token', then map it to
    env var MITHRA_APP_TOKEN in the container's environment variable configuration.
    os.environ reads env vars (not secrets directly); hyphens in env var names are
    non-standard, so always use MITHRA_APP_TOKEN as the mapped env var name.
    """
    token = os.environ.get("MITHRA_APP_TOKEN", "")
    return {"Authorization": f"Bearer {token}"}


def _mithra_base_url() -> str:
    return os.environ.get("MITHRA_API_BASE_URL", "https://api.dev.mithra.shelterzoom.com")


def _mithra_session() -> aiohttp.ClientSession:
    """ClientSession with SSL verification disabled for the Mithra dev server.
    The dev certificate hostname doesn't match api.dev.mithra.shelterzoom.com, so we
    skip verification. Remove ssl=False once a valid cert is in place.
    """
    connector = aiohttp.TCPConnector(ssl=False)
    return aiohttp.ClientSession(connector=connector)


async def _mithra_response(resp) -> web.Response:
    """Convert a Mithra API response to an aiohttp response.
    Handles both JSON and non-JSON bodies (e.g. HTML error pages from the gateway)
    so a parsing failure never surfaces as a misleading 500.
    """
    raw = await resp.text()
    try:
        import json as _json
        body = _json.loads(raw)
        return web.json_response(body, status=resp.status)
    except Exception:
        # Non-JSON body (HTML error page, plain text, etc.)
        return web.Response(
            text=raw,
            status=resp.status,
            content_type="text/plain",
        )


async def _mithra_exc_response(handler_name: str, exc: Exception) -> web.Response:
    import traceback
    detail = traceback.format_exc()
    logger.error("[%s] %s\n%s", handler_name, exc, detail)
    return web.json_response({"error": str(exc), "detail": detail}, status=500)


def _safe_json(obj: object) -> object:
    """Recursively ensure all dict keys are strings so web.json_response never fails.
    None keys from external APIs (JSON null key) are converted to the string "null".
    """
    if isinstance(obj, dict):
        return {(str(k) if k is not None else "null"): _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_safe_json(i) for i in obj]
    return obj


async def _call_mithra_kb_chat(query: str) -> "dict | None":
    """Query the Mithra KB chat API with a single question.
    Per the API spec, CreateChatResponse only returns {chat: {id, ...}} — no answer.
    The answer lives in the chat messages, fetched via GET /chats/{chatId}.
    Returns {'answer': str, 'citations': list} or None on failure.
    """
    if not os.environ.get("MITHRA_APP_TOKEN"):
        logger.info("[Mithra] MITHRA_APP_TOKEN not set — skipping KB chat")
        return None
    try:
        base = _mithra_base_url()
        headers = {**_mithra_headers(), "Content-Type": "application/json"}
        async with _mithra_session() as session:
            # Step 1: create chat session
            async with session.post(
                f"{base}/gateway/v1/knowledgeBase/chats",
                json={"initialQuestion": query, "title": "Burnout Consultative Report"},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status not in (200, 201):
                    text = await resp.text()
                    logger.warning("[Mithra] create chat returned %s: %s", resp.status, text[:200])
                    return None
                create_data = await resp.json(content_type=None)

            chat_id = (create_data.get("chat") or {}).get("id")
            if not chat_id:
                logger.warning("[Mithra] create chat response has no chat.id: %s", str(create_data)[:200])
                return None

            logger.info("[Mithra] chat created id=%s, fetching messages", chat_id)

            # Step 2: fetch messages to get the assistant answer
            async with session.get(
                f"{base}/gateway/v1/knowledgeBase/chats/{chat_id}",
                params={"messageLimit": 10},
                headers=_mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning("[Mithra] get chat messages returned %s: %s", resp.status, text[:200])
                    return None
                msg_data = await resp.json(content_type=None)

        messages = msg_data.get("messages") or []
        # Find first assistant message (messages are newest-first per spec)
        assistant_msg = next((m for m in messages if m.get("role") == "assistant"), None)
        if not assistant_msg:
            logger.warning("[Mithra] no assistant message found in chat %s", chat_id)
            return None

        answer = assistant_msg.get("content") or ""

        # sources is the current field; citations is deprecated but kept as fallback
        raw_sources = assistant_msg.get("sources") or assistant_msg.get("citations") or []
        citations = []
        for s in raw_sources:
            pages = s.get("pages") or []
            citations.append({
                "paperId": s.get("paperId", ""),
                "paperTitle": s.get("paperTitle", ""),
                "paperPage": pages[0] if pages else s.get("paperPage", 0),
            })

        logger.info("[Mithra] answer=%d chars citations=%d", len(answer), len(citations))
        return _safe_json({"answer": answer, "citations": citations})

    except Exception as exc:
        logger.warning("[Mithra] KB chat call failed: %s", exc)
        return None


async def _call_report_llm(facts: str, citations: list) -> "str | None":
    """Call the dedicated reporting Azure OpenAI deployment to write a physiometric report.
    Credentials are completely independent of the realtime voice model.
    Returns report text or None if not configured / on error.
    """
    endpoint   = os.environ.get("REPORT_OPENAI_ENDPOINT", "").rstrip("/")
    api_key    = os.environ.get("REPORT_OPENAI_API_KEY", "")
    deployment = os.environ.get("REPORT_OPENAI_DEPLOYMENT", "gpt-4o")

    logger.info("[ReportLLM] config — endpoint=%r  api_key_len=%d  deployment=%r",
                endpoint or "(not set)", len(api_key), deployment)

    if not endpoint:
        logger.warning("[ReportLLM] REPORT_OPENAI_ENDPOINT is empty — skipping LLM stage")
        return None
    if not api_key:
        logger.warning("[ReportLLM] REPORT_OPENAI_API_KEY is empty — skipping LLM stage")
        return None

    citations_text = "\n".join(
        f'- {c.get("paperTitle","?")} (p.{c.get("paperPage",0)})'
        for c in citations
    ) or "(none)"

    system_prompt = (
        "You are a licensed physiometric analyst specialising in workplace burnout and occupational wellbeing. "
        "Using ONLY the evidence-based facts provided below (sourced from the organisation's own knowledge base), "
        "write a concise, professional consultative report.\n\n"
        "Structure the report using EXACTLY these three headings — write nothing before the first heading:\n\n"
        "General Case:\n"
        "Root Cause:\n"
        "Recommendation:\n\n"
        "Style rules:\n"
        "- Write as a physiometric professional — clinical yet empathetic tone\n"
        "- Flowing prose paragraphs, not bullet lists\n"
        "- 2-3 paragraphs per section\n"
        "- Use only information from the facts below — do not add outside knowledge\n\n"
        f"KNOWLEDGE BASE FACTS:\n{facts}\n\n"
        f"SOURCE CITATIONS:\n{citations_text}"
    )

    url = (
        f"{endpoint}/openai/deployments/{deployment}"
        f"/chat/completions?api-version=2024-02-15-preview"
    )
    payload_bytes = json.dumps({
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": "Write the consultative report now."},
        ],
        "max_tokens": 1200,
        "temperature": 0.4,
    }, ensure_ascii=False).encode("utf-8")

    logger.info("[ReportLLM] POST %s  (facts_len=%d)", url, len(facts))
    try:
        async with _mithra_session() as session:
            async with session.post(
                url,
                data=payload_bytes,
                headers={"Content-Type": "application/json", "api-key": api_key},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                logger.info("[ReportLLM] status=%s", resp.status)
                if resp.status != 200:
                    err = await resp.text()
                    logger.error("[ReportLLM] error %s: %s", resp.status, err[:300])
                    return None
                result = await resp.json(content_type=None)
                content = result["choices"][0]["message"]["content"] or ""
                logger.info("[ReportLLM] report generated — %d chars", len(content))
                return content
    except Exception as exc:
        logger.error("[ReportLLM] call failed: %s", exc)
        return None


async def admin_kb_upload(request):
    """Proxy: POST /admin/kb/upload → Mithra POST /gateway/v2/papers/fromFile"""
    try:
        reader = await request.multipart()
        title = ""
        classification_ids = []
        file_data = None
        file_name = "upload"
        file_content_type = "application/octet-stream"

        async for part in reader:
            if part.name == "title":
                title = await part.read(decode=True)
                title = title.decode("utf-8")
            elif part.name == "classificationIds":
                val = await part.read(decode=True)
                classification_ids.append(val.decode("utf-8"))
            elif part.name == "file":
                file_data = await part.read(decode=False)
                file_name = part.filename or "upload"
                file_content_type = part.headers.get("Content-Type", "application/octet-stream")

        if not title or file_data is None:
            return web.json_response({"error": "title and file are required"}, status=400)

        # Build multipart — file MUST be last (Mithra gateway requirement)
        form = aiohttp.FormData()
        form.add_field("title", title)
        for cid in classification_ids:
            form.add_field("classificationIds", cid)
        form.add_field("file", file_data, filename=file_name, content_type=file_content_type)

        async with _mithra_session() as session:
            async with session.post(
                f"{_mithra_base_url()}/gateway/v2/papers/fromFile",
                data=form,
                headers=_mithra_headers(),
            ) as resp:
                if resp.status in (200, 201):
                    raw = await resp.json(content_type=None)
                    # Persist document metadata server-side so any browser can see it
                    from datetime import datetime, timezone
                    docs = _load_kb_docs()
                    docs.append({
                        "paperId":   raw.get("id", ""),
                        "title":     raw.get("title", title),
                        "uploadedAt": datetime.now(timezone.utc).isoformat(),
                    })
                    _save_kb_docs(docs)
                    return web.json_response(raw, status=resp.status)
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_upload", e)


async def admin_kb_delete(request):
    """Proxy: DELETE /admin/kb/documents/{paperId} → Mithra DELETE /gateway/v2/papers/{paperId}"""
    try:
        paper_id = request.match_info["paperId"]
        async with _mithra_session() as session:
            async with session.delete(
                f"{_mithra_base_url()}/gateway/v2/papers/{paper_id}",
                headers=_mithra_headers(),
            ) as resp:
                if resp.status == 204 or resp.ok:
                    # Remove from persisted list on any success response
                    docs = _load_kb_docs()
                    docs = [d for d in docs if d.get("paperId") != paper_id]
                    _save_kb_docs(docs)
                    if resp.status == 204:
                        return web.Response(status=204)
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_delete", e)


async def admin_kb_get_settings(request):
    """Proxy: GET /admin/kb/settings → Mithra GET /gateway/v1/knowledgeBase/settings"""
    try:
        async with _mithra_session() as session:
            async with session.get(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                headers=_mithra_headers(),
            ) as resp:
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_get_settings", e)


async def admin_kb_patch_settings(request):
    """Proxy: PATCH /admin/kb/settings → Mithra PATCH /gateway/v1/knowledgeBase/settings"""
    try:
        data = await request.json()
        min_citations = data.get("minCitationsCount", 1)
        async with _mithra_session() as session:
            async with session.patch(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                json={"minCitationsCount": min_citations},
                headers={**_mithra_headers(), "Content-Type": "application/json"},
            ) as resp:
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_patch_settings", e)


async def admin_kb_search_papers(request):
    """Proxy: POST /admin/kb/papers/search → Mithra POST /gateway/v2/papers/search
    Uses type=enterprise to list all company documents.
    """
    try:
        body = await request.json() if request.content_length else {}
        payload = {
            "type": "enterprise",
            "limit": body.get("limit", 100),
        }
        if body.get("lastId"):
            payload["lastId"] = body["lastId"]
        async with _mithra_session() as session:
            async with session.post(
                f"{_mithra_base_url()}/gateway/v2/papers/search",
                json=payload,
                headers={**_mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json(content_type=None)
                logger.info("[Mithra] papers/search status=%s count=%s", resp.status,
                            len(data.get("papers", [])) if isinstance(data, dict) else "?")
                return web.json_response(data, status=resp.status)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_search_papers", e)


async def kb_create_chat(request):
    """Proxy: POST /kb/chats → Mithra POST /gateway/v1/knowledgeBase/chats
    Body: { initialQuestion: str, title?: str }
    Response: { chat: { id, title, isActive, ... }, answer: str, citations: [] }
    """
    try:
        data = await request.json()
        async with _mithra_session() as session:
            async with session.post(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/chats",
                json=data,
                headers={**_mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                body = await resp.json(content_type=None)
                logger.info("[Mithra] kb_create_chat status=%s keys=%s", resp.status, list(body.keys()) if isinstance(body, dict) else type(body))
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await _mithra_exc_response("kb_create_chat", e)


async def kb_get_chat(request):
    """Proxy: GET /kb/chats/{chatId} → Mithra GET /gateway/v1/knowledgeBase/chats/{chatId}"""
    chat_id = request.match_info["chatId"]
    try:
        limit = request.rel_url.query.get("messageLimit", "50")
        async with _mithra_session() as session:
            async with session.get(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/chats/{chat_id}",
                params={"messageLimit": limit},
                headers=_mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                body = await resp.json(content_type=None)
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await _mithra_exc_response("kb_get_chat", e)


async def kb_send_message(request):
    """Proxy: POST /kb/chats/{chatId}/messages → Mithra POST /gateway/v1/knowledgeBase/chats/{chatId}/messages
    Body: { questionText: str }
    Response: { answer: str, citations: [] }
    """
    chat_id = request.match_info["chatId"]
    try:
        data = await request.json()
        async with _mithra_session() as session:
            async with session.post(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/chats/{chat_id}/messages",
                json=data,
                headers={**_mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                body = await resp.json(content_type=None)
                logger.info("[Mithra] kb_send_message chatId=%s status=%s", chat_id, resp.status)
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await _mithra_exc_response("kb_send_message", e)


async def report_llm_debug(request):
    """GET /admin/report-llm/debug — show what the backend reads for the reporting LLM config."""
    ep  = os.environ.get("REPORT_OPENAI_ENDPOINT", "")
    key = os.environ.get("REPORT_OPENAI_API_KEY", "")
    dep = os.environ.get("REPORT_OPENAI_DEPLOYMENT", "")
    return web.json_response({
        "REPORT_OPENAI_ENDPOINT":   ep or "(not set)",
        "REPORT_OPENAI_API_KEY":    (key[:6] + "…" + key[-4:]) if len(key) > 10 else ("(not set)" if not key else "(set but short)"),
        "REPORT_OPENAI_API_KEY_len": len(key),
        "REPORT_OPENAI_DEPLOYMENT": dep or "(not set — will use default gpt-4o)",
        "ready": bool(ep and key),
    })


async def admin_kb_debug(request):
    """Diagnostics: checks token config + outbound connectivity to Mithra.
    Returns a JSON report — never crashes, always explains what is wrong.
    """
    import traceback

    token_raw = os.environ.get("MITHRA_APP_TOKEN", "")
    base_url = _mithra_base_url()

    result = {
        "token_configured": bool(token_raw),
        "token_preview": (token_raw[:8] + "…") if token_raw else "(empty — MITHRA_APP_TOKEN not set)",
        "mithra_base_url": base_url,
        "connectivity": None,
        "connectivity_error": None,
        "settings_status": None,
        "settings_body": None,
        "settings_error": None,
    }

    # 1. Basic connectivity probe (HEAD to base URL)
    try:
        async with _mithra_session() as session:
            async with session.head(base_url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                result["connectivity"] = resp.status
    except Exception:
        result["connectivity_error"] = traceback.format_exc()

    # 2. Try the actual settings endpoint
    try:
        async with _mithra_session() as session:
            async with session.get(
                f"{base_url}/gateway/v1/knowledgeBase/settings",
                headers=_mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                result["settings_status"] = resp.status
                result["settings_body"] = await resp.text()
    except Exception:
        result["settings_error"] = traceback.format_exc()

    return web.json_response(result)


async def get_session(request, rtmt: RTMiddleTier):
    """Return persisted session state so the frontend can restore UI on reconnect."""
    session_id = request.rel_url.query.get("session_id", "")
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)
    sess = rtmt.get_or_create_session(session_id)
    return web.json_response({
        "session_id": session_id,
        "conversation_state": sess.conversation_state,
        "survey_results": sess.survey_results,
        "stress_state": sess.stress_state,
        "connection_count": sess.connection_count,
        "has_report": sess.report_context is not None,
    })


async def update_stress_state(request, rtmt: RTMiddleTier):
    """Update the stress state for adaptive communication"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        stress_state = data.get("stress_state", "normal")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        valid_states = ["stressed", "relaxed", "normal"]
        if stress_state not in valid_states:
            return web.json_response({"error": f"Invalid stress state. Must be one of: {valid_states}"}, status=400)
        rtmt.set_stress_state_for_session(session_id, stress_state)
        return web.json_response({"success": True, "stress_state": stress_state})
    except Exception as e:
        logger.error(f"Error updating stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def create_app():
    if not os.environ.get("RUNNING_IN_PRODUCTION"):
        logger.info("Running in development mode, loading from .env file")
        load_dotenv()

    await init_db()

    llm_key = os.environ.get("AZURE_OPENAI_API_KEY")

    credential = None
    if not llm_key:
        if tenant_id := os.environ.get("AZURE_TENANT_ID"):
            logger.info(
                "Using AzureDeveloperCliCredential with tenant_id %s", tenant_id
            )
            credential = AzureDeveloperCliCredential(
                tenant_id=tenant_id, process_timeout=60
            )
        else:
            logger.info("Using DefaultAzureCredential")
            credential = DefaultAzureCredential()
    llm_credential = AzureKeyCredential(llm_key) if llm_key else credential

    app = web.Application(middlewares=[auth_middleware])

    # Create RTMiddleTier instance first
    rtmt = RTMiddleTier(
        credentials=llm_credential,
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        deployment=os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"],
        voice_choice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE_CHOICE") or "alloy",
    )

    # Enable sentiment analysis based on environment variable
    enable_sentiment = (
        os.environ.get("ENABLE_SENTIMENT_ANALYSIS", "false").lower() == "true"
    )
    if enable_sentiment:
        rtmt.enable_sentiment()
        logger.info("Sentiment analysis is enabled")

    # Enable survey mode based on environment variable
    enable_survey = os.environ.get("ENABLE_SURVEY_MODE", "false").lower() == "true"
    if enable_survey:
        from survey_loader import load_survey, SURVEY_MAP
        override = os.environ.get("OVERRIDE_SURVEY_TYPE", "false").lower() == "true"
        survey_type_env = os.environ.get("SURVEY_TYPE", "TEST").upper()
        if survey_type_env not in SURVEY_MAP:
            logger.warning("Unknown SURVEY_TYPE=%s, defaulting to TEST", survey_type_env)
            survey_type_env = "TEST"
        rtmt.survey_type_overridden = override
        rtmt.active_survey_type = survey_type_env
        survey_config = load_survey(survey_type_env)
        rtmt.enable_survey(survey_config)
        logger.info("Survey mode is enabled (type=%s, overridden=%s)", survey_type_env, override)

    # Set system message - burnout specialist when survey mode is enabled
    if enable_survey:
        # Configure meta intent layer with APP.md content
        rtmt.meta_intent_config = {
            "app_overview": "CIQ is a web application designed to support individuals in identifying and understanding personal burnout. The application evaluates burnout levels using established and validated methodologies, currently leveraging the BAT (Burnout Assessment Tool) survey. It provides both detailed technical results and a comprehensive report with actionable insights.\n\nA key feature of CIQ is its interactive, speech-enabled interface, allowing users to engage naturally with minimal reliance on manual inputs. In addition to survey-based evaluation, the application can optionally capture user biometrics through the device camera. This includes facial movements and expressions, which are processed using application logic and machine learning techniques.\n\nBiometric data is used to enhance technical insights but is not included in the comprehensive report. The report itself is generated using a combination of generative AI and a carefully curated, domain-specific knowledge base focused on burnout research.\n\nCIQ is not a medical device or a clinical diagnostic tool. It is intended solely to help users gain awareness of their burnout levels and behavioral patterns.",
            "capabilities": "Speech-enabled survey interaction and evaluation; generation of detailed technical burnout analysis; ability to explain results interactively; creation of comprehensive reports using curated domain knowledge and generative AI; optional capture and analysis of facial biometrics; detection of voice-based emotional signals and adaptive system responses.",
            "limitations": "Generative AI is used selectively and only where necessary. Speech functionality is supported by AI-based models. Final report generation combines generative AI with a curated, domain-specific knowledge base. This application does not provide medical advice and is not a substitute for professional healthcare consultation.",
            "privacy": "This early version of the application does not store biometric data, survey responses, location data, or personally identifiable information in persistent databases. Camera feeds, survey inputs, and derived biometrics are processed temporarily in memory or short-lived files and are not retained.",
            "biometrics_note": "The application can capture and analyze selected biometric indicators, including pupil size and eye blink rate. Additional derived metrics may include head posture, eye openness, and stress indicators inferred from blink patterns.",
            "disclaimer": "This product is designed as a general wellness and performance-reflection tool. It provides cognitive feedback, stress-awareness cues, and behavioral pattern insights. It does not diagnose, treat, prevent, or prescribe for any medical or mental health condition and should not replace professional healthcare advice."
}

        rtmt.system_message = """
            You are a burnout prevention specialist and workplace wellbeing coach. Your role is to have friendly, supportive conversations with users about their work wellbeing. After a few conversational exchanges, proactively propose a short burnout assessment to help them reflect on how they're feeling. Be empathetic, warm, and professional.
        """.strip()
    else:
        # Configure meta intent layer with APP.md content (basic/help mode)
        rtmt.meta_intent_config = {
            "app_overview": "CIQ is a web application designed to support individuals in identifying and understanding personal burnout. The application evaluates burnout levels using established and validated methodologies, currently leveraging the BAT (Burnout Assessment Tool) survey. It provides both detailed technical results and a comprehensive report with actionable insights.\n\nA key feature of CIQ is its interactive, speech-enabled interface, allowing users to engage naturally with minimal reliance on manual inputs. In addition to survey-based evaluation, the application can optionally capture user biometrics through the device camera. This includes facial movements and expressions, which are processed using application logic and machine learning techniques.\n\nBiometric data is used to enhance technical insights but is not included in the comprehensive report. The report itself is generated using a combination of generative AI and a carefully curated, domain-specific knowledge base focused on burnout research.\n\nCIQ is not a medical device or a clinical diagnostic tool. It is intended solely to help users gain awareness of their burnout levels and behavioral patterns.",
            "capabilities": "Speech-enabled survey interaction and evaluation; generation of detailed technical burnout analysis; ability to explain results interactively; creation of comprehensive reports using curated domain knowledge and generative AI; optional capture and analysis of facial biometrics; detection of voice-based emotional signals and adaptive system responses.",
            "limitations": "Generative AI is used selectively and only where necessary. Speech functionality is supported by AI-based models. Final report generation combines generative AI with a curated, domain-specific knowledge base. This application does not provide medical advice and is not a substitute for professional healthcare consultation.",
            "privacy": "This early version of the application does not store biometric data, survey responses, location data, or personally identifiable information in persistent databases. Camera feeds, survey inputs, and derived biometrics are processed temporarily in memory or short-lived files and are not retained.",
            "biometrics_note": "The application can capture and analyze selected biometric indicators, including pupil size and eye blink rate. Additional derived metrics may include head posture, eye openness, and stress indicators inferred from blink patterns.",
            "disclaimer": "This product is designed as a general wellness and performance-reflection tool. It provides cognitive feedback, stress-awareness cues, and behavioral pattern insights. It does not diagnose, treat, prevent, or prescribe for any medical or mental health condition and should not replace professional healthcare advice."
        }

        rtmt.system_message = """
            You are a helpful voice assistant. Provide clear, concise answers to the user's questions.
            Keep responses short since the user is listening to audio.
        """.strip()

    # Biometric guardrail: descriptive-only mode for biometric signals. Default
    # baseline from env; can be toggled at runtime from the Admin tab.
    rtmt.biometric_guardrail_enabled = (
        os.environ.get("ENABLE_BIOMETRIC_GUARDRAIL", "true").lower() == "true"
    )
    logger.info("Biometric guardrail default: %s", rtmt.biometric_guardrail_enabled)

    # Store rtmt in app for access by request handlers
    app["rtmt"] = rtmt

    app.router.add_post("/login", login)
    app.router.add_post("/logout", logout)
    app.router.add_get("/me", me)
    app.router.add_post("/biometrics", lambda request: update_biometrics(request, rtmt))
    app.router.add_post("/analyze-report", analyze_report)
    app.router.add_post("/analyze", lambda request: analyze_face(request, rtmt))
    app.router.add_post("/analyze-stress", analyze_stress)
    app.router.add_get("/config", get_config)
    app.router.add_post("/survey-type", set_survey_type)
    app.router.add_post("/admin/biometric-guardrail", set_biometric_guardrail)
    app.router.add_post("/clear-conversation", lambda request: clear_conversation_state(request, rtmt))
    app.router.add_post("/update-stress", lambda request: update_stress_state(request, rtmt))
    app.router.add_get("/session", lambda request: get_session(request, rtmt))

    # Mithra Knowledge Base admin proxy routes
    app.router.add_post("/ssot-report", generate_ssot_report)

    # Mithra Knowledge Base admin proxy routes
    app.router.add_get("/api/history", user_sessions_history)
    app.router.add_get("/admin/users", admin_list_users)
    app.router.add_get("/admin/kb/documents", admin_kb_list_documents)
    app.router.add_post("/admin/kb/upload", admin_kb_upload)
    app.router.add_delete("/admin/kb/documents/{paperId}", admin_kb_delete)
    app.router.add_get("/admin/kb/settings", admin_kb_get_settings)
    app.router.add_patch("/admin/kb/settings", admin_kb_patch_settings)
    app.router.add_get("/admin/kb/debug", admin_kb_debug)
    app.router.add_get("/admin/report-llm/debug", report_llm_debug)
    app.router.add_post("/admin/kb/papers/search", admin_kb_search_papers)
    app.router.add_post("/kb/chats", kb_create_chat)
    app.router.add_get("/kb/chats/{chatId}", kb_get_chat)
    app.router.add_post("/kb/chats/{chatId}/messages", kb_send_message)
    app.router.add_get("/version", get_version)

    # RAG tools disabled - kept for future extensibility
    # attach_rag_tools(rtmt,
    #     credentials=search_credential,
    #     search_endpoint=os.environ.get("AZURE_SEARCH_ENDPOINT"),
    #     search_index=os.environ.get("AZURE_SEARCH_INDEX"),
    #     semantic_configuration=os.environ.get("AZURE_SEARCH_SEMANTIC_CONFIGURATION") or None,
    #     identifier_field=os.environ.get("AZURE_SEARCH_IDENTIFIER_FIELD") or "chunk_id",
    #     content_field=os.environ.get("AZURE_SEARCH_CONTENT_FIELD") or "chunk",
    #     embedding_field=os.environ.get("AZURE_SEARCH_EMBEDDING_FIELD") or "text_vector",
    #     title_field=os.environ.get("AZURE_SEARCH_TITLE_FIELD") or "title",
    #     use_vector_query=(os.getenv("AZURE_SEARCH_USE_VECTOR_QUERY", "true") == "true")
    # )

    rtmt.attach_to_app(app, "/realtime")

    current_directory = Path(__file__).parent
    app.add_routes(
        [
            web.get(
                "/", lambda _: web.FileResponse(current_directory / "static/index.html")
            )
        ]
    )
    app.router.add_static("/", path=current_directory / "static", name="static")

    # Log every registered route so we can verify deployment in container log stream
    logger.info("=== REGISTERED ROUTES ===")
    for resource in app.router.resources():
        logger.info("  %s", resource)
    logger.info("=========================")

    return app


if __name__ == "__main__":
    host = "localhost"
    port = 8765
    web.run_app(create_app(), host=host, port=port)
