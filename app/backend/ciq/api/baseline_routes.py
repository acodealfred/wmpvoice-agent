"""Per-user biometric baseline endpoints (thin wrappers over the db module)."""
import json

from aiohttp import web

from db import delete_user_baseline, get_user_baseline, upsert_user_baseline


async def get_baseline(request: web.Request) -> web.Response:
    """GET /baseline — return the logged-in user's calibrated baseline, if any."""
    user_id = request["auth_session"]["user_id"]
    row = await get_user_baseline(user_id)
    if not row:
        return web.json_response({"baseline": None})
    return web.json_response(
        {"baseline": {"pupilSize": row["pupil_size"], "blinkRate": row["blink_rate"], "updatedAt": row["updated_at"]}}
    )


async def save_baseline(request: web.Request) -> web.Response:
    """POST /baseline — upsert the logged-in user's baseline {pupilSize, blinkRate}."""
    user_id = request["auth_session"]["user_id"]
    try:
        data = await request.json()
        pupil = float(data["pupilSize"])
        blink = float(data["blinkRate"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return web.json_response({"error": "pupilSize and blinkRate (numbers) required"}, status=400)
    await upsert_user_baseline(user_id, pupil, blink)
    return web.json_response({"baseline": {"pupilSize": pupil, "blinkRate": blink}})


async def clear_baseline(request: web.Request) -> web.Response:
    """DELETE /baseline — drop the logged-in user's baseline so a fresh one is recorded."""
    user_id = request["auth_session"]["user_id"]
    await delete_user_baseline(user_id)
    return web.json_response({"baseline": None})
