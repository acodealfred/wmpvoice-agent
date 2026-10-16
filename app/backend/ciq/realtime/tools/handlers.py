"""Server-side tool implementations for the realtime middle tier.

Decoupled from ``RTMiddleTier``: each handler takes the active ``SessionState`` and
the shared survey config explicitly (resolved at call time from the session context
var by the registry), so they can be unit-tested in isolation.
"""
import json
import logging
from typing import Any

from ciq.assessments.service import persist_answer, run_is_active
from ciq.realtime.behaviour_capture import start_behaviour_capture
from ciq.realtime.session import SessionState
from ciq.realtime.spoken_report import build_pilot_spoken_report
from ciq.realtime.timeline_capture import (
    _next_expected_question,
    retag_pending_frames,
    schedule_stop_timeline_capture,
)
from ciq.realtime.tools.base import ToolResult, ToolResultDirection
from ciq.realtime.transcripts import assign_items_to_question, user_response_for
from ciq.survey import get_question_domain
from ciq.voice.live import finalize_answer_features
from survey_loader import (
    blink_band,
    compute_section_scores,
    effective_score,
    get_score_bounds,
    option_label,
)

logger = logging.getLogger("voicerag")


async def query_survey_tool(sess: SessionState, survey_config: dict, args: Any) -> ToolResult:
    """Tool to query survey results and provide insights.

    Must be async: the tool dispatcher awaits every tool target.
    """
    query_type = args.get("query_type", "summary")
    domain = args.get("domain")

    results = sess.survey_results
    if not results:
        # TO_SERVER so the agent actually sees this message and can tell the user.
        return ToolResult(
            json.dumps({"error": "No survey results available. Complete the survey first."}),
            ToolResultDirection.TO_SERVER,
        )
    cfg = survey_config

    def _eff(qid, raw):
        return effective_score(cfg, qid, raw)

    thresholds = cfg.get("thresholds", {"low_max": 12, "moderate_max": 22})
    interp_map = cfg.get("interpretation", {})

    def _risk(total):
        if total <= thresholds.get("low_max", 12):
            return "low", interp_map.get("low", "Low burnout risk")
        if total <= thresholds.get("moderate_max", 22):
            return "moderate", interp_map.get("moderate", "Moderate burnout risk")
        return "high", interp_map.get("high", "High burnout risk")

    # All totals are reverse-aware: positive items (reverse=true) are flipped so the
    # score reflects burnout direction.
    total_score = sum(_eff(qid, r["score"]) for qid, r in results.items())
    num_questions = len(results)

    response_data = {"query_type": query_type, "has_data": True}

    # Surveys with independent scoringSections (e.g. PILOT's BAT-4 / CBI-WRB3) have no
    # single combined score/threshold — computed via the same canonical helper the
    # report endpoints use, so the live agent can never diverge from the written report.
    section_snapshots = [{"questionId": qid, "score": r["score"]} for qid, r in results.items()]
    sections = compute_section_scores(cfg, section_snapshots) if cfg.get("scoringSections") else None

    if query_type == "burnout_score":
        if sections is not None:
            response_data["sections"] = [
                {
                    "label": s["label"],
                    "score": s["score"],
                    "score_range": s["scoreRange"],
                    "risk_level": s["riskLevel"],
                    "interpretation": s["interpretation"],
                }
                for s in sections
            ]
        else:
            level, interpretation = _risk(total_score)
            response_data["total_score"] = total_score
            response_data["max_score"] = num_questions * 5
            response_data["risk_level"] = level
            response_data["interpretation"] = interpretation

        # PILOT only: a dynamic, biometric-aware brief for the agent to voice (the written
        # report is unaffected). Held on the session so post-report Q&A knows what was said.
        spoken = build_pilot_spoken_report(cfg, results)
        if spoken:
            response_data["spoken_report"] = {"framing": spoken["framing"], "parts": spoken["parts"]}
            sess.spoken_report_text = spoken["plain_text"]

    elif query_type == "contributing_domains":
        domain_scores = {}
        for qid, result in results.items():
            dom = get_question_domain(qid, survey_config)
            domain_scores[dom] = domain_scores.get(dom, 0) + _eff(qid, result["score"])
        response_data["domains"] = domain_scores
        if domain_scores:
            highest = max(domain_scores, key=domain_scores.get)
            response_data["highest_contributor"] = highest
            response_data["highest_score"] = domain_scores[highest]

    elif query_type == "stress_questions":
        # High-burnout questions = effective score in the top 25% of that question's
        # own native range — scale-relative so this works whether the question is on
        # a 1-5 scale (BAT-4) or a 0-100 scale (CBI-WRB3). Equivalent to today's plain
        # ">= 4" for a 1-5 question: (4-1)/(5-1) = 0.75.
        def _is_high(qid, raw):
            eff = _eff(qid, raw)
            lo, hi = get_score_bounds(cfg, qid)
            return hi > lo and (eff - lo) / (hi - lo) >= 0.75

        high_stress = [
            {"question_id": qid, "score": _eff(qid, r["score"]), "domain": get_question_domain(qid, survey_config)}
            for qid, r in results.items()
            if _is_high(qid, r["score"])
        ]
        response_data["high_stress_questions"] = high_stress
        response_data["count"] = len(high_stress)

    elif query_type == "domain_scores":
        if domain:
            domain_total = sum(
                _eff(qid, r["score"]) for qid, r in results.items()
                if get_question_domain(qid, survey_config) == domain
            )
            response_data["domain"] = domain
            response_data["domain_score"] = domain_total
        else:
            domain_scores = {}
            for qid, result in results.items():
                dom = get_question_domain(qid, survey_config)
                domain_scores[dom] = domain_scores.get(dom, 0) + _eff(qid, result["score"])
            response_data["domain_scores"] = domain_scores

    elif query_type == "summary":
        if sections is not None:
            response_data["summary"] = {
                "questions_answered": num_questions,
                "sections": [
                    {
                        "label": s["label"],
                        "score": s["score"],
                        "score_range": s["scoreRange"],
                        "risk_level": s["riskLevel"],
                        "interpretation": s["interpretation"],
                    }
                    for s in sections
                ],
            }
        else:
            level, interpretation = _risk(total_score)
            response_data["summary"] = {
                "total_score": total_score,
                "questions_answered": num_questions,
                "average_score": total_score / num_questions if num_questions else 0,
                "risk_level": level,
                "interpretation": interpretation,
            }

        # Biometric readings as CATEGORIES so the agent can state them when asked.
        # State only — no clinical interpretation or link to burnout.
        # Questions with no blink reading are left out (not averaged in as a fake 0%);
        # no readings at all -> None -> "Unknown" (not enough data), never "Normal".
        blink_changes = [r["blink_rate_change_percent"] for r in results.values() if r.get("blink_rate_change_percent") is not None]
        avg_blink = sum(blink_changes) / len(blink_changes) if blink_changes else None
        # Each eye's dominant position is voted independently — the two eyes can
        # disagree (e.g. one partially occluded), so collapsing them into one count
        # would hide that rather than surface it.
        left_gaze_counts: dict = {}
        right_gaze_counts: dict = {}
        for r in results.values():
            lg = r.get("left_gaze_position") or "Center"
            rg = r.get("right_gaze_position") or "Center"
            left_gaze_counts[lg] = left_gaze_counts.get(lg, 0) + 1
            right_gaze_counts[rg] = right_gaze_counts.get(rg, 0) + 1
        dominant_left_gaze = max(left_gaze_counts, key=left_gaze_counts.get) if left_gaze_counts else "Center"
        dominant_right_gaze = max(right_gaze_counts, key=right_gaze_counts.get) if right_gaze_counts else "Center"
        response_data["biometrics"] = {
            "overall_blink_rate_category": blink_band(avg_blink),
            "dominant_left_gaze_position": dominant_left_gaze,
            "dominant_right_gaze_position": dominant_right_gaze,
            "per_question": [
                {
                    "question_id": qid,
                    "domain": get_question_domain(qid, survey_config),
                    "voice_sentiment": r.get("voice_sentiment"),
                    "blink_rate_category": blink_band(r.get("blink_rate_change_percent")),
                    "left_gaze_position": r.get("left_gaze_position"),
                    "right_gaze_position": r.get("right_gaze_position"),
                }
                for qid, r in results.items()
            ],
        }

    # CRITICAL: must be TO_SERVER so the agent receives the data and can answer
    # the user's question.
    return ToolResult(
        json.dumps(response_data),
        ToolResultDirection.TO_SERVER,
    )


