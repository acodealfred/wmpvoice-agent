"""GET /me/reports/{runId} and GET /admin/reports/runs/{runId}
(ciq/reports/saved_routes.py) through the auth middleware."""
import json
import uuid
from datetime import datetime

import aiohttp
import aiosqlite
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id

ME = "/me/reports/{}"
ADMIN = "/admin/reports/runs/{}"


@pytest_asyncio.fixture
async def saved_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.saved_routes import admin_saved_report, me_saved_report
    from db import create_user

    for name, role in (("emp1", "employee"), ("emp2", "employee"), ("mgr1", "manager")):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), role)

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/me/reports/{runId}", me_saved_report)
    app.router.add_get("/admin/reports/runs/{runId}", admin_saved_report)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    resp = await client.post("/login", json={"username": username, "password": "sys123"})
    assert resp.status == 200
    return client


async def _seed(db_path, user_id, run_id, *, status="completed"):
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records (survey_run_id, user_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info, status)
               VALUES (?, ?, 'TEST', ?, ?, ?, ?, ?, ?)""",
            (run_id, user_id, now, now,
             json.dumps({"q1": {"score": 4, "domain": "Exhaustion"}}),
             json.dumps({"analysis": {"patterns": [{"insight": "x"}]}, "totalScore": 4, "riskLevel": "Low",
                         "interpretation": "Low.", "domainTotals": {"Exhaustion": 4}}),
             json.dumps({"agentResponse": "summary"}),
             status),
        )
        await db.commit()


async def test_employee_gets_only_their_own_completed_report(saved_app, initialized_db):
    await _seed(initialized_db, await seed_user_id("emp1"), "run-own")
    await _seed(initialized_db, await seed_user_id("emp1"), "run-paused", status="paused")
    await _seed(initialized_db, await seed_user_id("emp2"), "run-other")

    client = await _client(saved_app, "emp1")
    try:
        resp = await client.get(ME.format("run-own"))
        assert resp.status == 200
        body = await resp.json()
        assert body["surveyRunId"] == "run-own"
        assert body["snapshots"] == [{"questionId": "q1", "score": 4, "domain": "Exhaustion"}]
        assert body["report"]["maxScore"] == 5
        assert "analysis" not in body["report"]

        for run_id in ("run-other", "run-paused", "no-such-run"):
            assert (await client.get(ME.format(run_id))).status == 404
    finally:
        await client.close()


async def test_admin_route_is_admin_only(saved_app, initialized_db):
    await _seed(initialized_db, await seed_user_id("emp1"), "run-emp")

    for name in ("emp1", "mgr1"):
        client = await _client(saved_app, name)
        try:
            assert (await client.get(ADMIN.format("run-emp"))).status == 403
        finally:
            await client.close()

    client = await _client(saved_app, "system1")
    try:
        resp = await client.get(ADMIN.format("run-emp"))
        assert resp.status == 200
        assert (await resp.json())["surveyRunId"] == "run-emp"
        assert (await client.get(ADMIN.format("no-such-run"))).status == 404
    finally:
        await client.close()
