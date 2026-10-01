"""/me/assessment* lifecycle routes (ciq/assessments/routes.py) through the auth middleware."""
import aiohttp
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import LiveSessionRtmt


@pytest_asyncio.fixture
async def assessment_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.assessments.routes import (
        close_assessment,
        continue_assessment,
        get_assessment,
        pause_assessment,
        start_assessment,
    )

    app = web.Application(middlewares=[auth_middleware])
    app["rtmt"] = LiveSessionRtmt()
    app.router.add_post("/login", login)
    app.router.add_get("/me/assessment", get_assessment)
    app.router.add_post("/me/assessment/start", start_assessment)
    app.router.add_post("/me/assessment/pause", pause_assessment)
    app.router.add_post("/me/assessment/continue", continue_assessment)
    app.router.add_post("/me/assessment/close", close_assessment)
    from ciq.api.consent_routes import save_consent

    app.router.add_post("/consent", save_consent)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    resp = await client.post("/login", json={"username": username, "password": "sys123"})
    assert resp.status == 200
    return client


async def test_requires_auth(assessment_app):
    client = TestClient(TestServer(assessment_app))
    await client.start_server()
    try:
        assert (await client.get("/me/assessment")).status == 401
    finally:
        await client.close()


async def test_full_lifecycle(assessment_app):
    client = await _client(assessment_app, "guest1")
    try:
        assert (await (await client.get("/me/assessment")).json()) == {"resumable": None}

        started = await (await client.post("/me/assessment/start", json={"surveyType": "TEST"})).json()
        run = started["surveyRunId"]
        assert started["segmentIndex"] == 0

        assert (await client.post("/me/assessment/pause")).status == 200
        assert (await client.post("/me/assessment/pause")).status == 409  # already paused

        resumable = (await (await client.get("/me/assessment")).json())["resumable"]
        assert (resumable["surveyRunId"], resumable["status"]) == (run, "paused")

        resp = await client.post("/me/assessment/continue", json={"surveyRunId": run})
        assert resp.status == 200
        assert (await resp.json())["segmentIndex"] == 1

        await client.post("/me/assessment/pause")
        assert (await client.post("/me/assessment/close", json={"surveyRunId": run})).status == 200
        assert (await (await client.get("/me/assessment")).json()) == {"resumable": None}
        assert (await client.post("/me/assessment/continue", json={"surveyRunId": run})).status == 409
    finally:
        await client.close()


async def test_missing_run_id_is_400(assessment_app):
    client = await _client(assessment_app, "guest1")
    try:
        assert (await client.post("/me/assessment/continue", json={})).status == 400
        assert (await client.post("/me/assessment/close")).status == 400
    finally:
        await client.close()


async def test_other_user_cannot_touch_the_run(assessment_app):
    owner = await _client(assessment_app, "guest1")
    other = await _client(assessment_app, "guest2")
    try:
        run = (await (await owner.post("/me/assessment/start", json={})).json())["surveyRunId"]
        assert (await other.post("/me/assessment/close", json={"surveyRunId": run})).status == 409
        assert (await other.post("/me/assessment/continue", json={"surveyRunId": run})).status == 409
        assert (await (await other.get("/me/assessment")).json()) == {"resumable": None}
        assert (await (await owner.get("/me/assessment")).json())["resumable"]["surveyRunId"] == run
    finally:
        await owner.close()
        await other.close()


async def test_each_consent_acceptance_is_logged_with_its_version(assessment_app):
    from conftest import seed_user_id

    from db import get_consent_events

    client = await _client(assessment_app, "guest1")
    try:
        body = {"version": "2026-10-01", "surveyType": "PILOT"}
        assert (await client.post("/consent", json=body)).status == 200
        assert (await client.post("/consent", json=body)).status == 200
        assert (await client.post("/consent")).status == 200  # older client: no body
        events = await get_consent_events(await seed_user_id("guest1"))
        assert [e["consent_version"] for e in events] == ["2026-10-01", "2026-10-01", None]
        assert events[0]["survey_type"] == "PILOT"
    finally:
        await client.close()