def pilot_survey_just_completed(sess: SessionState) -> bool:
    """PILOT with every question answered — the agent then stays silent until the
    progress screen's `survey_complete` cue asks for the closing line."""
    config = sess.survey_config or {}
    total = len(config.get("questions", []))
    return config.get("type") == "PILOT" and total > 0 and len(sess.survey_results) >= total


async def sentiment_tool(args: Any) -> ToolResult:
    sentiment = args.get("sentiment", "neutral")
    reason = args.get("reason", "")
    return ToolResult(
        json.dumps({"sentiment": sentiment, "reason": reason}),
        ToolResultDirection.TO_CLIENT,
    )


def _reject_answer(question_id, reason: str, message: str, **extra) -> ToolResult:
    """A refused record_survey_response. Sent TO_SERVER so the MODEL reads why (an
    empty output let it believe a refused answer was saved — e.g. one filed under an
    already-answered id after a Pause/Continue was silently lost, so the survey never
    reached its total and no report started). Nothing is recorded or sent to the browser."""
    logger.warning("[RTMT] Rejected record_survey_response for %s: %s", question_id, reason)
    return ToolResult(
        json.dumps({"question_id": question_id, "recorded": False, "reason": reason, "message": message, **extra}),
        ToolResultDirection.TO_SERVER,
    )


