"""Server-side tool implementations for the voice-driven Recovery Window flow.

Mirrors ciq.realtime.tools.handlers.survey_tool's shape (async handler, takes the
active SessionState + args explicitly, idempotency-guarded). All actual
recommendation/persistence logic is shared with the REST fallback via
ciq.recovery.service — these handlers are thin adapters between the realtime
tool-call contract and that shared service. Each handler that needs to notify
the frontend embeds a "client_message" dict in its JSON result; middle_tier.py
forwards that generically for every recovery tool name (see the RECOVERY_TOOL_NAMES
block in _process_message_to_client).
"""
import json
import logging
from typing import Any

from ciq.realtime.session import SessionState
from ciq.realtime.tools.base import ToolResult, ToolResultDirection
from ciq.recovery.intake_questions import INTAKE_QUESTION_IDS
from ciq.recovery.service import (
    ReportNotReadyError,
    compute_and_persist_final_recommendation,
    persist_intake_answers,
)
from ciq.recovery.track_scripts import get_track_script

logger = logging.getLogger("voicerag")

_SAFETY_QUESTION_ID = "safety"
_GENERIC_QUESTION_IDS = [q for q in INTAKE_QUESTION_IDS if q != _SAFETY_QUESTION_ID]


async def recovery_intake_answer_tool(sess: SessionState, args: Any) -> ToolResult:
    question_id = args.get("question_id")
    answer_value = args.get("answer_value")

    if question_id == _SAFETY_QUESTION_ID:
        return ToolResult(
            json.dumps({
                "recorded": False,
                "error": "Use record_recovery_safety_answer for the safety question, not this tool.",
            }),
            ToolResultDirection.TO_CLIENT,
        )
    if question_id not in _GENERIC_QUESTION_IDS:
        return ToolResult(
            json.dumps({"recorded": False, "error": f"Unknown question_id: {question_id}"}),
            ToolResultDirection.TO_CLIENT,
        )

    # Idempotency guard, same style as survey_tool.
    if question_id in sess.recovery_intake_answers:
        logger.warning("[Recovery] Duplicate record_recovery_intake_answer for %s — ignoring", question_id)
        return ToolResult(
            json.dumps({"question_id": question_id, "duplicate": True, "recorded": False,
                        "message": "Already recorded — do not call again for this question."}),
            ToolResultDirection.TO_CLIENT,
        )

    sess.recovery_intake_answers[question_id] = answer_value
    if question_id == "high_stakes_task" and args.get("high_stakes_task_window"):
        sess.recovery_intake_answers["high_stakes_task_window"] = args["high_stakes_task_window"]

    if sess.recovery_session_id and sess.recovery_user_id:
        try:
            await persist_intake_answers(
                sess.recovery_session_id, sess.recovery_user_id, {question_id: answer_value},
            )
        except Exception as e:
            logger.error("[Recovery] Failed to persist intake answer %s: %s", question_id, e)

    completed = len([q for q in _GENERIC_QUESTION_IDS if q in sess.recovery_intake_answers])
    client_message = {
        "type": "recovery.intake.update",
        "questionId": question_id,
        "completed": completed,
        "total": len(_GENERIC_QUESTION_IDS),
    }
    return ToolResult(
        json.dumps({"question_id": question_id, "recorded": True, "client_message": client_message}),
        ToolResultDirection.TO_CLIENT,
    )


async def recovery_safety_answer_tool(sess: SessionState, args: Any) -> ToolResult:
    from ciq.recovery.guardrails import check_safety_interlock

    answer = args.get("answer")
    sess.recovery_intake_answers[_SAFETY_QUESTION_ID] = answer

    if sess.recovery_session_id and sess.recovery_user_id:
        try:
            await persist_intake_answers(
                sess.recovery_session_id, sess.recovery_user_id, {_SAFETY_QUESTION_ID: answer},
            )
        except Exception as e:
            logger.error("[Recovery] Failed to persist safety answer: %s", e)

    interlock = check_safety_interlock({"safety": answer})
    if interlock is not None:
        from db import (
            mark_recovery_session_grounding_only,
            mark_recovery_session_safety_halted,
        )
        if sess.recovery_session_id:
            try:
                if interlock.mode == "urgent_support":
                    await mark_recovery_session_safety_halted(sess.recovery_session_id)
                else:
                    await mark_recovery_session_grounding_only(sess.recovery_session_id)
            except Exception as e:
                logger.error("[Recovery] Failed to mark safety interlock outcome: %s", e)
        sess.reset_recovery_state()
        return ToolResult(
            json.dumps({
                "answer": answer,
                "mode": interlock.mode,
                "message": interlock.message,
                "client_message": {"type": "recovery.safety.interlock", "mode": interlock.mode},
            }),
            ToolResultDirection.TO_CLIENT,
        )

    return ToolResult(
        json.dumps({"answer": answer, "mode": "none", "client_message": {"type": "recovery.safety.cleared"}}),
        ToolResultDirection.TO_CLIENT,
    )


