"""Per-user informed-consent endpoints (thin wrappers over the db module)."""
from aiohttp import web

from db import get_user_consent, record_consent_event, record_user_consent


async def get_consent(request: web.Request) -> web.Response:
    """GET /consent — has the logged-in user already accepted the pilot-study consent?"""
    user_id = request["auth_session"]["user_id"]
    row = await get_user_consent(user_id)
    return web.json_response({"accepted": row is not None})


async def save_consent(request: web.Request) -> web.Response:
    """POST /consent {version?, surveyType?} — record the logged-in user's acceptance.

    Shown on every entry to the assessment page, so each acceptance is also logged
    in consent_events with the wording version it was given against.
    """
    user_id = request["auth_session"]["user_id"]
    data = {}
    if request.can_read_body:
        try:
            data = await request.json()
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    await record_user_consent(user_id)
    await record_consent_event(user_id, data.get("version"), data.get("surveyType"))
    return web.json_response({"accepted": True})
