"""Admin Live Monitor endpoints (ciq/monitoring/__init__.py).

Read in-memory session state only — no DB writes, no session creation, nothing that
touches a running assessment. Admin-only via auth_middleware (every /admin/* route).
"""
import logging
import time

from aiohttp import web

from ciq.config import live_monitor_enabled
from ciq.monitoring.live import is_live, summarize
from db import get_user_names

logger = logging.getLogger("voicerag")


def _rtmt(request: web.Request):
    return request.app.get("rtmt")


async def _names(user_ids) -> dict:
    try:
        return await get_user_names(list(user_ids))
    except Exception as e:  # a name is a nicety; the monitor must still answer
        logger.warning("[Monitor] user name lookup failed: %s", e)
        return {}


async def admin_monitor_sessions(request: web.Request) -> web.Response:
    """GET /admin/monitor/sessions — every running assessment, problems first."""
    rtmt = _rtmt(request)
    if not live_monitor_enabled() or rtmt is None:
        return web.json_response({"enabled": False, "sessions": []})
    now = time.time()
    live = [s for s in rtmt.sessions.all() if is_live(s, now)]
    names = await _names(s.user_id for s in live)
    views = [summarize(s, now, names.get(s.user_id)) for s in live]
    order = {"bad": 0, "warn": 1, "ok": 2, "off": 3}
    views.sort(key=lambda v: (order.get(v["overall"], 3), -(v["startedAt"] or 0)))
    return web.json_response({"enabled": True, "serverTime": now, "sessions": views})


async def admin_monitor_session(request: web.Request) -> web.Response:
    """GET /admin/monitor/sessions/{sessionId} — one session with its ~2-minute history."""
    rtmt = _rtmt(request)
    if not live_monitor_enabled() or rtmt is None:
        return web.json_response({"error": "Live monitor is disabled"}, status=404)
    sess = rtmt.sessions.peek(request.match_info["sessionId"])
    if sess is None or not sess.survey_run_id:
        return web.json_response({"error": "No such live session"}, status=404)
    names = await _names([sess.user_id])
    now = time.time()
    return web.json_response({"serverTime": now, "session": summarize(sess, now, names.get(sess.user_id), detail=True)})
