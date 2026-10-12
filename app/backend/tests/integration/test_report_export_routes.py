"""GET /admin/reports/export (ciq/reports/export_routes.py) through the auth middleware."""
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta

import aiohttp
import aiosqlite
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id

URL = "/admin/reports/export"


@pytest_asyncio.fixture
async def export_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.export_routes import admin_export_reports
    from db import create_user

    for name, role in (("emp1", "employee"), ("mgr1", "manager")):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), role)

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get(URL, admin_export_reports)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    resp = await client.post("/login", json={"username": username, "password": "sys123"})
    assert resp.status == 200
    return client


async def _seed(db_path, user_id, run_id, *, status="completed", is_demo=0, days_ago=0.0, data=True):
    when = (datetime.utcnow() - timedelta(days=days_ago)).isoformat()
    report = {"sections": [{"id": "bat4", "label": "BAT-4", "score": 3.0, "scoreRange": [1, 5],
                            "riskLevel": "Moderate", "interpretation": "BAT text."}]}
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records (survey_run_id, user_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info, status, is_demo)
               VALUES (?, ?, 'PILOT', ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, user_id, when, when,
             json.dumps({"bat_q1": {"score": 3}}) if data else None,
             json.dumps(report),
             json.dumps({"agentResponse": "You are doing well."}) if data else None,
             status, is_demo),
        )
        await db.commit()


async def _names(resp) -> set[str]:
    assert resp.status == 200
    assert resp.content_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(await resp.read())) as zf:
        names = set(zf.namelist())
        assert all(zf.read(n).startswith(b"%PDF") for n in names)
    return names


async def test_non_admins_are_forbidden(export_app):
    for name in ("emp1", "mgr1"):
        client = await _client(export_app, name)
        try:
            assert (await client.get(f"{URL}?period=all")).status == 403
        finally:
            await client.close()


async def test_periods_filter_completed_reports_only(export_app, initialized_db):
    uid = await seed_user_id("system1")
    await _seed(initialized_db, uid, "run-today")
    await _seed(initialized_db, uid, "run-10d", days_ago=10)
    await _seed(initialized_db, uid, "run-closed", status="closed")
    await _seed(initialized_db, uid, "run-demo", is_demo=1)
    await _seed(initialized_db, uid, "run-nodata", data=False)

    client = await _client(export_app, "system1")
    try:
        today = await client.get(f"{URL}?period=today&tz_offset=330")
        assert await _names(today) == {"system1_run-today.pdf"}
        assert "ciq_reports_today_" in today.headers["Content-Disposition"]

        assert await _names(await client.get(f"{URL}?period=7&tz_offset=330")) == {"system1_run-today.pdf"}
        assert await _names(await client.get(f"{URL}?period=30&tz_offset=330")) == {"system1_run-today.pdf", "system1_run-10d.pdf"}
        assert await _names(await client.get(f"{URL}?period=all")) == {"system1_run-today.pdf", "system1_run-10d.pdf"}
    finally:
        await client.close()


async def test_empty_period_and_bad_input(export_app):
    client = await _client(export_app, "system1")
    try:
        empty = await client.get(f"{URL}?period=today&tz_offset=330")
        assert empty.status == 404
        assert "No completed reports" in (await empty.json())["error"]
        assert (await client.get(f"{URL}?period=14")).status == 400
        assert (await client.get(f"{URL}?period=all&tz_offset=abc")).status == 400
        assert (await client.get(f"{URL}?period=all&tz_offset=9999")).status == 400
    finally:
        await client.close()
