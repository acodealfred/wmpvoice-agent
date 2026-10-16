"""GET /me/reports/{runId}/comparison — how one of the user's completed runs compares
with their previous run of the same survey type (ciq/reports/comparison.py), for the
"Compared with your last assessment" card on the report (and so the stored QR PDF).

Always against the run before THAT run, so a report reopened from History shows its
own comparison. The logged-in user's own runs only. Read-only.
"""
import logging

from aiohttp import web

from ciq.reports.comparison import compare_runs, previous_same_type_run
from db import get_user_survey_records
from survey_loader import load_survey

logger = logging.getLogger("voicerag")


async def me_report_comparison(request: web.Request) -> web.Response:
    """{"comparison": {...} | null}; 404 for a run that isn't the caller's completed run."""
    run_id = request.match_info["runId"]
    records = await get_user_survey_records(request["auth_session"]["user_id"])
    current = next((r for r in records if r.get("survey_run_id") == run_id), None)
    if current is None:
        # 404 (not 403) for someone else's run, so run ids can't be probed.
        return web.json_response({"error": "Report not found."}, status=404)
    try:
        config = load_survey(current.get("survey_type") or "TEST")
        comparison = compare_runs(current, previous_same_type_run(records, current), config)
    except Exception as e:
        logger.error("[Compare] Comparison unavailable for run %s: %s", run_id[:8], e)
        comparison = None
    return web.json_response({"comparison": comparison})
