"""/admin/monitor/* (ciq/monitoring/routes.py) through the auth middleware."""
import time
import uuid

import aiohttp
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id


@pytest_asyncio.fixture
async def monitor_app(initialized_db, live_rtmt):
    from auth import auth_middleware, login
    from ciq.monitoring.routes import admin_monitor_session, admin_monitor_sessions
    from db import create_user

    for name, role in (("emp1", "employee"), ("mgr1", "manager")):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), role)

    live_rtmt.sessions = live_rtmt._store  # RTMiddleTier.sessions
    app = web.Application(middlewares=[auth_middleware])
    app["rtmt"] = live_rtmt
    app.router.add_post("/login", login)
    app.router.add_get("/admin/monitor/sessions", admin_monitor_sessions)
    app.router.add_get("/admin/monitor/sessions/{sessionId}", admin_monitor_session)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    resp = await client.post("/login", json={"username": username, "password": "sys123"})
    assert resp.status == 200
    return client


async def _live_session(rtmt, user_id):
    from ciq.monitoring.live import record_tick

    sess = rtmt.get_or_create_session("sess-live")
    sess.survey_run_id = "run-live"
    sess.user_id = user_id
    sess.survey_config = {"type": "PILOT", "questions": [{}] * 3}
    sess.open_ws_count = 1
    tick = {"eeg": {"status": "disconnected", "expected": True}, "camera": {"enabled": False}}
    record_tick(sess, tick, 200, now=time.time())
    rtmt.get_or_create_session("sess-idle")  # never bound to a run → not listed
    return sess


async def test_admin_sees_live_sessions_with_issues(monitor_app, live_rtmt):
    user = await seed_user_id("emp1")
    await _live_session(live_rtmt, user)
    client = await _client(monitor_app, "system1")
    try:
        body = await (await client.get("/admin/monitor/sessions")).json()
        assert body["enabled"] is True
        (view,) = body["sessions"]
        assert (view["sessionId"], view["userName"], view["overall"]) == ("sess-live", "emp1", "bad")
        assert "EEG headband disconnected" in view["issues"]

        detail = await client.get("/admin/monitor/sessions/sess-live")
        assert detail.status == 200
        assert len((await detail.json())["session"]["history"]) == 1
        assert (await client.get("/admin/monitor/sessions/sess-idle")).status == 404
        assert (await client.get("/admin/monitor/sessions/nope")).status == 404
    finally:
        await client.close()
    # Reading the monitor never creates sessions.
    assert {s.session_id for s in live_rtmt.sessions.all()} == {"sess-live", "sess-idle"}


async def test_managers_and_employees_are_refused(monitor_app):
    for name in ("mgr1", "emp1"):
        client = await _client(monitor_app, name)
        try:
            assert (await client.get("/admin/monitor/sessions")).status == 403
            assert (await client.get("/admin/monitor/sessions/x")).status == 403
        finally:
            await client.close()


async def test_disabled_monitor_lists_nothing(monitor_app, monkeypatch):
    monkeypatch.setenv("ENABLE_LIVE_MONITOR", "false")
    client = await _client(monitor_app, "system1")
    try:
        assert await (await client.get("/admin/monitor/sessions")).json() == {"enabled": False, "sessions": []}
    finally:
        await client.close()
