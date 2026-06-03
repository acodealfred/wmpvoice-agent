import asyncio
import logging
import uuid

import bcrypt
from aiohttp import web

from db import (
    create_user_session,
    delete_session,
    get_session_by_token,
    get_user_by_name,
    update_session_activity,
)

logger = logging.getLogger("voicerag")

# Routes that do not require an authenticated session
_PUBLIC_PATHS = {"/login", "/logout", "/config", "/"}
_PUBLIC_PREFIXES = ("/static/", "/assets/")

SESSION_MAX_AGE = 4 * 3600  # 4 hours, matching RTMiddleTier TTL


@web.middleware
async def auth_middleware(request: web.Request, handler):
    path = request.path

    if path in _PUBLIC_PATHS or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return await handler(request)

    token = request.cookies.get("session_token")
    if not token:
        return web.json_response({"error": "Unauthorized"}, status=401)

    session = await get_session_by_token(token)
    if not session:
        return web.json_response({"error": "Session expired"}, status=401)

    request["auth_session"] = session
    request["session_token"] = token
    # Fire-and-forget — don't block the request on a DB write
    asyncio.ensure_future(update_session_activity(token))

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
        "user": {"user_id": user["user_id"], "name": user["name"]},
        "session_id": session_id,
    })
    response.set_cookie(
        "session_token",
        session_token,
        httponly=True,
        samesite="Strict",
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
    })
