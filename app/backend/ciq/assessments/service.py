"""Assessment run state machine + the live-session side of pause/continue.

States (``survey_records.status``)::

    active --pause--> paused --continue--> active --report persisted--> completed
    active|paused --close / start new--> closed

At most one run per user is open (active or paused); ``db.create_active_survey_run``
enforces that in one transaction. A run left ``active`` with no live connection
(tab closed, network drop) is resumable exactly like a paused one — its answers
and timeline were already persisted as they happened / on disconnect.

Every function here takes the auth session's own ``session_id`` (never one from a
request body), so a user can only ever reset or rebind their own live session.
"""
import logging
import uuid

from ciq.realtime.session import SessionState
from ciq.realtime.timeline_capture import stop_timeline_capture
from db import (
    close_survey_run,
    create_active_survey_run,
    get_max_timeline_frame_index,
    get_open_survey_run,
    get_survey_item_responses,
    get_survey_run_status,
    get_user_baseline,
    pause_survey_run,
    resume_survey_run,
    save_survey_item_responses,
    save_survey_timeline_frames,
    update_item_user_response,
)
from survey_loader import load_survey

logger = logging.getLogger("voicerag")


class AssessmentError(Exception):
    """A transition that isn't allowed from the run's current state (-> HTTP status)."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


# ── row mapping ───────────────────────────────────────────────────────────────
def _snapshot_from_row(row: dict) -> dict:
    """survey_item_responses row -> the frontend's BiometricSnapshot shape."""
    return {
        "questionId": row["question_id"],
        "domain": row.get("domain") or "",
        "score": row.get("raw_score"),
        "userResponse": row.get("user_response"),
        "voiceSentiment": row.get("voice_sentiment") or "neutral",
        "blinkRateChange": row.get("blink_rate_change_percent") or 0,
        "pupilMmChange": row.get("pupil_mm_change"),
        "leftGazePosition": row.get("left_gaze_position") or "Center",
        "rightGazePosition": row.get("right_gaze_position") or "Center",
        "responseLatencyMs": row.get("response_latency_ms"),
    }


def _results_entry_from_row(row: dict) -> dict:
    """survey_item_responses row -> SessionState.survey_results entry (see handlers.survey_tool)."""
    return {
        "score": row.get("raw_score"),
        "user_response": row.get("user_response"),
        "voice_sentiment": row.get("voice_sentiment"),
        "blink_rate_change_percent": row.get("blink_rate_change_percent"),
        "pupil_mm_change": row.get("pupil_mm_change"),
        "left_gaze_position": row.get("left_gaze_position"),
        "right_gaze_position": row.get("right_gaze_position"),
        "response_latency_ms": row.get("response_latency_ms"),
    }


def _ordered_rows(rows: list[dict], config: dict) -> list[dict]:
    """Item rows in the survey's own question order (unknown ids last)."""
    order = {q["id"]: i for i, q in enumerate(config.get("questions", []))}
    return sorted(rows, key=lambda r: order.get(r["question_id"], len(order)))


# ── live-session persistence (called from the realtime layer) ─────────────────
async def persist_answer(sess: SessionState, survey_config: dict, snapshot: dict) -> None:
    """Persist one scored answer against the session's bound run, if it is active.

    No-op for an unbound session (legacy flow — persisted at report time) and for
    a run that was paused/closed meanwhile (e.g. another tab pressed Start new).
    """
    if not sess.survey_run_id or not sess.user_id:
        return
    try:
        status = await get_survey_run_status(sess.survey_run_id)
        if status != "active":
            logger.warning("[Assessment] Answer %s not persisted: run %s is %s",
                           snapshot.get("questionId"), sess.survey_run_id[:8], status)
            return
        await save_survey_item_responses(
            sess.survey_run_id, sess.user_id, sess.session_id, survey_config, [snapshot],
        )
    except Exception as e:
        logger.error("[Assessment] Persisting answer %s failed: %s", snapshot.get("questionId"), e)


async def persist_transcript(sess: SessionState, question_id: str, text: str) -> None:
    """Store the user's own words for an answer already persisted with the model's text.

    Any status: a transcript can land after Pause or right after completion, and
    it only ever corrects an existing row.
    """
    if not sess.survey_run_id:
        return
    try:
        await update_item_user_response(sess.survey_run_id, question_id, text)
    except Exception as e:
        logger.error("[Assessment] Persisting transcript for %s failed: %s", question_id, e)


async def flush_timeline(sess: SessionState) -> None:
    """Persist the bound run's buffered timeline frames (safe to repeat — upsert)."""
    if not sess.survey_run_id or not sess.user_id or not sess.timeline_frames:
        return
    try:
        await save_survey_timeline_frames(
            sess.survey_run_id, sess.user_id, sess.session_id, list(sess.timeline_frames),
        )
    except Exception as e:
        logger.error("[Assessment] Timeline flush failed (run=%s): %s", sess.survey_run_id[:8], e)


async def _retire_live_state(sess: SessionState) -> None:
    """Stop sampling and save what the currently bound run captured, before a reset."""
    stop_timeline_capture(sess)
    await flush_timeline(sess)


# ── transitions ───────────────────────────────────────────────────────────────
async def get_resumable(user_id: str) -> dict | None:
    """The user's open run in the shape the assessment page needs, or None."""
    run = await get_open_survey_run(user_id)
    if not run:
        return None
    config = load_survey(run["survey_type"] or "TEST")
    rows = _ordered_rows(await get_survey_item_responses(run["survey_run_id"]), config)
    return {
        "surveyRunId": run["survey_run_id"],
        "surveyType": run["survey_type"],
        "status": run["status"],
        "answered": len(rows),
        "total": len(config.get("questions", [])),
        "startedAt": run["created_at"],
        "pausedAt": run.get("paused_at") or run.get("updated_at"),
        "snapshots": [_snapshot_from_row(r) for r in rows],
    }


