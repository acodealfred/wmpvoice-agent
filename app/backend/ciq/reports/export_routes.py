"""GET /admin/reports/export — every completed participant report in a period, as a
ZIP of PDFs (one per run, named <user_name>_<survey_run_id>.pdf). Read-only: only
SELECTs, so it is safe alongside Litestream. Admin-only via auth_middleware (every
/admin/* route).
"""
import asyncio
import io
import logging
import zipfile
from datetime import datetime

from aiohttp import web

from ciq.reports.export import (
    PERIODS,
    period_since,
    report_content,
    report_filename,
    valid_offset,
    zip_filename,
)
from ciq.reports.pdf import render_report_pdf
from db import get_completed_reports

logger = logging.getLogger("voicerag")


def _build_zip(records: list[dict], tz_offset_min: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in records:
            zf.writestr(report_filename(r.get("user_name"), r["survey_run_id"]), render_report_pdf(report_content(r, tz_offset_min)))
    return buf.getvalue()


async def admin_export_reports(request: web.Request) -> web.Response:
    """?period=today|7|30|all&tz_offset=<minutes east of UTC> (e.g. 330 for Sri Lanka)."""
    period = request.query.get("period", "today")
    if period not in PERIODS:
        return web.json_response({"error": f"period must be one of {', '.join(PERIODS)}"}, status=400)
    try:
        tz_offset_min = int(request.query.get("tz_offset", "0"))
    except ValueError:
        return web.json_response({"error": "tz_offset must be an integer number of minutes"}, status=400)
    if not valid_offset(tz_offset_min):
        return web.json_response({"error": "tz_offset is out of range"}, status=400)

    now_utc = datetime.utcnow()
    records = await get_completed_reports(period_since(period, now_utc, tz_offset_min))
    if not records:
        return web.json_response({"error": "No completed reports in this period."}, status=404)

    # PDF rendering is CPU-bound — keep it off the event loop so live voice sessions
    # aren't stalled while a large period is exported.
    body = await asyncio.to_thread(_build_zip, records, tz_offset_min)
    logger.info("[Reports] Exported %d participant reports (period=%s)", len(records), period)
    return web.Response(
        body=body,
        content_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_filename(period, now_utc, tz_offset_min)}"'},
    )
