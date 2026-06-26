import logging
import uuid

import bcrypt
from aiohttp import web

from db import (
    create_user_session,
    delete_session,
    get_session_by_token,
    get_user_by_name,
)

logger = logging.getLogger("voicerag")

# Routes that do not require an authenticated session
_PUBLIC_PATHS = {"/login", "/logout", "/config", "/"}
_PUBLIC_PREFIXES = ("/static/", "/assets/")

# Paths under these prefixes require the "admin" role, not just a valid session.
# /admin/* is the admin namespace; /kb/chats is the Test Generator's chat API,
# which is an admin-only feature (its tab is hidden from guests in the UI).
_ADMIN_PREFIXES = ("/admin/", "/kb/chats")

SESSION_MAX_AGE = 4 * 3600  # 4 hours, matching RTMiddleTier TTL


@web.middleware
async def auth_middleware(request: web.Request, handler):
    path = request.path

    if path in _PUBLIC_PATHS or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return await handler(request)

    token = request.cookies.get("session_token")
    if not token:
        logger.warning("[Auth] 401 no cookie on %s %s", request.method, request.path)
        return web.json_response({"error": "Unauthorized"}, status=401)

    try:
        session = await get_session_by_token(token)
    except Exception as db_err:
        logger.error("[Auth] DB error looking up session on %s: %s", request.path, db_err)
        return web.json_response({"error": "Service unavailable"}, status=503)

    if not session:
        logger.warning("[Auth] 401 session not found (token=%s...) on %s %s",
                       token[:8], request.method, request.path)
        return web.json_response({"error": "Session expired"}, status=401)

    request["auth_session"] = session
    request["session_token"] = token

    # Role gate: admin-only paths reject a valid guest session with 403
    # (authenticated but not allowed), distinct from the 401s above.
    if any(path.startswith(p) for p in _ADMIN_PREFIXES) and session.get("role") != "admin":
        logger.warning("[Auth] 403 non-admin (role=%s) on %s %s",
                       session.get("role"), request.method, request.path)
        return web.json_response({"error": "Forbidden"}, status=403)

    return await handler(request)


async def login(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not name or not password:
        return web.json_response({"error": "Username and password required"}, status=400)

    user = await get_user_by_name(name)
    if not user or not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return web.json_response({"error": "Invalid credentials"}, status=401)

    session_token = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    await create_user_session(session_token, user["user_id"], session_id)

    logger.info("[Auth] User '%s' logged in (session_id=%s)", name, session_id)

    response = web.json_response({
        "ok": True,
        "user": {"user_id": user["user_id"], "name": user["name"], "role": user["role"]},
        "session_id": session_id,
    })
    response.set_cookie(
        "session_token",
        session_token,
        httponly=True,
        samesite="Lax",
        max_age=SESSION_MAX_AGE,
        path="/",
    )
    return response


async def logout(request: web.Request) -> web.Response:
    token = request.cookies.get("session_token")
    if token:
        await delete_session(token)
        logger.info("[Auth] Session %s deleted on logout", token[:8])
    response = web.json_response({"ok": True})
    response.del_cookie("session_token", path="/")
    return response


async def me(request: web.Request) -> web.Response:
    """Return the current authenticated user; 401 if not authenticated."""
    session = request.get("auth_session")
    if not session:
        return web.json_response({"error": "Unauthorized"}, status=401)
    return web.json_response({
        "user_id": session["user_id"],
        "session_id": session["session_id"],
        "role": session.get("role"),
    })