def _current_question_hint(sess: SessionState) -> str:
    nxt = _next_expected_question(sess)
    if nxt is None:
        return "Every question has already been answered."
    q, _ = nxt
    return f"The current question is '{q.get('prompt', q.get('text', ''))}' (id {q['id']})."


async def survey_tool(sess: SessionState, survey_config: dict, args: Any) -> ToolResult:
    question_id = args.get("question_id")
    score = args.get("score")
    # The model's own paraphrase — only a fallback; see ciq.realtime.transcripts.
    model_response = args.get("user_verbal_response", "")

    # ── Guards: an answer is only recorded against the question actually being asked ──
    # Nothing below them runs for a refused call, so survey_results, the pending-answer
    # window, the blink window and the user's reply items all stay for the correct call.
    question_ids = [q.get("id") for q in survey_config.get("questions", [])]
    if question_id not in question_ids:
        return _reject_answer(
            question_id, "unknown_question",
            f"Unknown question id {question_id!r}. Valid ids: {', '.join(map(str, question_ids))}. "
            + _current_question_hint(sess),
        )
    if not await run_is_active(sess):
        return _reject_answer(
            question_id, "assessment_paused",
            "The assessment is paused — do not record answers now. Wait until it is continued.",
        )
    # Idempotency guard: a misfired repeat must not pollute the report or the counter.
    if question_id in sess.survey_results:
        return _reject_answer(
            question_id, "duplicate",
            f"{question_id} is already recorded — do not call again for it. " + _current_question_hint(sess),
            duplicate=True,
        )
    # Scored surveys are scripted strictly in order, so the only question that can be
    # answered is the next unanswered one — after a Pause/Continue the model's own count
    # can be off by one, filing an answer under a question that was never asked.
    # Qualitative surveys (READINESS) may cover their topics in any order.
    nxt = _next_expected_question(sess)
    if not survey_config.get("qualitative") and nxt is not None and nxt[0].get("id") != question_id:
        return _reject_answer(
            question_id, "out_of_order",
            _current_question_hint(sess)
            + f" If you asked it and the user answered, record that answer under id {nxt[0]['id']};"
            " if you have not asked it yet, ask it now.",
            expected_question_id=nxt[0]["id"],
        )

    voice_sentiment = args.get("voice_sentiment") or sess.current_sentiment

    # Always the measured value: blinks over this question's own window, falling back
    # to the recent rolling average when the window is too short. (A model-supplied
    # blink_rate_change_percent used to take precedence here — the model has no access
    # to the camera, so any value it sent was invented.)
    question_blink = sess.take_question_blink_change()
    blink_rate_change_percent = (
        question_blink
        if question_blink is not None
        else sess.average_blink_rate_change()
    )

    left_gaze_position = sess.current_left_gaze_position
    right_gaze_position = sess.current_right_gaze_position
    pupil_mm_change = sess.current_pupil_mm_change

    # Voice response latency captured between the agent finishing the question
    # and the user starting to speak.
    response_latency_ms = sess.current_response_latency_ms
    sess.current_response_latency_ms = None

    logger.info(
        f"[RTMT] ★ Survey Tool Debug - question_id={question_id}, "
        f"question_window_blink={question_blink}, blink_used={blink_rate_change_percent}%, "
        f"left_gaze_position={left_gaze_position}, right_gaze_position={right_gaze_position}"
    )
    logger.info(f"[RTMT] ★ Blink History: {sess.blink_rate_history[-10:]}")

    # Every user reply since this question was asked is its answer. A scored answer
    # stores its option label; an open-ended one uses the Whisper transcript (now if
    # already back, else when it lands).
    assign_items_to_question(sess, question_id)
    user_response = user_response_for(
        sess, question_id, model_response, option_label(survey_config, question_id, score),
    )

    sess.survey_results[question_id] = {
        "score": score,
        "user_response": user_response,
        "voice_sentiment": voice_sentiment,
        "blink_rate_change_percent": blink_rate_change_percent,
        "pupil_mm_change": pupil_mm_change,
        "left_gaze_position": left_gaze_position,
        "right_gaze_position": right_gaze_position,
        "response_latency_ms": response_latency_ms,
    }

    # Close out (or correct) the timeline log's "pending answer" window opened
    # by timeline_capture.resolve_agent_turn when this question was asked. If
    # the scored question_id doesn't match what transcript-matching predicted
    # (e.g. out-of-order scoring), retag the frames already tied to the stale
    # prediction rather than silently mislabeling them.
    if sess.pending_answer_question_id is not None and sess.pending_answer_question_id != question_id:
        retag_pending_frames(sess, question_id, None)
    sess.pending_answer_question_id = None
    sess.pending_answer_question_index = None

    domain = get_question_domain(question_id, survey_config)
    # Qualitative surveys (e.g. READINESS) record no numeric score, so this is a
    # best-effort live progress total only — the real result comes from the report LLM.
    total_score = sum(r.get("score") or 0 for r in sess.survey_results.values())
    completed = len(sess.survey_results)
    total = len(survey_config.get("questions", []))

    if completed == total:
        # Survey done — keep the per-second timeline sampler running a bit
        # longer (see _POST_SURVEY_GRACE_S) instead of cutting it off instantly,
        # so closing remarks / the start of report delivery still get logged.
        schedule_stop_timeline_capture(sess)

    # PILOT-only: the last question just closed out the survey — start the
    # post-survey 10s behaviour capture window (mirrors the "pre" one started
    # in RTMiddleTier.unlock_survey_for_session).
    if completed == total and survey_config.get("type") == "PILOT":
        start_behaviour_capture(sess, "post")

    logger.info(
        f"Survey response recorded: {question_id} = {score}, sentiment={voice_sentiment}, "
        f"blink_change={blink_rate_change_percent}%, gaze_left={left_gaze_position}, gaze_right={right_gaze_position}"
    )

    snapshot = {
        "questionId": question_id,
        "domain": domain,
        "score": score,
        "userResponse": user_response,
        "voiceSentiment": voice_sentiment,
        "blinkRateChange": blink_rate_change_percent,
        "pupilMmChange": pupil_mm_change,
        "leftGazePosition": left_gaze_position,
        "rightGazePosition": right_gaze_position,
        "responseLatencyMs": response_latency_ms,
    }
    # Persist now (not only at report time) so a paused / dropped run can be
    # continued where the user left off. No-op when no run is bound. The voice
    # summary (ciq.voice) is stored with the answer but not sent to the browser.
    voice_features = await finalize_answer_features(sess)
    await persist_answer(sess, survey_config, {**snapshot, "voiceFeatures": voice_features}, status_checked=True)

    client_message = {
        "type": "survey.biometric.update",
        "snapshot": snapshot,
        "totalScore": total_score,
        "completed": completed,
        "total": total,
    }

    return ToolResult(
        json.dumps(
            {
                "question_id": question_id,
                "score": score,
                "recorded": True,
                "client_message": client_message,
            }
        ),
        ToolResultDirection.TO_CLIENT,
    )
