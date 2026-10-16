"""GET /me/reports/{runId}/comparison (ciq/reports/comparison_routes.py) through auth."""
import json
import uuid
from datetime import datetime, timedelta

import aiohttp
import aiosqlite
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id

URL = "/me/reports/{}/comparison"


@pytest_asyncio.fixture
async def cmp_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.comparison_routes import me_report_comparison
    from db import create_user

    for name in ("emp1", "emp2"):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), "employee")
    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/me/reports/{runId}/comparison", me_report_comparison)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    assert (await client.post("/login", json={"username": username, "password": "sys123"})).status == 200
    return client


async def _seed(db_path, user_id, run_id, days_ago, bat, risk, survey_type="PILOT"):
    when = (datetime.utcnow() - timedelta(days=days_ago)).isoformat()
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records (survey_run_id, user_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')""",
            (run_id, user_id, survey_type, when, when,
             json.dumps({"bat_q1": {"score": 3}}),
             json.dumps({"sections": [{"id": "bat4", "label": "BAT-4", "score": bat,
                                       "scoreRange": [1, 5], "riskLevel": risk}]}),
             json.dumps({})),
        )
        await db.commit()


async def test_compares_each_run_with_the_one_before_it(cmp_app, initialized_db):
    uid = await seed_user_id("emp1")
    first, second, third = (str(uuid.uuid4()) for _ in range(3))
    await _seed(initialized_db, uid, first, 20, 4.0, "High")
    await _seed(initialized_db, uid, second, 10, 3.0, "Moderate")
    await _seed(initialized_db, uid, third, 0, 1.5, "Low")
    client = await _client(cmp_app, "emp1")
    try:
        latest = (await (await client.get(URL.format(third))).json())["comparison"]
        assert latest["previousRunId"] == second
        assert latest["measures"][0]["direction"] == "improved"
        # A report reopened from History compares with ITS predecessor.
        middle = (await (await client.get(URL.format(second))).json())["comparison"]
        assert middle["previousRunId"] == first
        assert (await (await client.get(URL.format(first))).json()) == {"comparison": None}
    finally:
        await client.close()


async def test_other_types_are_not_compared(cmp_app, initialized_db):
    uid = await seed_user_id("emp1")
    pilot, test_run = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed(initialized_db, uid, test_run, 5, 4.0, "High", survey_type="TEST")
    await _seed(initialized_db, uid, pilot, 0, 2.0, "Low")
    client = await _client(cmp_app, "emp1")
    try:
        assert (await (await client.get(URL.format(pilot))).json()) == {"comparison": None}
    finally:
        await client.close()


async def test_someone_elses_run_is_404(cmp_app, initialized_db):
    other = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp2"), other, 0, 2.0, "Low")
    client = await _client(cmp_app, "emp1")
    try:
        assert (await client.get(URL.format(other))).status == 404
    finally:
        await client.close()
