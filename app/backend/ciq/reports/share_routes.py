"""QR report download: the participant confirms their username on the report
screen, gets a QR code, and downloads the PDF on their phone. Each report can be
downloaded ONCE (survey_records.report_download_count); after that the user can
ask an admin for one more (ciq/reports/download_request_routes.py).

1. POST /me/reports/{runId}/share {username, tz_offset}  (logged in) — checks the
   run is the caller's own completed run, that the username matches its owner, and
   that it hasn't been downloaded yet (409 otherwise), then returns a one-time
   token. A new token cancels the user's previous one. The username is a "confirm
   it's your report" step, not a secret — the login session is what authorises.
2. GET /report-share/{token}  (public) — a small page with a "Download report"
   button. Opening it does NOT use the token, so a phone camera app previewing
   the link in the background can't burn it.
3. POST /report-share/{token}/download  (public) — uses up the token, counts the
   report's one download (atomically, in the DB), then returns the PDF: the report as shown on screen after the assessment, stored by
   the browser (report_pdfs, ciq/reports/pdf_store_routes.py), or — for a run with
   no stored copy — the server-rendered text PDF (ciq/reports/pdf.py).

Tokens live in memory only: they last SHARE_TTL, and a restart just means
generating a new QR code. That relies on the single-replica deployment.
Read-only on the DB (SELECTs only), so it is safe alongside Litestream.
"""
import asyncio
import html
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from aiohttp import web

from ciq.reports.export import report_content, report_filename, valid_offset
from ciq.reports.pdf import render_report_pdf
from db import (
    get_completed_report,
    get_report_pdf,
    latest_download_request,
    mark_report_downloaded,
)

logger = logging.getLogger("voicerag")

SHARE_TTL = timedelta(minutes=5)
FAILED_WINDOW = timedelta(minutes=15)
MAX_FAILED_ATTEMPTS = 5

_NO_STORE = {"Cache-Control": "no-store"}


@dataclass
class _Share:
    run_id: str
    user_id: str
    tz_offset_min: int
    expires_at: datetime


_shares: dict[str, _Share] = {}             # token -> share
_active_token: dict[str, str] = {}          # user_id -> their current token
_failed_attempts: dict[str, list[datetime]] = {}  # user_id -> recent wrong usernames

ALREADY_DOWNLOADED = "Only one download is available for this report, and it has already been downloaded."


def _purge_expired(now: datetime) -> None:
    for token in [t for t, s in _shares.items() if s.expires_at <= now]:
        _drop(token)


def _drop(token: str) -> _Share | None:
    share = _shares.pop(token, None)
    if share and _active_token.get(share.user_id) == token:
        del _active_token[share.user_id]
    return share


def _recent_failures(user_id: str, now: datetime) -> list[datetime]:
    recent = [t for t in _failed_attempts.get(user_id, []) if t > now - FAILED_WINDOW]
    if recent:
        _failed_attempts[user_id] = recent
    else:
        _failed_attempts.pop(user_id, None)
    return recent


def _live_share(token: str, now: datetime) -> _Share | None:
    share = _shares.get(token)
    if share and share.expires_at <= now:
        _drop(token)
        return None
    return share


async def create_report_share(request: web.Request) -> web.Response:
    """POST /me/reports/{runId}/share {username, tz_offset}."""
    user_id = request["auth_session"]["user_id"]
    now = datetime.utcnow()
    if len(_recent_failures(user_id, now)) >= MAX_FAILED_ATTEMPTS:
        return web.json_response(
            {"error": "Too many wrong usernames. Please try again in 15 minutes."}, status=429
        )

    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "Invalid JSON"}, status=400)
    username = data.get("username").strip() if isinstance(data.get("username"), str) else ""
    if not username:
        return web.json_response({"error": "Username required"}, status=400)
    try:
        tz_offset_min = int(data.get("tz_offset", 0))
    except (TypeError, ValueError):
        return web.json_response({"error": "tz_offset must be an integer number of minutes"}, status=400)
    if not valid_offset(tz_offset_min):
        return web.json_response({"error": "tz_offset is out of range"}, status=400)

    # 404 (not 403) for someone else's run, so run ids can't be probed.
    record = await get_completed_report(request.match_info["runId"])
    if not record or record["user_id"] != user_id:
        return web.json_response({"error": "Report not found."}, status=404)

    # Case-insensitive, so "Emp1" vs "emp1" isn't a failure (names are unique anyway).
    if username.casefold() != (record.get("user_name") or "").casefold():
        _failed_attempts.setdefault(user_id, []).append(now)
        logger.warning("[ReportShare] username mismatch for user %s", user_id)
        # 403, not 401: the frontend treats any 401 as "session expired" and logs out.
        return web.json_response({"error": "Username doesn't match this report."}, status=403)
    _failed_attempts.pop(user_id, None)

    if record.get("report_download_count", 0) >= 1:
        req = await latest_download_request(record["survey_run_id"])
        return web.json_response(
            {
                "error": ALREADY_DOWNLOADED,
                "code": "already_downloaded",
                "request": {"status": req["status"]} if req else None,
            },
            status=409,
        )

    _purge_expired(now)
    previous = _active_token.get(user_id)
    if previous:
        _drop(previous)
    token = secrets.token_urlsafe(32)
    _shares[token] = _Share(record["survey_run_id"], user_id, tz_offset_min, now + SHARE_TTL)
    _active_token[user_id] = token

    logger.info("[ReportShare] QR link created for run %s", record["survey_run_id"][:8])
    return web.json_response(
        {
            "path": f"/report-share/{token}",
            "expiresInSeconds": int(SHARE_TTL.total_seconds()),
        },
        headers=_NO_STORE,
    )


