"""Per-user informed-consent endpoints (thin wrappers over the db module)."""
from aiohttp import web

from db import get_user_consent, record_user_consent


async def get_consent(request: web.Request) -> web.Response:
    """GET /consent — has the logged-in user already accepted the pilot-study consent?"""
    user_id = request["auth_session"]["user_id"]
    row = await get_user_consent(user_id)
    return web.json_response({"accepted": row is not None})


async def save_consent(request: web.Request) -> web.Response:
    """POST /consent — record the logged-in user's acceptance (idempotent)."""
    user_id = request["auth_session"]["user_id"]
    await record_user_consent(user_id)
    return web.json_response({"accepted": True})
