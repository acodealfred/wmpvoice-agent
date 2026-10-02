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
        self.transcripts = {}

    def get_survey_config_for_session(self, session_id):
        return self._survey_config

    def set_conversation_state_for_session(self, session_id, state, report_context=None):
        self.states[session_id] = (state, report_context)

    async def await_answer_transcripts(self, session_id, timeout_s=3.0):
        return None

    def get_answer_transcripts(self, session_id):
        return self.transcripts


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


async def test_analyze_report_stores_the_score_label_for_scored_answers(report_client):
    """A scored answer's userResponse is its option label, never the Whisper transcript
    (Whisper mishears short answers: "Some don't." for "Sometimes")."""
    import json

    from db import get_user_by_name, get_user_survey_records

    report_client.server.app["rtmt"].transcripts = {"q1": "Some don't.", "q3": "and I'm"}
    snapshots = [{**s, "userResponse": "whatever the model said"} for s in SNAPSHOTS]
    await report_client.post("/analyze-report", json={
        "session_id": "s1", "survey_run_id": "run-words", "survey_type": "TEST",
        "snapshots": snapshots,
    })
    user = await get_user_by_name("system1")
    record = next(r for r in await get_user_survey_records(user["user_id"]) if r["survey_run_id"] == "run-words")
    results = json.loads(record["survey_results"])
    assert results["q1"]["userResponse"] == "Always"     # score 5
    assert results["q3"]["userResponse"] == "Never"      # score 1 (raw, before reverse scoring)
    assert results["q2"]["userResponse"] == "Always"


async def test_analyze_report_keeps_the_users_words_for_unscored_answers(report_client):
    """An open-ended answer (no score) still stores the Whisper transcript."""
    import json

    from db import get_user_by_name, get_user_survey_records

    report_client.server.app["rtmt"].transcripts = {"q1": "honestly I'm drained most days"}
    snapshots = [{"questionId": "q1", "domain": "Emotional Exhaustion", "userResponse": "Tired."},
                 {"questionId": "q2", "domain": "Depersonalization", "userResponse": "Fine."}]
    await report_client.post("/analyze-report", json={
        "session_id": "s1", "survey_run_id": "run-open", "survey_type": "TEST",
        "snapshots": snapshots,
    })
    user = await get_user_by_name("system1")
    record = next(r for r in await get_user_survey_records(user["user_id"]) if r["survey_run_id"] == "run-open")
    results = json.loads(record["survey_results"])
    assert results["q1"]["userResponse"] == "honestly I'm drained most days"
    assert results["q2"]["userResponse"] == "Fine."      # no transcript -> model text kept
