"""'Request another download' for a report that has used its one QR download
(survey_records.report_download_count — see ciq/reports/share_routes.py).

1. POST /me/reports/{runId}/download-request  (owner) — adds a pending request; a
   run already waiting keeps its one pending request.
2. GET /admin/download-requests — pending requests, shown as a notification at the
   top of the Admin panel (like password resets).
3. POST /admin/download-requests/{requestId}/approve|deny — approving resets the
   run's download count to 0, so the user can get a QR code and download once more.

/admin/* is admin-only via auth_middleware.
"""
import logging
import uuid

from aiohttp import web

from db import (
    create_download_request,
    decide_download_request,
    get_completed_report,
    latest_download_request,
    list_pending_download_requests,
)

logger = logging.getLogger("voicerag")


async def request_another_download(request: web.Request) -> web.Response:
    """POST /me/reports/{runId}/download-request"""
    user_id = request["auth_session"]["user_id"]
    # 404 (not 403) for someone else's run, so run ids can't be probed.
    record = await get_completed_report(request.match_info["runId"])
    if not record or record["user_id"] != user_id:
        return web.json_response({"error": "Report not found."}, status=404)
    if record.get("report_download_count", 0) < 1:
        return web.json_response({"error": "This report can be downloaded now — no request needed."}, status=409)

    await create_download_request(str(uuid.uuid4()), record["survey_run_id"], user_id)
    req = await latest_download_request(record["survey_run_id"])
    logger.info("[ReportDownload] another download requested for run %s", record["survey_run_id"][:8])
    return web.json_response({"status": req["status"] if req else "pending"})


async def admin_list_download_requests(request: web.Request) -> web.Response:
    """GET /admin/download-requests"""
    return web.json_response({"requests": await list_pending_download_requests()})


async def _decide(request: web.Request, approve: bool) -> web.Response:
    request_id = request.match_info["requestId"]
    admin_id = request["auth_session"]["user_id"]
    if not await decide_download_request(request_id, admin_id, approve):
        return web.json_response({"error": "Request is no longer pending (already decided)."}, status=409)
    logger.info("[ReportDownload] request %s %s by admin %s",
                request_id[:8], "approved" if approve else "denied", admin_id)
    return web.json_response({"ok": True})


async def admin_approve_download_request(request: web.Request) -> web.Response:
    """POST /admin/download-requests/{requestId}/approve"""
    return await _decide(request, approve=True)


async def admin_deny_download_request(request: web.Request) -> web.Response:
    """POST /admin/download-requests/{requestId}/deny"""
    return await _decide(request, approve=False)
