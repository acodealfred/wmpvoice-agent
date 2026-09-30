"""HTTP routes for the assessment lifecycle (Start / Pause / Continue / Close).

Own-data only: the user and the live session come from
`request["auth_session"]` (never the request body), so nobody can pause,
continue or close another user's run or reset another user's live session.
The state machine itself lives in ciq/assessments/service.py.
"""
import logging

from aiohttp import web

from ciq.assessments.service import (
    AssessmentError,
    close_run,
    continue_run,
    get_resumable,
    pause_run,
    start_run,
)

logger = logging.getLogger("voicerag")


async def _json_body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _identity(request: web.Request) -> tuple[str, str]:
    auth = request["auth_session"]
    return auth["session_id"], auth["user_id"]


async def get_assessment(request: web.Request) -> web.Response:
    """GET /me/assessment — the user's resumable (active or paused) run, or null."""
    _, user_id = _identity(request)
    return web.json_response({"resumable": await get_resumable(user_id)})


async def start_assessment(request: web.Request) -> web.Response:
    """POST /me/assessment/start {surveyType?} — close any open run, start a fresh one."""
    session_id, user_id = _identity(request)
    data = await _json_body(request)
    result = await start_run(
        request.app["rtmt"], session_id, user_id, request.get("session_token"), data.get("surveyType"),
    )
    return web.json_response(result)


async def pause_assessment(request: web.Request) -> web.Response:
    """POST /me/assessment/pause — pause the user's active run."""
    session_id, user_id = _identity(request)
    try:
        return web.json_response(await pause_run(request.app["rtmt"], session_id, user_id))
    except AssessmentError as e:
        return web.json_response({"error": str(e)}, status=e.status)


async def continue_assessment(request: web.Request) -> web.Response:
    """POST /me/assessment/continue {surveyRunId} — resume where the user left off."""
    session_id, user_id = _identity(request)
    survey_run_id = (await _json_body(request)).get("surveyRunId")
    if not survey_run_id:
        return web.json_response({"error": "surveyRunId is required"}, status=400)
    try:
        return web.json_response(await continue_run(request.app["rtmt"], session_id, user_id, survey_run_id))
    except AssessmentError as e:
        return web.json_response({"error": str(e)}, status=e.status)


async def close_assessment(request: web.Request) -> web.Response:
    """POST /me/assessment/close {surveyRunId} — discard a paused run."""
    session_id, user_id = _identity(request)
    survey_run_id = (await _json_body(request)).get("surveyRunId")
    if not survey_run_id:
        return web.json_response({"error": "surveyRunId is required"}, status=400)
    try:
        return web.json_response(await close_run(request.app["rtmt"], session_id, user_id, survey_run_id))
    except AssessmentError as e:
        return web.json_response({"error": str(e)}, status=e.status)