async def recovery_recommendation_tool(sess: SessionState, args: Any) -> ToolResult:
    from db import get_recovery_session

    stage = args.get("stage", "final")

    if not sess.recovery_session_id or not sess.recovery_user_id:
        return ToolResult(
            json.dumps({"status": "unavailable", "message": "No active Recovery Window session."}),
            ToolResultDirection.TO_SERVER,
        )

    recovery_row = await get_recovery_session(sess.recovery_session_id)
    survey_run_id = recovery_row.get("survey_run_id") if recovery_row else None

    if stage == "preliminary":
        from ciq.recovery.service import compute_and_persist_preliminary_recommendation
        try:
            result = await compute_and_persist_preliminary_recommendation(
                sess.recovery_session_id, survey_run_id, sess.recovery_user_id,
            )
        except ReportNotReadyError:
            return ToolResult(
                json.dumps({"status": "unavailable", "message": "Report not ready yet."}),
                ToolResultDirection.TO_SERVER,
            )
        return ToolResult(json.dumps({"status": "preliminary", **result}), ToolResultDirection.TO_SERVER)

    # stage == "final"
    try:
        result = await compute_and_persist_final_recommendation(
            sess.recovery_session_id, sess.recovery_user_id, survey_run_id, sess.recovery_intake_answers,
        )
    except ReportNotReadyError:
        return ToolResult(
            json.dumps({"status": "unavailable", "message": "Report not ready yet — try again shortly."}),
            ToolResultDirection.TO_SERVER,
        )

    if result["status"] in ("urgent_support", "grounding_only"):
        sess.reset_recovery_state()
        return ToolResult(
            json.dumps({"status": result["status"], "message": result["crisis_message"]}),
            ToolResultDirection.TO_SERVER,
        )

    return ToolResult(
        json.dumps({
            "status": "recommended",
            "track": result["track"],
            "rationale": result["rationale"],
            "alternatives": result["alternatives"],
            "session_length_minutes": result["session_length_minutes"],
        }),
        ToolResultDirection.TO_SERVER,
    )


async def select_recovery_track_tool(sess: SessionState, args: Any) -> ToolResult:
    from db import select_recovery_track

    track_id = args.get("track_id")
    is_override = bool(args.get("is_override", False))
    if sess.recovery_session_id:
        try:
            await select_recovery_track(sess.recovery_session_id, track_id)
        except Exception as e:
            logger.error("[Recovery] Failed to persist track selection: %s", e)
    sess.recovery_selected_track = track_id
    sess.recovery_flow_state = "track_running"
    sess.recovery_track_step_index = 0

    duration = sess.recovery_intake_answers.get("duration")
    script = get_track_script(track_id, duration)
    client_message = {
        "type": "recovery.track.selected",
        "trackId": track_id,
        "isOverride": is_override,
        "totalSteps": len(script),
    }
    return ToolResult(
        json.dumps({"track_id": track_id, "recorded": True, "client_message": client_message}),
        ToolResultDirection.TO_CLIENT,
    )


async def advance_recovery_track_step_tool(sess: SessionState, args: Any) -> ToolResult:
    from db import ack_recovery_track_step, record_recovery_track_step

    step_index = args.get("step_index", sess.recovery_track_step_index)
    user_acknowledged = bool(args.get("user_acknowledged", False))
    duration = sess.recovery_intake_answers.get("duration")
    script = get_track_script(sess.recovery_selected_track or "", duration)

    if step_index < len(script) and sess.recovery_session_id and sess.recovery_user_id:
        step = script[step_index]
        try:
            await record_recovery_track_step(
                sess.recovery_session_id, sess.recovery_user_id, sess.recovery_selected_track or "",
                step_index, step["id"], step["text"],
            )
            if user_acknowledged:
                await ack_recovery_track_step(sess.recovery_session_id, step_index)
        except Exception as e:
            logger.error("[Recovery] Failed to persist track step %d: %s", step_index, e)

    next_index = step_index + 1
    sess.recovery_track_step_index = next_index
    is_last = next_index >= len(script)
    if is_last:
        sess.recovery_flow_state = "reflection"

    client_message = {
        "type": "recovery.track.step.update",
        "stepIndex": step_index,
        "totalSteps": len(script),
        "isLast": is_last,
    }
    return ToolResult(
        json.dumps({
            "step_index": step_index,
            "next_step_index": next_index,
            "is_last": is_last,
            "client_message": client_message,
        }),
        ToolResultDirection.TO_CLIENT,
    )


async def recovery_reflection_tool(sess: SessionState, args: Any) -> ToolResult:
    from db import save_recovery_reflection

    if sess.recovery_session_id:
        try:
            await save_recovery_reflection(
                sess.recovery_session_id,
                int(args.get("feels_more_settled", 3)),
                int(args.get("perceived_helpfulness", 3)),
                str(args.get("next_step_chosen", "")),
                bool(args.get("wants_follow_up", False)),
            )
        except Exception as e:
            logger.error("[Recovery] Failed to persist reflection: %s", e)

    sess.reset_recovery_state()
    return ToolResult(
        json.dumps({"recorded": True, "client_message": {"type": "recovery.completed"}}),
        ToolResultDirection.TO_CLIENT,
    )
