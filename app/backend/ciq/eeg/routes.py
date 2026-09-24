"""HTTP route handlers for uploading/downloading a raw Muse EEG session recorded during an assessment."""
import json
import logging

from aiohttp import web

from db import get_eeg_session, save_eeg_session

logger = logging.getLogger("voicerag")

# aiohttp's Application-wide default is 1 MiB (web.Application(client_max_size=...)
# in server.py doesn't override it), which a full Muse recording blows past easily:
# 256 Hz EEG across 4 channels, plus PPG/IMU, over a ~20 min BAT survey lands in the
# 10-20MB range as JSON. Raised only for this route (via request.clone below), not
# globally, so every other endpoint keeps the smaller default. 50MB gives headroom
# over the recorder's own worst case — every stream (EEG/PPG/accel/gyro) capped at
# MAX_PACKETS_PER_STREAM=40_000 in recorder.ts — without being unreasonably permissive.
_EEG_UPLOAD_MAX_SIZE = 50 * 1024 * 1024


async def upload_eeg_session(request):
    """POST /eeg-sessions — persist one finished Muse recording, tied to a survey run.

    Raw recording only: this stores the whole muse-web-bridge/3 session file
    (EEG/IMU/PPG/telemetry + per-question markers) as-is. No stress/burnout
    metric is derived from it here or anywhere downstream — see
    docs/muse-2-findings.md for why that's deliberately out of scope for now.
    """
    try:
        request = request.clone(client_max_size=_EEG_UPLOAD_MAX_SIZE)
        data = await request.json()
        survey_run_id = data.get("survey_run_id", "")
        session_id = data.get("session_id", "")
        file = data.get("file")

        if not survey_run_id or not file:
            return web.json_response({"error": "survey_run_id and file are required"}, status=400)

        auth_session = request.get("auth_session")
        if not auth_session:
            return web.json_response({"error": "Unauthorized"}, status=401)

        await save_eeg_session(survey_run_id, auth_session["user_id"], session_id, file)
        return web.json_response({"ok": True})

    except web.HTTPException:
        # Preserve real status codes (e.g. 413 if a session still exceeds the
        # raised limit above) instead of flattening everything to 500 below.
        raise
    except Exception as e:
        logger.error(f"EEG session upload error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def admin_export_eeg_session(request: web.Request) -> web.Response:
    """GET /admin/eeg-sessions/export?survey_run_id=... — download the raw
    muse-web-bridge/3 session file (EEG/IMU/PPG/telemetry + markers), exactly
    as uploaded and stored by upload_eeg_session above. No processing."""
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    eeg_session = await get_eeg_session(survey_run_id)
    if not eeg_session:
        return web.json_response({"error": "No EEG session recorded for this survey run"}, status=404)

    return web.Response(
        body=json.dumps(eeg_session["file_json"]),
        headers={"Content-Disposition": f'attachment; filename="eeg_session_{survey_run_id[:8]}.json"'},
        content_type="application/json",
    )
