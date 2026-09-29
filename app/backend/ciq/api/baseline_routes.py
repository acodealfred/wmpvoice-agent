"""Per-user baseline endpoints (thin wrappers over the db module).

A baseline is the camera biometrics averaged over the eyes-open phase plus, when a
Muse headband was connected, the raw eyes-open/eyes-closed EEG session file.
"""
import json

from aiohttp import web

from db import delete_user_baseline, get_user_baseline, upsert_user_baseline

# The EEG baseline (~6 min of 256 Hz EEG + PPG/IMU as JSON) is a few MB — well over
# aiohttp's 1 MiB default. Raised only for POST /baseline, same approach as
# ciq.eeg.routes._EEG_UPLOAD_MAX_SIZE.
_BASELINE_UPLOAD_MAX_SIZE = 20 * 1024 * 1024


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
    """POST /baseline — overwrite the logged-in user's baseline {pupilSize, blinkRate, eeg?}.

    `eeg` is the optional muse-web-bridge/3 session file covering the baseline phases
    (absent/null when no headband was connected).
    """
    user_id = request["auth_session"]["user_id"]
    request = request.clone(client_max_size=_BASELINE_UPLOAD_MAX_SIZE)
    try:
        data = await request.json()
        pupil = float(data["pupilSize"])
        blink = float(data["blinkRate"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return web.json_response({"error": "pupilSize and blinkRate (numbers) required"}, status=400)
    eeg = data.get("eeg")
    if eeg is not None and not isinstance(eeg, dict):
        return web.json_response({"error": "eeg must be an object when provided"}, status=400)
    await upsert_user_baseline(user_id, pupil, blink, eeg)
    return web.json_response({"baseline": {"pupilSize": pupil, "blinkRate": blink, "hasEeg": eeg is not None}})


async def clear_baseline(request: web.Request) -> web.Response:
    """DELETE /baseline — drop the logged-in user's baseline so a fresh one is recorded."""
    user_id = request["auth_session"]["user_id"]
    await delete_user_baseline(user_id)
    return web.json_response({"baseline": None})
