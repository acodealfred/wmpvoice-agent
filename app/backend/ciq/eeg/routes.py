"""HTTP route handlers for uploading/downloading a raw Muse EEG session recorded during an assessment."""
import json
import logging

from aiohttp import web

from ciq.common.export_names import export_filename
from db import get_eeg_segments, save_eeg_segment, save_eeg_session

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

    With `segment_index` (sent by the Start/Pause/Continue flow) the file is
    stored as that segment of the run, so a Pause upload never overwrites an
    earlier segment. Without it (older clients) it's the run's single file.
    """
    try:
        request = request.clone(client_max_size=_EEG_UPLOAD_MAX_SIZE)
        data = await request.json()
        survey_run_id = data.get("survey_run_id", "")
        session_id = data.get("session_id", "")
        file = data.get("file")
        segment_index = data.get("segment_index")

        if not survey_run_id or not file:
            return web.json_response({"error": "survey_run_id and file are required"}, status=400)

        auth_session = request.get("auth_session")
        if not auth_session:
            return web.json_response({"error": "Unauthorized"}, status=401)

        if segment_index is None:
            await save_eeg_session(survey_run_id, auth_session["user_id"], session_id, file)
        else:
            if not isinstance(segment_index, int) or segment_index < 0:
                return web.json_response({"error": "segment_index must be a non-negative integer"}, status=400)
            await save_eeg_segment(survey_run_id, segment_index, auth_session["user_id"], session_id, file)
        return web.json_response({"ok": True})

    except web.HTTPException:
        # Preserve real status codes (e.g. 413 if a session still exceeds the
        # raised limit above) instead of flattening everything to 500 below.
        raise
    except Exception as e:
        logger.error(f"EEG session upload error: {e}")
        return web.json_response({"error": str(e)}, status=500)


def _tagged(survey_run_id: str, seg: dict):
    """A COPY of the segment's Muse file with a top-level `ciq` identity block, so a
    downloaded file always says whose recording it is. The stored file_json is never
    modified; combine.py and other readers ignore the extra key."""
    file = seg["file_json"]
    if not isinstance(file, dict):
        return file
    return {
        **file,
        "ciq": {"user_id": seg.get("user_id"), "survey_run_id": survey_run_id, "segment_index": seg["segment_index"]},
    }


def eeg_payload(survey_run_id: str, segments: list[dict], segment: int | None = None):
    """The raw EEG download body (before json.dumps) — shared by the EEG export and
    the Data Validation ZIP. `segment` → that segment's standard Muse file (None if
    it was not recorded); no segment → the one file, or a {segments: [...]} bundle
    for a paused-and-continued run. Every file carries the `ciq` block (_tagged)
    and the bundle a top-level user_id."""
    if segment is not None:
        match = next((s for s in segments if s["segment_index"] == segment), None)
        return _tagged(survey_run_id, match) if match else None
    if len(segments) == 1:
        return _tagged(survey_run_id, segments[0])
    return {
        "survey_run_id": survey_run_id,
        "user_id": segments[0].get("user_id"),
        "segments": [{"segment_index": s["segment_index"], "file": _tagged(survey_run_id, s)} for s in segments],
    }


async def admin_export_eeg_session(request: web.Request) -> web.Response:
    """GET /admin/eeg-sessions/export?survey_run_id=... — download the raw
    muse-web-bridge/3 session file (EEG/IMU/PPG/telemetry + markers), exactly
    as uploaded and stored by upload_eeg_session above. No processing.

    A run recorded in one segment downloads as that file, unchanged. A paused-
    and-continued run downloads as {"survey_run_id", "segments": [{segment_index,
    file}]} — each segment keeps its own clock, so they are never merged.
    `&segment=N` downloads just that segment's raw file (a standard Muse file)."""
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)
    segment_param = request.query.get("segment")
    if segment_param is not None and not segment_param.isdigit():
        return web.json_response({"error": "segment must be a non-negative integer"}, status=400)

    segments = await get_eeg_segments(survey_run_id)
    if not segments:
        return web.json_response({"error": "No EEG session recorded for this survey run"}, status=404)

    segment = int(segment_param) if segment_param is not None else None
    body = eeg_payload(survey_run_id, segments, segment)
    if body is None:
        return web.json_response({"error": f"No EEG recorded for segment {segment_param}"}, status=404)
    filename = export_filename("eeg", survey_run_id, segments[0].get("user_id"), segment=segment)
    return web.Response(
        body=json.dumps(body),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        content_type="application/json",
    )
