"""HTTP route handlers for the Recovery Window: lifecycle REST + admin review.

Individual-only surface: every non-admin route is ownership-checked against
`request["auth_session"]["user_id"]` (never trusted from the request body).
The admin flagged-sessions routes rely on living under `/admin/` so auth.py's
existing `_ADMIN_PREFIXES` gate applies with no new middleware code — see
docs/recovery-window.md for the privacy model this whole feature follows.

The 9 intake answers are primarily collected via voice tool calls
(ciq/realtime/tools/recovery_handlers.py), not REST — `POST .../recommend`
here is a fallback/companion path for a non-voice UI, and shares its actual
recommendation logic with the voice tools via ciq/recovery/service.py so the
two paths can never diverge (see that module's docstring).
"""
import logging
import uuid

from aiohttp import web

from ciq.recovery.intake_questions import INTAKE_QUESTION_IDS
from ciq.recovery.service import (
    ReportNotReadyError,
    compute_and_persist_final_recommendation,
    compute_and_persist_preliminary_recommendation,
    persist_intake_answers,
)
from ciq.recovery.tracks import TRACK_IDS
from db import (
    ack_flagged_recovery_session,
    create_recovery_session,
    get_latest_recovery_session_for_run,
    get_recovery_session,
    list_flagged_recovery_sessions,
    save_recovery_reflection,
    select_recovery_track,
)

logger = logging.getLogger("voicerag")