async def start_run(rtmt, session_id: str, user_id: str, session_token: str | None,
                    requested_type: str | None) -> dict:
    """Close any open run, fully reset the live session and bind a new active run."""
    sess = rtmt.get_or_create_session(session_id)
    await _retire_live_state(sess)
    survey_type = (
        rtmt.default_survey_type if rtmt.survey_type_overridden
        else (requested_type or sess.survey_type or rtmt.default_survey_type)
    )
    sess.reset_for_new_survey()
    resolved_type = rtmt.set_survey_type_for_session(session_id, survey_type)
    survey_run_id = str(uuid.uuid4())
    closed = await create_active_survey_run(survey_run_id, user_id, session_token, session_id, resolved_type)
    sess.survey_run_id = survey_run_id
    sess.user_id = user_id
    logger.info("[Assessment] ★ Started run %s (%s) for user %s; closed %s",
                survey_run_id[:8], resolved_type, user_id[:8], [c[:8] for c in closed])
    return {"surveyRunId": survey_run_id, "surveyType": resolved_type, "segmentIndex": 0,
            "closedRunIds": closed}


async def pause_run(rtmt, session_id: str, user_id: str) -> dict:
    """active -> paused: stop sampling, persist the segment's frames, drop the open answer window."""
    run = await get_open_survey_run(user_id)
    if not run or run["status"] != "active":
        raise AssessmentError("No active assessment to pause", 409)
    sess = rtmt.get_or_create_session(session_id)
    if sess.survey_run_id == run["survey_run_id"]:
        await _retire_live_state(sess)
        # The question being answered (if any) is re-asked on Continue; its frames
        # keep their user_answer/idle tags — accurate: the user was mid-answer.
        sess.pending_answer_question_id = None
        sess.pending_answer_question_index = None
        sess.pending_answer_started_at_frame_index = None
    await pause_survey_run(run["survey_run_id"], user_id)
    logger.info("[Assessment] ★ Paused run %s", run["survey_run_id"][:8])
    return {"surveyRunId": run["survey_run_id"], "status": "paused"}


async def continue_run(rtmt, session_id: str, user_id: str, survey_run_id: str) -> dict:
    """Open run -> active on its next segment, with the live session rehydrated.

    With a stored (non-expired) baseline the session goes straight to the
    "survey" phase — the baseline is reused, no protocol. Without one (paused
    mid-baseline, or the 12h baseline TTL lapsed while paused) it goes back to the
    "baseline" phase and ``baselineRequired`` tells the frontend to run the
    protocol first.

    With at least one answer, connection_count=1, so the next WS connect counts as
    a reconnect: the agent gets reconnect_instructions ("N/M answered — continue")
    and the PILOT "pre" behaviour window is not re-captured over the original one.
    With none, it is a fresh start instead (see below).
    """
    run = await get_open_survey_run(user_id)
    if not run or run["survey_run_id"] != survey_run_id:
        raise AssessmentError("That assessment can no longer be continued", 409)
    sess = rtmt.get_or_create_session(session_id)
    await _retire_live_state(sess)

    segment = await resume_survey_run(survey_run_id, user_id)
    if segment is None:
        raise AssessmentError("That assessment can no longer be continued", 409)
    max_frame = await get_max_timeline_frame_index(survey_run_id)
    has_baseline = await get_user_baseline(user_id) is not None

    sess.reset_for_new_survey()
    rtmt.set_survey_type_for_session(session_id, run["survey_type"] or "TEST")
    rows = _ordered_rows(await get_survey_item_responses(survey_run_id), sess.survey_config)
    for r in rows:
        sess.survey_results[r["question_id"]] = _results_entry_from_row(r)
    if rows:
        sess.survey_phase = "survey" if has_baseline else "baseline"
        sess.is_returning_user = has_baseline
        sess.connection_count = 1
    # else: nothing answered yet (paused during/right after the baseline) — leave the
    # session as a fresh start (connection_count=0), so the next WS connect resolves the
    # phase from the stored baseline like any new assessment and the agent gives the
    # normal opening, not "welcome back — shall we continue?".
    sess.survey_run_id = survey_run_id
    sess.user_id = user_id
    sess.timeline_segment_index = segment
    sess.timeline_frame_offset = max_frame + 1
    logger.info("[Assessment] ★ Continued run %s at segment %d (%d answered, frames from %d)",
                survey_run_id[:8], segment, len(rows), max_frame + 1)
    return {
        "surveyRunId": survey_run_id,
        "surveyType": run["survey_type"],
        "segmentIndex": segment,
        "baselineRequired": not has_baseline,
        "answered": len(rows),
        "total": len(sess.survey_config.get("questions", [])),
        "snapshots": [_snapshot_from_row(r) for r in rows],
    }


async def close_run(rtmt, session_id: str, user_id: str, survey_run_id: str) -> dict:
    """paused (or stale active) -> closed."""
    if not await close_survey_run(survey_run_id, user_id):
        raise AssessmentError("That assessment is not open", 409)
    sess = rtmt.get_or_create_session(session_id)
    if sess.survey_run_id == survey_run_id:
        stop_timeline_capture(sess)
        sess.survey_run_id = None
        sess.user_id = None
    logger.info("[Assessment] ★ Closed run %s", survey_run_id[:8])
    return {"surveyRunId": survey_run_id, "status": "closed"}
