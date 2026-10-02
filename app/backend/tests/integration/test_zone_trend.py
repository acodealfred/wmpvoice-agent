"""Fatigue ↔ Burnout zone — GET /api/zone-trend and the get_my_zone_trend chat tool."""
import json

import aiohttp
import aiosqlite
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

_IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]


def _results(bat: int, cbi: int) -> dict:
    """All BAT items = `bat`, all CBI items = `cbi` (raw answers)."""
    return {
        qid: {"score": bat if qid.startswith("bat_") else cbi, "blinkRateChange": 0, "responseLatencyMs": None}
        for qid in _IDS
    }


async def _user_id(name: str) -> str:
    from db import get_user_by_name

    return (await get_user_by_name(name))["user_id"]


async def _insert_run(db_path, run_id, user_id, created_at, results, *, survey_type="PILOT", status="completed"):
    if results is not None and not isinstance(results, str):
        results = json.dumps(results)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records
               (survey_run_id, user_id, survey_type, created_at, updated_at, survey_results, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (run_id, user_id, survey_type, created_at, created_at, results, status),
        )
        await db.commit()


class StubRtmt:
    """Just the RTMiddleTier surface /analyze-report touches, with the PILOT config."""

    def __init__(self, survey_config):
        self._survey_config = survey_config

    def get_survey_config_for_session(self, session_id):
        return self._survey_config

    def set_conversation_state_for_session(self, session_id, state, report_context=None):
        pass

    async def await_answer_transcripts(self, session_id, timeout_s=3.0):
        return None

    def get_answer_transcripts(self, session_id):
        return {}

    def get_timeline_frames_for_session(self, session_id):
        return []

    async def await_post_behaviour_capture(self, session_id, timeout_s=11.0):
        return None

    def get_behaviour_snapshots_for_session(self, session_id):
        return {}


@pytest_asyncio.fixture
async def zone_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.api.history_routes import user_zone_trend
    from ciq.reports.routes import analyze_report
    from survey_loader import load_survey

    app = web.Application(middlewares=[auth_middleware])
    app["rtmt"] = StubRtmt(load_survey("PILOT"))
    app.router.add_post("/login", login)
    app.router.add_get("/api/zone-trend", user_zone_trend)
    app.router.add_post("/analyze-report", analyze_report)
    return app


async def _client(app, username=None):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    if username:
        resp = await client.post("/login", json={"username": username, "password": "sys123"})
        assert resp.status == 200
    return client


# ── GET /api/zone-trend ──────────────────────────────────────────────────────

async def test_requires_auth(zone_app):
    client = await _client(zone_app)
    try:
        resp = await client.get("/api/zone-trend")
        assert resp.status == 401
    finally:
        await client.close()


async def test_empty_state(zone_app):
    client = await _client(zone_app, "guest1")
    try:
        resp = await client.get("/api/zone-trend")
        assert resp.status == 200
        assert await resp.json() == {"latest": None, "trend": {"status": "none", "points": []}}
    finally:
        await client.close()


async def test_returns_only_the_callers_runs_and_filters_rows(zone_app, initialized_db):
    g1, g2 = await _user_id("guest1"), await _user_id("guest2")
    await _insert_run(initialized_db, "g1-a", g1, "2026-09-01T09:00:00", _results(2, 25))
    await _insert_run(initialized_db, "g1-b", g1, "2026-09-08T09:00:00", _results(4, 75))
    await _insert_run(initialized_db, "g2-a", g2, "2026-09-09T09:00:00", _results(5, 100))
    # Ignored for guest1: other survey types, blank results, bad JSON, unfinished runs.
    await _insert_run(initialized_db, "g1-test", g1, "2026-09-10T09:00:00", _results(4, 75), survey_type="TEST")
    await _insert_run(initialized_db, "g1-blank", g1, "2026-09-11T09:00:00", _results(4, 75), survey_type="")
    await _insert_run(initialized_db, "g1-empty", g1, "2026-09-12T09:00:00", "{}")
    await _insert_run(initialized_db, "g1-bad", g1, "2026-09-13T09:00:00", "{oops")
    await _insert_run(initialized_db, "g1-paused", g1, "2026-09-14T09:00:00", _results(1, 0), status="paused")

    client = await _client(zone_app, "guest1")
    try:
        resp = await client.get("/api/zone-trend")
        assert resp.status == 200
        body = await resp.json()
    finally:
        await client.close()

    assert [p["surveyRunId"] for p in body["trend"]["points"]] == ["g1-a", "g1-b"]
    assert body["latest"]["surveyRunId"] == "g1-b"
    assert body["latest"]["date"] == "2026-09-08"
    assert body["trend"]["status"] == "worsening"
    assert body["trend"]["compared"] == 1


