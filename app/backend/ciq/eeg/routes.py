"""HTTP route handler for uploading a raw Muse EEG session recorded during an assessment."""
import logging

from aiohttp import web

from db import save_eeg_session

logger = logging.getLogger("voicerag")


async def upload_eeg_session(request):
    """POST /eeg-sessions — persist one finished Muse recording, tied to a survey run.

    Raw recording only: this stores the whole muse-web-bridge/3 session file
    (EEG/IMU/PPG/telemetry + per-question markers) as-is. No stress/burnout
    metric is derived from it here or anywhere downstream — see
    docs/muse-2-findings.md for why that's deliberately out of scope for now.
    """
    try:
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

    except Exception as e:
        logger.error(f"EEG session upload error: {e}")
        return web.json_response({"error": str(e)}, status=500)
