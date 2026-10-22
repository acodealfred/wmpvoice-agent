"""GET /me/reports/{runId}/signal-comparison — how the person's own signals during each
question of a PILOT run compare with their previous PILOT runs (ciq/reports/signal_comparison.py),
for the "Your signals, compared with your past check-ins" card on the report (and so the
stored QR PDF).

Always against the runs before THAT run, so a report reopened from History shows its own
comparison. The logged-in user's own runs only. Read-only, computed on demand, nothing stored.
"""
import logging

from aiohttp import web

from ciq.config import signal_comparison_enabled
from ciq.reports.comparison import _scored
from ciq.reports.signal_comparison import (
    SIGNAL_CONFIG,
    compare_signals,
    question_readings,
)
from db import (
    get_survey_item_responses,
    get_survey_timeline_frames,
    get_user_survey_records,
)
from survey_loader import load_survey

logger = logging.getLogger("voicerag")


def _previous_pilot_runs(records: list[dict], current: dict) -> list[dict]:
    """The person's earlier scored, non-demo PILOT runs, newest first, up to personal_window."""
    created = current.get("created_at") or ""
    earlier = [
        r for r in records
        if r.get("survey_run_id") != current.get("survey_run_id")
        and (r.get("survey_type") or "").upper() == "PILOT"
        and (r.get("created_at") or "") < created
        and not r.get("is_demo")
        and _scored(r)
    ]
    earlier.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return earlier[: SIGNAL_CONFIG["personal_window"]]


async def _with_readings(record: dict, question_ids: list[str]) -> dict:
    run_id = record["survey_run_id"]
    frames = await get_survey_timeline_frames(run_id)
    items = await get_survey_item_responses(run_id)
    return {"record": record, "readings": question_readings(frames, items, question_ids)}


async def _compute(records: list[dict], current: dict) -> dict | None:
    if (current.get("survey_type") or "").upper() != "PILOT":
        return None
    previous_records = _previous_pilot_runs(records, current)
    if not previous_records:
        return None
    survey_config = load_survey("PILOT")
    question_ids = [q["id"] for q in survey_config.get("questions", []) if q.get("id")]
    current_run = await _with_readings(current, question_ids)
    previous = [await _with_readings(r, question_ids) for r in previous_records]
    return compare_signals(current_run, previous, SIGNAL_CONFIG, survey_config)


async def load_signal_comparison(user_id: str, run_id: str) -> dict | None:
    """The signal comparison for one of the user's completed runs, or None (not theirs,
    nothing to show, or switched off). Shared with the voice report (Phase 2)."""
    if not signal_comparison_enabled():
        return None
    records = await get_user_survey_records(user_id)
    current = next((r for r in records if r.get("survey_run_id") == run_id), None)
    return await _compute(records, current) if current else None


async def me_signal_comparison(request: web.Request) -> web.Response:
    """{"signalComparison": {...} | null}; 404 for a run that isn't the caller's completed run."""
    run_id = request.match_info["runId"]
    records = await get_user_survey_records(request["auth_session"]["user_id"])
    current = next((r for r in records if r.get("survey_run_id") == run_id), None)
    if current is None:
        # 404 (not 403) for someone else's run, so run ids can't be probed.
        return web.json_response({"error": "Report not found."}, status=404)
    if not signal_comparison_enabled():
        return web.json_response({"signalComparison": None})
    try:
        result = await _compute(records, current)
    except Exception as e:
        # The report must never fail because of this card.
        logger.error("[Signals] Signal comparison unavailable for run %s: %s", run_id[:8], e)
        result = None
    return web.json_response({"signalComparison": result})
