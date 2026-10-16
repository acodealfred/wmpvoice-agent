"""POST /me/reports/{runId}/pdf — store the report as it was shown on screen after
the assessment (charts + scores), captured in the participant's browser as a
light-theme PDF (frontend lib/report-pdf.ts). The QR download
(ciq/reports/share_routes.py) serves it; survey_records is untouched.

Body: the raw PDF (Content-Type: application/pdf). Only the logged-in owner of a
completed run may upload, once — a later upload is ignored.
"""
import logging

from aiohttp import web

from db import get_completed_report, save_report_pdf

logger = logging.getLogger("voicerag")

# aiohttp's default body limit is 1 MiB; a captured report is typically 0.5-1 MB
# (JPEG pages). Raised for this route only, like the EEG upload (ciq/eeg/routes.py).
MAX_PDF_BYTES = 3 * 1024 * 1024


async def upload_report_pdf(request: web.Request) -> web.Response:
    """POST /me/reports/{runId}/pdf"""
    # 404 (not 403) for someone else's run, so run ids can't be probed.
    record = await get_completed_report(request.match_info["runId"])
    if not record or record["user_id"] != request["auth_session"]["user_id"]:
        return web.json_response({"error": "Report not found."}, status=404)

    if request.content_length is not None and request.content_length > MAX_PDF_BYTES:
        return web.json_response({"error": "PDF is too large."}, status=413)
    try:
        pdf = await request.clone(client_max_size=MAX_PDF_BYTES).read()
    except web.HTTPRequestEntityTooLarge:
        return web.json_response({"error": "PDF is too large."}, status=413)
    if not pdf.startswith(b"%PDF-"):
        return web.json_response({"error": "Not a PDF."}, status=400)

    stored = await save_report_pdf(record["survey_run_id"], pdf)
    if stored:
        logger.info("[ReportPDF] stored %d KB for run %s", len(pdf) // 1024, record["survey_run_id"][:8])
    return web.json_response({"stored": stored})