def _serialize_session(row: dict) -> dict:
    return {
        "recoverySessionId": row["recovery_session_id"],
        "status": row["status"],
        "surveyRunId": row.get("survey_run_id"),
        "preliminaryTrack": row.get("preliminary_track"),
        "preliminaryRationale": row.get("preliminary_rationale"),
        "recommendedTrack": row.get("recommended_track"),
        "recommendationRationale": row.get("recommendation_rationale"),
        "selectedTrack": row.get("selected_track"),
        "groundingOnlyMode": bool(row.get("grounding_only_mode")),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


async def _load_owned_session(request: web.Request) -> dict | web.Response:
    """Load the session named by the {recoverySessionId} path param, 404/403-checked.
    Returns the row dict, or a ready-to-return web.Response on failure."""
    user_id = request["auth_session"]["user_id"]
    recovery_session_id = request.match_info["recoverySessionId"]
    session = await get_recovery_session(recovery_session_id)
    if not session:
        return web.json_response({"error": "Not found"}, status=404)
    if session["user_id"] != user_id:
        return web.json_response({"error": "Forbidden"}, status=403)
    return session


async def start_recovery_session(request: web.Request) -> web.Response:
    """POST /api/recovery-window/start — create the session row, kick off the
    voice flow on the realtime session (if one is live for this session_id), and
    (if the report is already available) compute+persist the preliminary
    recommendation for the agent's opening narration."""
    try:
        user_id = request["auth_session"]["user_id"]
        data = await request.json()
        survey_run_id = data.get("surveyRunId")
        session_id = data.get("sessionId")
        recovery_session_id = str(uuid.uuid4())
        await create_recovery_session(recovery_session_id, user_id, survey_run_id, session_id)

        rtmt = request.app.get("rtmt")
        if rtmt and session_id:
            rtmt.start_recovery_flow_for_session(session_id, recovery_session_id, user_id)

        preliminary = None
        try:
            preliminary = await compute_and_persist_preliminary_recommendation(
                recovery_session_id, survey_run_id, user_id,
            )
        except ReportNotReadyError:
            logger.info("[Recovery] Report not ready yet for preliminary recommendation (run=%s)", survey_run_id)

        response = {"recoverySessionId": recovery_session_id, "status": "not_started"}
        if preliminary:
            response["preliminary"] = {
                "track": preliminary["track"],
                "rationale": preliminary["rationale"],
                "alternatives": preliminary["alternatives"],
            }
        return web.json_response(response)
    except Exception as e:
        logger.error("[Recovery] start_recovery_session error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def get_recovery_session_route(request: web.Request) -> web.Response:
    """GET /api/recovery-window/sessions/{recoverySessionId} — resume a session."""
    session = await _load_owned_session(request)
    if isinstance(session, web.Response):
        return session
    return web.json_response({"session": _serialize_session(session)})


async def get_latest_recovery_session_route(request: web.Request) -> web.Response:
    """GET /api/recovery-window/sessions/latest?survey_run_id=... — the card's
    "do I already have a recommendation for this report" check."""
    user_id = request["auth_session"]["user_id"]
    survey_run_id = request.query.get("survey_run_id")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)
    session = await get_latest_recovery_session_for_run(user_id, survey_run_id)
    return web.json_response({"session": _serialize_session(session) if session else None})


async def recommend_recovery_route(request: web.Request) -> web.Response:
    """POST /api/recovery-window/sessions/{recoverySessionId}/recommend — REST fallback
    for the FINAL recommendation, given a full set of intake answers. Thin wrapper over
    the same ciq.recovery.service function the voice tool uses."""
    session = await _load_owned_session(request)
    if isinstance(session, web.Response):
        return session
    try:
        data = await request.json()
        answers = data.get("answers") or {}
        missing = [k for k in INTAKE_QUESTION_IDS if k not in answers]
        if missing:
            return web.json_response({"error": f"Missing answers: {', '.join(missing)}"}, status=400)

        await persist_intake_answers(session["recovery_session_id"], session["user_id"], answers)
        try:
            result = await compute_and_persist_final_recommendation(
                session["recovery_session_id"], session["user_id"], session.get("survey_run_id"), answers,
            )
        except ReportNotReadyError:
            return web.json_response(
                {"error": "Your report isn't ready yet — please try again in a moment."}, status=409
            )

        if result["status"] in ("urgent_support", "grounding_only"):
            from db import (
                mark_recovery_session_grounding_only,
                mark_recovery_session_safety_halted,
            )
            if result["status"] == "urgent_support":
                await mark_recovery_session_safety_halted(session["recovery_session_id"])
            else:
                await mark_recovery_session_grounding_only(session["recovery_session_id"])
            return web.json_response({"status": result["status"], "crisisMessage": result["crisis_message"]})

        return web.json_response({
            "status": "recommended",
            "track": result["track"],
            "rationale": result["rationale"],
            "alternatives": result["alternatives"],
            "sessionLengthMinutes": result["session_length_minutes"],
        })
    except Exception as e:
        logger.error("[Recovery] recommend_recovery_route error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def select_track_route(request: web.Request) -> web.Response:
    """POST /api/recovery-window/sessions/{recoverySessionId}/select-track — the UI
    fallback for track override (also reachable via the select_recovery_track voice tool,
    same DB write path)."""
    session = await _load_owned_session(request)
    if isinstance(session, web.Response):
        return session
    try:
        data = await request.json()
        track_id = data.get("trackId")
        if track_id not in TRACK_IDS:
            return web.json_response({"error": "Invalid trackId"}, status=400)
        await select_recovery_track(session["recovery_session_id"], track_id)
        return web.json_response({"ok": True, "selectedTrack": track_id})
    except Exception as e:
        logger.error("[Recovery] select_track_route error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def complete_recovery_route(request: web.Request) -> web.Response:
    """POST /api/recovery-window/sessions/{recoverySessionId}/complete — REST fallback
    for the post-session reflection (also reachable via the record_recovery_reflection
    voice tool)."""
    session = await _load_owned_session(request)
    if isinstance(session, web.Response):
        return session
    try:
        data = await request.json()
        await save_recovery_reflection(
            session["recovery_session_id"],
            int(data.get("feelsMoreSettled", 3)),
            int(data.get("perceivedHelpfulness", 3)),
            str(data.get("nextStepChosen", "")),
            bool(data.get("wantsFollowUp", False)),
        )
        return web.json_response({"ok": True})
    except Exception as e:
        logger.error("[Recovery] complete_recovery_route error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


# ── Admin-only: safety-flagged sessions for HR follow-up (never manager-visible) ──

async def list_flagged_sessions(request: web.Request) -> web.Response:
    """GET /admin/recovery-window/flagged — gated to role=admin by auth.py's
    existing `_ADMIN_PREFIXES` (the `/admin/` prefix), no new middleware needed."""
    sessions = await list_flagged_recovery_sessions()
    return web.json_response({
        "sessions": [
            {
                "recoverySessionId": s["recovery_session_id"],
                "userId": s["user_id"],
                "userName": s["user_name"],
                "status": s["status"],
                "createdAt": s["created_at"],
                "reviewed": bool(s["safety_flag_reviewed"]),
            }
            for s in sessions
        ]
    })


async def ack_flagged_session(request: web.Request) -> web.Response:
    """POST /admin/recovery-window/flagged/{recoverySessionId}/ack — mark reviewed."""
    admin_user_id = request["auth_session"]["user_id"]
    recovery_session_id = request.match_info["recoverySessionId"]
    await ack_flagged_recovery_session(recovery_session_id, admin_user_id)
    return web.json_response({"ok": True})
