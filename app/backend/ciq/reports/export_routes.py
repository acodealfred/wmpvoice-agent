"""GET /admin/reports/export — every completed participant report in a period, as a
ZIP of PDFs (one per run, named <user_name>_<survey_run_id>.pdf). Each PDF is the
same file the participant's QR download serves: the on-screen report captured in
their browser (report_pdfs, ciq/reports/pdf_store_routes.py), or — for a run with
no stored copy — the server-rendered text PDF (ciq/reports/pdf.py). Read-only: only
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
from db import get_completed_reports, get_report_pdf

logger = logging.getLogger("voicerag")


def _build_zip(records: list[dict], stored_pdfs: dict[str, bytes], tz_offset_min: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in records:
            pdf = stored_pdfs.get(r["survey_run_id"]) or render_report_pdf(report_content(r, tz_offset_min))
            zf.writestr(report_filename(r.get("user_name"), r["survey_run_id"]), pdf)
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

    stored_pdfs = {}
    for r in records:
        pdf = await get_report_pdf(r["survey_run_id"])
        if pdf is not None:
            stored_pdfs[r["survey_run_id"]] = pdf

    # PDF rendering is CPU-bound — keep it off the event loop so live voice sessions
    # aren't stalled while a large period is exported.
    body = await asyncio.to_thread(_build_zip, records, stored_pdfs, tz_offset_min)
    logger.info("[Reports] Exported %d participant reports (period=%s, %d stored on-screen PDFs)",
                len(records), period, len(stored_pdfs))
    return web.Response(
        body=body,
        content_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_filename(period, now_utc, tz_offset_min)}"'},
    )
