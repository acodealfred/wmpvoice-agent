"""Fatigue ↔ Burnout zone — GET /api/zone-trend (spec 2026-10-01 §6.1, §7)."""
import aiohttp
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

# tests/integration is on sys.path under pytest's default prepend import mode.
from zone_helpers import EXAMPLE, HIGH, insert_run, user_id


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
