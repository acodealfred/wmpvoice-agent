"""One saved assessment report, shaped for the frontend's read-only DetailedReport —
so a user can reopen (and download) a past report from the History tab, and an admin
from the Data Validation panel. Nothing is recalculated except the overall gauge's
maximum, which was never stored. Read-only: only SELECTs, safe alongside Litestream.

  GET /me/reports/{runId}          — the logged-in user's own completed runs only
  GET /admin/reports/runs/{runId}  — any run; admin-only via auth_middleware (/admin/*)

The AI Insights texts are deliberately not returned: the saved report view shows the
calculated report only.
"""
import json
import logging

from aiohttp import web

from db import get_survey_record
from survey_loader import get_score_bounds, load_survey

logger = logging.getLogger("voicerag")

_REPORT_KEYS = ("totalScore", "riskLevel", "interpretation", "sections", "domainTotals")


def _json(value) -> dict:
    """A stored JSON column as a dict ({} when empty or unparseable)."""
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def saved_report_view(record: dict) -> dict | None:
    """The saved report as {surveyRunId, surveyType, createdAt, snapshots, report};
    None when the run has no saved answers or report to show."""
    results = _json(record.get("survey_results"))
    technical = _json(record.get("technical_report"))
    if not results or not technical:
        return None

    # survey_results is keyed by questionId in answer order (serialize_survey_results).
    snapshots = [{"questionId": qid, **fields} for qid, fields in results.items() if isinstance(fields, dict)]
    survey_type = record.get("survey_type") or ""

    report = {k: technical[k] for k in _REPORT_KEYS if k in technical}
    report.setdefault("domainTotals", {})
    # Same formula as compute_survey_summary (answers x the survey's top option value).
    if "sections" not in report and "totalScore" in report:
        _, hi = get_score_bounds(load_survey(survey_type or "TEST"))
        report["maxScore"] = len(snapshots) * hi

    return {
        "surveyRunId": record.get("survey_run_id"),
        "surveyType": survey_type,
        "createdAt": record.get("created_at"),
        "snapshots": snapshots,
        "report": report,
    }


def _not_found() -> web.Response:
    return web.json_response({"error": "Report not found."}, status=404)


async def me_saved_report(request: web.Request) -> web.Response:
    """GET /me/reports/{runId} — 404 (not 403) for someone else's run, so run ids can't be probed."""
    record = await get_survey_record(request.match_info["runId"])
    if (
        not record
        or record.get("user_id") != request["auth_session"]["user_id"]
        or record.get("status") != "completed"
    ):
        return _not_found()
    view = saved_report_view(record)
    return web.json_response(view) if view else _not_found()


async def admin_saved_report(request: web.Request) -> web.Response:
    """GET /admin/reports/runs/{runId}."""
    record = await get_survey_record(request.match_info["runId"])
    view = saved_report_view(record) if record else None
    if view:
        logger.info("[Reports] Admin opened saved report for run %s", view["surveyRunId"][:8])
    return web.json_response(view) if view else _not_found()
