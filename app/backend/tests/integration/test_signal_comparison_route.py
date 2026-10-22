"""GET /me/reports/{runId}/signal-comparison (ciq/reports/signal_comparison_routes.py) through auth."""
import json
import logging
import uuid
from datetime import datetime, timedelta

import aiohttp
import aiosqlite
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id

URL = "/me/reports/{}/signal-comparison"


@pytest_asyncio.fixture
async def sig_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.signal_comparison_routes import me_signal_comparison
    from db import create_user

    for name in ("emp1", "emp2"):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), "employee")
    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/me/reports/{runId}/signal-comparison", me_signal_comparison)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    assert (await client.post("/login", json={"username": username, "password": "sys123"})).status == 200
    return client


async def _seed_run(db_path, user_id, run_id, days_ago, *, answer, latency_ms, blink_pct, survey_type="PILOT"):
    """A completed, scored run with one bat_q1 item row and three answering frames."""
    when = (datetime.utcnow() - timedelta(days=days_ago)).isoformat()
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records (survey_run_id, user_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')""",
            (run_id, user_id, survey_type, when, when,
             json.dumps({"bat_q1": {"score": answer}}),
             json.dumps({"sections": [{"id": "bat4", "label": "BAT-4", "score": 3.0,
                                       "scoreRange": [1, 5], "riskLevel": "Moderate"}]}),
             json.dumps({})),
        )
        await db.execute(
            """INSERT INTO survey_item_responses (survey_run_id, user_id, question_id, raw_score,
                   effective_score, voice_sentiment, response_latency_ms, created_at)
               VALUES (?, ?, 'bat_q1', ?, ?, 'neutral', ?, ?)""",
            (run_id, user_id, answer, answer, latency_ms, when),
        )
        for i in range(3):
            await db.execute(
                """INSERT INTO survey_timeline_frames (survey_run_id, user_id, frame_index, timestamp,
                       turn_state, question_id, blink_rate_change_percent, created_at)
                   VALUES (?, ?, ?, ?, 'user_answer', 'bat_q1', ?, ?)""",
                (run_id, user_id, i, when, blink_pct, when),
            )
        await db.commit()


async def test_route_returns_comparison_for_own_run(sig_app, initialized_db):
    uid = await seed_user_id("emp1")
    before, now = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed_run(initialized_db, uid, before, 7, answer=2, latency_ms=2400, blink_pct=-3.0)
    await _seed_run(initialized_db, uid, now, 0, answer=4, latency_ms=900, blink_pct=22.0)
    client = await _client(sig_app, "emp1")
    try:
        resp = await client.get(URL.format(now))
        assert resp.status == 200
        body = (await resp.json())["signalComparison"]
        assert body["surveyRunId"] == now
        assert body["referenceRunIds"] == [before]
        assert body["referenceCount"] == 1 and body["daysSinceLatest"] == 7 and body["tier"] == "fixed"
        # Every PILOT question, in survey order; only bat_q1 has readings in this seed.
        assert [x["questionId"] for x in body["questions"]] == [
            "bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]
        assert [x["status"] for x in body["questions"]] == ["changed"] + ["no_data"] * 6
        q = body["questions"][0]
        assert q["questionId"] == "bat_q1" and q["prompt"] == "At work, I feel mentally exhausted."
        assert q["answer"] == {"previousLabel": "Rarely", "currentLabel": "Often",
                               "previousValue": 2, "currentValue": 4, "changed": True}
        assert q["surfacedBy"] == "strong"
        assert [s["id"] for s in q["signals"]] == ["blink", "latency"]
        assert q["signals"][1]["direction"] == "shorter" and q["signals"][1]["tier"] == "strong"
    finally:
        await client.close()


async def test_route_404_for_other_users_run(sig_app, initialized_db):
    other = await seed_user_id("emp2")
    run = str(uuid.uuid4())
    await _seed_run(initialized_db, other, run, 0, answer=3, latency_ms=2000, blink_pct=0.0)
    client = await _client(sig_app, "emp1")
    try:
        resp = await client.get(URL.format(run))
        assert resp.status == 404
        assert await resp.json() == {"error": "Report not found."}
    finally:
        await client.close()


async def test_route_null_on_first_run(sig_app, initialized_db):
    uid = await seed_user_id("emp1")
    run = str(uuid.uuid4())
    await _seed_run(initialized_db, uid, run, 0, answer=3, latency_ms=2000, blink_pct=0.0)
    client = await _client(sig_app, "emp1")
    try:
        assert await (await client.get(URL.format(run))).json() == {"signalComparison": None}
    finally:
        await client.close()


async def test_route_null_on_exception(sig_app, initialized_db, monkeypatch, caplog):
    import ciq.reports.signal_comparison_routes as routes

    async def boom(_run_id):
        raise RuntimeError("frames unavailable")

    monkeypatch.setattr(routes, "get_survey_timeline_frames", boom)
    uid = await seed_user_id("emp1")
    before, now = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed_run(initialized_db, uid, before, 7, answer=2, latency_ms=2400, blink_pct=-3.0)
    await _seed_run(initialized_db, uid, now, 0, answer=4, latency_ms=900, blink_pct=22.0)
    client = await _client(sig_app, "emp1")
    try:
        with caplog.at_level(logging.ERROR, logger="voicerag"):
            resp = await client.get(URL.format(now))
        assert resp.status == 200
        assert await resp.json() == {"signalComparison": None}
        assert "[Signals]" in caplog.text
    finally:
        await client.close()


async def test_route_null_when_switched_off(sig_app, initialized_db, monkeypatch):
    monkeypatch.setenv("ENABLE_SIGNAL_COMPARISON", "false")
    uid = await seed_user_id("emp1")
    before, now = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed_run(initialized_db, uid, before, 7, answer=2, latency_ms=2400, blink_pct=-3.0)
    await _seed_run(initialized_db, uid, now, 0, answer=4, latency_ms=900, blink_pct=22.0)
    client = await _client(sig_app, "emp1")
    try:
        assert await (await client.get(URL.format(now))).json() == {"signalComparison": None}
    finally:
        await client.close()


async def test_route_requires_auth(sig_app):
    client = TestClient(TestServer(sig_app))
    await client.start_server()
    try:
        resp = await client.get(URL.format("any-run"), allow_redirects=False)
        assert resp.status in (401, 302, 303)
    finally:
        await client.close()
