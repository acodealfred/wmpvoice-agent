"""BE-C3 — Deterministic report /analyze-report (no LLM)."""
import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


class StubRtmt:
    """Minimal stand-in for RTMiddleTier — only what analyze_report touches."""
    def __init__(self, survey_config):
        self._survey_config = survey_config
        self.states = {}

    def set_conversation_state_for_session(self, session_id, state, report_context=None):
        self.states[session_id] = (state, report_context)


@pytest_asyncio.fixture
async def report_client(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.routes import analyze_report
    from survey_loader import load_survey

    app = web.Application(middlewares=[auth_middleware])
    app["rtmt"] = StubRtmt(load_survey("TEST"))
    app.router.add_post("/login", login)
    app.router.add_post("/analyze-report", analyze_report)

    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    async with client:
        await client.post("/login", json={"username": "system1", "password": "sys123"})
        yield client


SNAPSHOTS = [
    {"questionId": "q1", "score": 5, "domain": "Emotional Exhaustion"},
    {"questionId": "q2", "score": 5, "domain": "Depersonalization"},
    {"questionId": "q3", "score": 1, "domain": "Personal Accomplishment"},  # reverse → 5
    {"questionId": "q4", "score": 5, "domain": "Physical Exhaustion"},
    {"questionId": "q5", "score": 1, "domain": "Job Satisfaction"},          # reverse → 5
]


async def test_analyze_report_scoring(report_client):
    resp = await report_client.post("/analyze-report", json={
        "session_id": "s1", "survey_run_id": "run-1", "survey_type": "TEST",
        "snapshots": SNAPSHOTS,
    })
    assert resp.status == 200
    body = await resp.json()
    assert body["totalScore"] == 25
    assert body["maxScore"] == 25
    assert body["riskLevel"] == "High"
    assert body["analysis"] == {}          # deterministic endpoint runs no LLM


async def test_analyze_report_rejects_empty_snapshots(report_client):
    resp = await report_client.post("/analyze-report", json={
        "session_id": "s1", "survey_run_id": "run-2", "snapshots": [],
    })
    assert resp.status == 400


async def test_analyze_report_requires_auth(initialized_db):
    """Without a session cookie the middleware must 401 before the handler runs."""
    from auth import auth_middleware, login
    from ciq.reports.routes import analyze_report
    from survey_loader import load_survey

    app = web.Application(middlewares=[auth_middleware])
    app["rtmt"] = StubRtmt(load_survey("TEST"))
    app.router.add_post("/login", login)
    app.router.add_post("/analyze-report", analyze_report)

    async with TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True)) as c:
        resp = await c.post("/analyze-report", json={"snapshots": SNAPSHOTS})
        assert resp.status == 401


async def test_analyze_report_persists_history(report_client):
    from db import get_user_survey_records, get_user_by_name

    await report_client.post("/analyze-report", json={
        "session_id": "s1", "survey_run_id": "run-3", "survey_type": "TEST",
        "snapshots": SNAPSHOTS,
    })
    user = await get_user_by_name("system1")
    records = await get_user_survey_records(user["user_id"])
    assert any(r["survey_run_id"] == "run-3" for r in records)