def _page(title: str, body: str, status: int = 200) -> web.Response:
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{html.escape(title)}</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, sans-serif; background: #f4f4f8; color: #1f2937; }}
  main {{ margin: 16px; max-width: 420px; width: 100%; background: #fff; border-radius: 16px;
         padding: 28px 24px; box-shadow: 0 4px 20px rgba(0,0,0,.08); text-align: center; }}
  h1 {{ font-size: 1.25rem; margin: 0 0 8px; }}
  p {{ color: #4b5563; line-height: 1.5; margin: 8px 0; }}
  button {{ margin-top: 16px; width: 100%; padding: 14px; border: 0; border-radius: 12px; font-size: 1rem;
           font-weight: 600; color: #fff; background: linear-gradient(90deg, #7c3aed, #2563eb); }}
  button:disabled {{ opacity: .6; }}
  .note {{ font-size: .85rem; color: #6b7280; }}
</style></head>
<body><main>{body}</main></body></html>"""
    return web.Response(text=doc, content_type="text/html", status=status, headers=_NO_STORE)


def _used_page() -> web.Response:
    return _page(
        "Already downloaded",
        "<h1>Only one download is available</h1>"
        "<p>This report has already been downloaded.</p>"
        "<p class='note'>To get it again, go back to the report on the assessment screen, "
        "press Download PDF and choose &ldquo;Request another download&rdquo;. An admin "
        "will review your request.</p>",
        status=410,
    )


def _gone_page() -> web.Response:
    return _page(
        "Link no longer valid",
        "<h1>This link is no longer valid</h1>"
        "<p>It has already been used or has expired.</p>"
        "<p class='note'>Go back to the report on the assessment screen and press "
        "Download PDF to get a new QR code.</p>",
        status=410,
    )


async def report_share_page(request: web.Request) -> web.Response:
    """GET /report-share/{token} — the landing page. Does not use up the token."""
    token = request.match_info["token"]
    share = _live_share(token, datetime.utcnow())
    record = await get_completed_report(share.run_id) if share else None
    if not record:
        return _gone_page()
    if record.get("report_download_count", 0) >= 1:
        return _used_page()
    content = report_content(record, share.tz_offset_min)
    return _page(
        "Your CIQ report",
        f"<h1>Your {html.escape(content['surveyType'])} report</h1>"
        f"<p><strong>{html.escape(content['name'])}</strong></p>"
        f"<p>Completed {html.escape(content['completed'])}</p>"
        f"<form method='post' action='/report-share/{html.escape(token)}/download' "
        "onsubmit=\"this.querySelector('button').disabled=true\">"
        "<button type='submit'>Download report (PDF)</button></form>"
        "<p class='note'>Only one download is available for this report. "
        "After downloading, open the PDF from your Downloads.</p>",
    )


async def report_share_download(request: web.Request) -> web.Response:
    """POST /report-share/{token}/download — uses up the token, returns the PDF."""
    # Dropped before any await, so two quick taps can't both get the file.
    share = _live_share(request.match_info["token"], datetime.utcnow())
    if share:
        _drop(request.match_info["token"])
    record = await get_completed_report(share.run_id) if share else None
    if not record:
        return _gone_page()
    # The report's one download — counted before sending, atomically in the DB, so
    # it holds across QR codes, double taps and server restarts.
    if not await mark_report_downloaded(share.run_id):
        return _used_page()

    pdf = await get_report_pdf(share.run_id)
    source = "stored"
    if pdf is None:
        # PDF rendering is CPU-bound — keep it off the event loop (live voice sessions).
        pdf = await asyncio.to_thread(render_report_pdf, report_content(record, share.tz_offset_min))
        source = "server"
    logger.info("[ReportShare] QR link used for run %s (%s PDF)", share.run_id[:8], source)
    filename = report_filename(record.get("user_name"), record["survey_run_id"])
    return web.Response(
        body=pdf,
        content_type="application/pdf",
        headers={**_NO_STORE, "Content-Disposition": f'attachment; filename="{filename}"'},
    )