async def test_bad_pilot_config_returns_500(zone_app, monkeypatch):
    import ciq.api.history_routes as history_routes
    from survey_loader import load_survey

    # A missing PILOT file makes load_survey fall back to TEST silently.
    monkeypatch.setattr(history_routes, "load_survey", lambda _type: load_survey("TEST"))
    client = await _client(zone_app, "guest1")
    try:
        resp = await client.get("/api/zone-trend")
        assert resp.status == 500
        assert await resp.json() == {"error": "zone unavailable"}
    finally:
        await client.close()


async def test_report_run_is_latest_right_after_analyze_report(zone_app, initialized_db):
    """The report page fetches the zone after /analyze-report — the run must be there."""
    g1 = await _user_id("guest1")
    await _insert_run(initialized_db, "live-run", g1, "2026-09-20T09:00:00", None, status="active")
    snapshots = [
        {"questionId": qid, "score": 4 if qid.startswith("bat_") else 75, "domain": "x"} for qid in _IDS
    ]

    client = await _client(zone_app, "guest1")
    try:
        resp = await client.post("/analyze-report", json={
            "session_id": "s1", "survey_run_id": "live-run", "survey_type": "PILOT", "snapshots": snapshots,
        })
        assert resp.status == 200
        resp = await client.get("/api/zone-trend")
        body = await resp.json()
    finally:
        await client.close()

    assert body["latest"]["surveyRunId"] == "live-run"
    assert body["trend"]["status"] == "first"


# ── Chat tool ────────────────────────────────────────────────────────────────

def test_tool_is_offered_and_prompted():
    from ciq.chat.prompts import GUEST_SYSTEM_PROMPT
    from ciq.chat.tools import GUEST_TOOL_SCHEMAS, MANAGER_TOOL_SCHEMAS

    assert "get_my_zone_trend" in [t["function"]["name"] for t in GUEST_TOOL_SCHEMAS]
    assert "get_my_zone_trend" not in [t["function"]["name"] for t in MANAGER_TOOL_SCHEMAS]
    assert "get_my_zone_trend" in GUEST_SYSTEM_PROMPT


async def test_tool_returns_only_the_callers_data(initialized_db):
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    g1, g2 = await _user_id("guest1"), await _user_id("guest2")
    await _insert_run(initialized_db, "g1-a", g1, "2026-09-01T09:00:00", _results(3, 50))
    await _insert_run(initialized_db, "g2-a", g2, "2026-09-02T09:00:00", _results(5, 100))

    result, citations = await dispatch_tool(
        "get_my_zone_trend", {"user_id": g2}, ChatAuth(user_id=g1, role="employee", scope="personal"),
    )
    assert citations == []
    assert result["latest"]["surveyRunId"] == "g1-a"
    assert [p["surveyRunId"] for p in result["trend"]["points"]] == ["g1-a"]
    assert "not a diagnosis" in result["note"]


async def test_tool_denied_on_manager_scope(initialized_db):
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    g1 = await _user_id("guest1")
    result, _ = await dispatch_tool(
        "get_my_zone_trend", {}, ChatAuth(user_id=g1, role="manager", scope="manager"),
    )
    assert "error" in result and "latest" not in result


async def test_tool_reports_unavailable_on_bad_config(initialized_db, monkeypatch):
    import ciq.chat.tools as tools
    from ciq.chat.rbac import ChatAuth
    from survey_loader import load_survey

    monkeypatch.setattr(tools, "load_survey", lambda _type: load_survey("TEST"))
    g1 = await _user_id("guest1")
    result, _ = await tools.dispatch_tool(
        "get_my_zone_trend", {}, ChatAuth(user_id=g1, role="employee", scope="personal"),
    )
    assert result == {"error": "zone unavailable"}
