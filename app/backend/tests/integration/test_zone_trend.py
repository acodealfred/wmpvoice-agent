"""Fatigue ↔ Burnout zone — GET /api/zone-trend (spec 2026-10-01 §6.1, §7)."""
import json

import aiohttp
import aiosqlite
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}
HIGH = {"bat_q1": 5, "bat_q2": 5, "bat_q3": 5, "bat_q4": 5, "cbi_q1": 100, "cbi_q2": 100, "cbi_q3": 0}


async def user_id(name: str) -> str:
    from db import get_user_by_name
    return (await get_user_by_name(name))["user_id"]


async def insert_run(uid, run_id, created_at, scores=None, survey_type="PILOT", raw=None):
    """Insert a survey_records row directly (the seeded DB has none)."""
    import db
    payload = raw if raw is not None else json.dumps(
        {q: {"score": s, "blinkRateChange": 0, "responseLatencyMs": None} for q, s in scores.items()}
    )
    async with aiosqlite.connect(db.DB_PATH) as conn:
        await conn.execute(
            """INSERT INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at, survey_results)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, uid, None, "s", survey_type, created_at, created_at, payload),
        )
        await conn.commit()


@pytest_asyncio.fixture
async def zone_client(initialized_db):
    from auth import auth_middleware, login
    from ciq.api.history_routes import user_zone_trend

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/api/zone-trend", user_zone_trend)
    async with TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
        yield client


async def _login(client, name):
    resp = await client.post("/login", json={"username": name, "password": "sys123"})
    assert resp.status == 200


async def test_zone_trend_requires_login(zone_client):
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 401


async def test_zone_trend_empty_for_new_user(zone_client):
    await _login(zone_client, "guest1")
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 200
    assert await resp.json() == {"latest": None, "trend": {"status": "none", "points": []}}


async def test_zone_trend_only_callers_runs(zone_client):
    g1, g2 = await user_id("guest1"), await user_id("guest2")
    await insert_run(g1, "g1-a", "2026-09-01T00:00:00", EXAMPLE)
    await insert_run(g1, "g1-b", "2026-09-02T00:00:00", EXAMPLE)
    await insert_run(g2, "g2-a", "2026-09-03T00:00:00", HIGH)

    await _login(zone_client, "guest1")
    body = await (await zone_client.get("/api/zone-trend")).json()
    assert [p["surveyRunId"] for p in body["trend"]["points"]] == ["g1-a", "g1-b"]
    assert body["latest"]["surveyRunId"] == "g1-b"
    assert body["trend"]["status"] == "steady"


async def test_zone_trend_ignores_user_id_in_query(zone_client):
    g2 = await user_id("guest2")
    await insert_run(g2, "g2-a", "2026-09-03T00:00:00", HIGH)
    await _login(zone_client, "guest1")
    body = await (await zone_client.get(f"/api/zone-trend?user_id={g2}")).json()
    assert body["latest"] is None


async def test_zone_trend_skips_non_pilot_and_bad_rows(zone_client):
    g1 = await user_id("guest1")
    await insert_run(g1, "ok", "2026-09-01T00:00:00", EXAMPLE)
    await insert_run(g1, "test", "2026-09-02T00:00:00", EXAMPLE, survey_type="TEST")
    await insert_run(g1, "blank", "2026-09-03T00:00:00", EXAMPLE, survey_type="")
    await insert_run(g1, "demo", "2026-09-04T00:00:00", raw="{}")
    await insert_run(g1, "broken", "2026-09-05T00:00:00", raw="not json")

    await _login(zone_client, "guest1")
    body = await (await zone_client.get("/api/zone-trend")).json()
    assert [p["surveyRunId"] for p in body["trend"]["points"]] == ["ok"]


async def test_zone_trend_500_when_pilot_config_missing(zone_client, monkeypatch):
    import survey_loader
    monkeypatch.setitem(survey_loader.SURVEY_MAP, "PILOT", "surveys/does-not-exist.json")
    await _login(zone_client, "guest1")
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 500
    assert await resp.json() == {"error": "zone unavailable"}
