"""Server-side tool implementations for the realtime middle tier.

Decoupled from ``RTMiddleTier``: each handler takes the active ``SessionState`` and
the shared survey config explicitly (resolved at call time from the session context
var by the registry), so they can be unit-tested in isolation.
"""
import json
import logging
from typing import Any

from ciq.realtime.behaviour_capture import start_behaviour_capture
from ciq.realtime.session import SessionState
from ciq.realtime.tools.base import ToolResult, ToolResultDirection
from ciq.survey import get_question_domain
from survey_loader import (
    blink_band,
    compute_section_scores,
    effective_score,
    get_score_bounds,
    pupil_band,
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
        blink_changes = [r.get("blink_rate_change_percent") or 0 for r in results.values()]
        avg_blink = sum(blink_changes) / len(blink_changes) if blink_changes else 0
        pupil_changes = [r.get("pupil_mm_change") or 0 for r in results.values()]
        avg_pupil = sum(pupil_changes) / len(pupil_changes) if pupil_changes else 0
        gaze_counts: dict = {}
        for r in results.values():
            g = r.get("gaze_position") or "Center"
            gaze_counts[g] = gaze_counts.get(g, 0) + 1
        dominant_gaze = max(gaze_counts, key=gaze_counts.get) if gaze_counts else "Center"
        response_data["biometrics"] = {
            "overall_blink_rate_category": blink_band(avg_blink),
            "overall_pupil_dilation_category": pupil_band(avg_pupil),
            "dominant_gaze_position": dominant_gaze,
            "per_question": [
                {
                    "question_id": qid,
                    "domain": get_question_domain(qid, survey_config),
                    "voice_sentiment": r.get("voice_sentiment"),
                    "blink_rate_category": blink_band(r.get("blink_rate_change_percent")),
                    "pupil_dilation_category": pupil_band(r.get("pupil_mm_change")),
                    "gaze_position": r.get("gaze_position"),
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


async def sentiment_tool(args: Any) -> ToolResult:
    sentiment = args.get("sentiment", "neutral")
    reason = args.get("reason", "")
    return ToolResult(
        json.dumps({"sentiment": sentiment, "reason": reason}),
        ToolResultDirection.TO_CLIENT,
    )


async def survey_tool(sess: SessionState, survey_config: dict, args: Any) -> ToolResult:
    question_id = args.get("question_id")
    score = args.get("score")
    user_response = args.get("user_verbal_response", "")

    # Idempotency guard: reject duplicate recordings for the same question so a
    # misfired tool call cannot pollute the report or confuse the progress counter.
    if question_id in sess.survey_results:
        logger.warning("[RTMT] Duplicate record_survey_response for %s — ignoring", question_id)
        return ToolResult(
            json.dumps({"question_id": question_id, "duplicate": True, "recorded": False,
                        "message": "Already recorded — do not call again for this question."}),
            ToolResultDirection.TO_CLIENT,
        )

    voice_sentiment = args.get("voice_sentiment") or sess.current_sentiment

    # Use aggregated values from history for accurate per-question biometrics
    provided_blink = args.get("blink_rate_change_percent")
    blink_rate_change_percent = (
        provided_blink
        if provided_blink is not None
        else sess.average_blink_rate_change()
    )

    gaze_position = sess.current_gaze_position
    pupil_mm_change = sess.current_pupil_mm_change

    # Voice response latency captured between the agent finishing the question
    # and the user starting to speak.
    response_latency_ms = sess.current_response_latency_ms
    sess.current_response_latency_ms = None

    logger.info(
        f"[RTMT] ★ Survey Tool Debug - question_id={question_id}, "
        f"provided_blink={provided_blink}, calculated_blink={blink_rate_change_percent}%, "
        f"gaze_position={gaze_position}"
    )
    logger.info(f"[RTMT] ★ Blink History: {sess.blink_rate_history[-10:]}")

    sess.survey_results[question_id] = {
        "score": score,
        "user_response": user_response,
        "voice_sentiment": voice_sentiment,
        "blink_rate_change_percent": blink_rate_change_percent,
        "pupil_mm_change": pupil_mm_change,
        "gaze_position": gaze_position,
        "response_latency_ms": response_latency_ms,
    }

    domain = get_question_domain(question_id, survey_config)
    total_score = sum(r["score"] for r in sess.survey_results.values())
    completed = len(sess.survey_results)
    total = len(survey_config.get("questions", []))

    # PILOT-only: the last question just closed out the survey — start the
    # post-survey 10s behaviour capture window (mirrors the "pre" one started
    # in RTMiddleTier.unlock_survey_for_session).
    if completed == total and survey_config.get("type") == "PILOT":
        start_behaviour_capture(sess, "post")

    logger.info(
        f"Survey response recorded: {question_id} = {score}, sentiment={voice_sentiment}, blink_change={blink_rate_change_percent}%, gaze={gaze_position}"
    )

    client_message = {
        "type": "survey.biometric.update",
        "snapshot": {
            "questionId": question_id,
            "domain": domain,
            "score": score,
            "voiceSentiment": voice_sentiment,
            "blinkRateChange": blink_rate_change_percent,
            "pupilMmChange": pupil_mm_change,
            "gazePosition": gaze_position,
            "responseLatencyMs": response_latency_ms,
        },
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
