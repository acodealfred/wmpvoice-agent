"""Forgot-password flow: login-page request → admin approval → timed reset.

1. POST /password-reset/request {username}  (public) — creates a pending request
   and returns {request_id, token}. The token is a secret only the requesting
   browser holds; only its sha256 is stored.
2. An admin sees it via GET /admin/password-resets and approves or denies it.
3. The browser polls POST /password-reset/status {request_id, token}.
4. Once approved, POST /password-reset/complete within APPROVAL_WINDOW sets the
   password and signs the user out everywhere. Missing the window means a new
   request (and a new approval).
"""
import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta

import bcrypt
from aiohttp import web

from db import (
    complete_password_reset,
    create_password_reset_request,
    decide_password_reset,
    get_password_reset_request,
    get_user_by_name,
    list_pending_password_resets,
)

logger = logging.getLogger("voicerag")

APPROVAL_WINDOW = timedelta(minutes=2)    # time to set the password once approved
PENDING_TTL = timedelta(minutes=15)       # unanswered requests expire after this
RATE_WINDOW = timedelta(minutes=15)
MAX_REQUESTS_PER_WINDOW = 3
MIN_PASSWORD_LENGTH = 8


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _effective_status(req: dict, now: datetime) -> str:
    """Stored status, with time-based expiry applied."""
    status = req["status"]
    if status == "pending" and req["created_at"] <= (now - PENDING_TTL).isoformat(timespec="microseconds"):
        return "expired"
    if status == "approved" and req["approved_until"] <= now.isoformat(timespec="microseconds"):
        return "expired"
    return status


async def _json_body(request: web.Request) -> dict | None:
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def _load_owned_request(data: dict) -> dict | None:
    """The request named in the body, only if the caller holds its token."""
    request_id = data.get("request_id")
    token = data.get("token")
    if not isinstance(request_id, str) or not isinstance(token, str):
        return None
    req = await get_password_reset_request(request_id)
    if not req or not hmac.compare_digest(req["token_hash"], _hash_token(token)):
        return None
    return req


async def request_password_reset(request: web.Request) -> web.Response:
    """POST /password-reset/request {username} — public."""
    data = await _json_body(request)
    if data is None:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    name = (data.get("username") or "").strip()
    if not name:
        return web.json_response({"error": "Username required"}, status=400)

    # Signup already reveals whether a username exists, so saying so here leaks nothing new.
    user = await get_user_by_name(name)
    if not user:
        return web.json_response({"error": "No account with that username."}, status=404)

    request_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(32)
    created = await create_password_reset_request(
        request_id, user["user_id"], _hash_token(token), datetime.utcnow(),
        RATE_WINDOW, MAX_REQUESTS_PER_WINDOW,
    )
    if not created:
        return web.json_response(
            {"error": "Too many reset requests. Please try again in 15 minutes."}, status=429
        )
    logger.info("[PasswordReset] request %s for user '%s'", request_id[:8], name)
    return web.json_response({"request_id": request_id, "token": token})


async def password_reset_status(request: web.Request) -> web.Response:
    """POST /password-reset/status {request_id, token} — public, polled by the login page."""
    data = await _json_body(request)
    if data is None:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    req = await _load_owned_request(data)
    if not req:
        return web.json_response({"error": "Request not found"}, status=404)

    now = datetime.utcnow()
    status = _effective_status(req, now)
    body = {"status": status}
    if status == "approved":
        until = datetime.fromisoformat(req["approved_until"])
        body["seconds_left"] = max(0, int((until - now).total_seconds()))
    return web.json_response(body)


async def complete_password_reset_route(request: web.Request) -> web.Response:
    """POST /password-reset/complete {request_id, token, new_password, confirm_password} — public."""
    data = await _json_body(request)
    if data is None:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    req = await _load_owned_request(data)
    if not req:
        return web.json_response({"error": "Request not found"}, status=404)

    # Stripped to match /login, which strips the password it checks.
    new_password = (data.get("new_password") or "").strip()
    confirm = (data.get("confirm_password") or "").strip()
    if len(new_password) < MIN_PASSWORD_LENGTH:
        return web.json_response(
            {"error": f"Password must be at least {MIN_PASSWORD_LENGTH} characters."}, status=400
        )
    if new_password != confirm:
        return web.json_response({"error": "Passwords do not match."}, status=400)

    password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    if not await complete_password_reset(req["request_id"], password_hash, datetime.utcnow()):
        return web.json_response(
            {"error": "This reset is no longer approved. Please request a new one."}, status=409
        )
    logger.info("[PasswordReset] request %s completed", req["request_id"][:8])
    return web.json_response({"ok": True})


async def admin_list_password_resets(request: web.Request) -> web.Response:
    """GET /admin/password-resets — pending, unexpired requests."""
    rows = await list_pending_password_resets(datetime.utcnow() - PENDING_TTL)
    return web.json_response({"requests": rows})


async def _decide(request: web.Request, approve: bool) -> web.Response:
    request_id = request.match_info["requestId"]
    admin_id = request["auth_session"]["user_id"]
    now = datetime.utcnow()
    ok = await decide_password_reset(
        request_id, admin_id, approve, now, now - PENDING_TTL, APPROVAL_WINDOW
    )
    if not ok:
        return web.json_response(
            {"error": "Request is no longer pending (expired, cancelled or already decided)."},
            status=409,
        )
    logger.info("[PasswordReset] request %s %s by admin %s",
                request_id[:8], "approved" if approve else "denied", admin_id)
    return web.json_response({"ok": True})


async def admin_approve_password_reset(request: web.Request) -> web.Response:
    """POST /admin/password-resets/{requestId}/approve"""
    return await _decide(request, approve=True)


async def admin_deny_password_reset(request: web.Request) -> web.Response:
    """POST /admin/password-resets/{requestId}/deny"""
    return await _decide(request, approve=False)
