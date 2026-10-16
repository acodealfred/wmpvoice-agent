"""QR report download (ciq/reports/share_routes.py) through the auth middleware:
username check → one-time token → landing page → single PDF download."""
import json
import uuid
from datetime import datetime, timedelta

import aiohttp
import aiosqlite
import bcrypt
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id

SHARE = "/me/reports/{}/share"


@pytest.fixture(autouse=True)
def _reset_share_state():
    from ciq.reports import share_routes

    for store in (share_routes._shares, share_routes._active_token, share_routes._failed_attempts):
        store.clear()
    yield


@pytest_asyncio.fixture
async def share_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.reports.pdf_store_routes import upload_report_pdf
    from ciq.reports.share_routes import (
        create_report_share,
        report_share_download,
        report_share_page,
    )
    from db import create_user

    for name in ("emp1", "emp2"):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), "employee")

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_post("/me/reports/{runId}/share", create_report_share)
    app.router.add_post("/me/reports/{runId}/pdf", upload_report_pdf)
    app.router.add_get("/report-share/{token}", report_share_page)
    app.router.add_post("/report-share/{token}/download", report_share_download)
    return app


async def _client(app, username=None):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    if username:
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
             json.dumps({"totalScore": 4, "riskLevel": "Low", "interpretation": "Low."}),
             json.dumps({"agentResponse": "summary"}),
             status),
        )
        await db.commit()


async def _share(client, run_id, username="emp1"):
    return await client.post(SHARE.format(run_id), json={"username": username, "tz_offset": 330})


async def test_full_flow_downloads_once(share_app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    phone = await _client(share_app)  # not logged in
    try:
        resp = await _share(owner, run_id)
        assert resp.status == 200
        path = (await resp.json())["path"]

        # Opening the page (or a background preview) does not use up the link.
        for _ in range(2):
            page = await phone.get(path)
            assert page.status == 200
            text = await page.text()
            assert "emp1" in text and "Download report" in text

        pdf = await phone.post(f"{path}/download")
        assert pdf.status == 200
        assert pdf.content_type == "application/pdf"
        assert (await pdf.read()).startswith(b"%PDF")
        assert f"emp1_{run_id}.pdf" in pdf.headers["Content-Disposition"]

        # Second download and the page are both refused afterwards.
        assert (await phone.post(f"{path}/download")).status == 410
        assert (await phone.get(path)).status == 410
    finally:
        await owner.close()
        await phone.close()


async def test_wrong_username_is_rejected_and_locks_out(share_app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    try:
        for _ in range(5):
            assert (await _share(owner, run_id, "wrong")).status == 403
        # Locked out — even the right username is refused for now.
        assert (await _share(owner, run_id)).status == 429
    finally:
        await owner.close()


async def test_someone_elses_or_unfinished_run_is_404(share_app, initialized_db):
    other_run, open_run = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp2"), other_run)
    await _seed(initialized_db, await seed_user_id("emp1"), open_run, status="in_progress")
    owner = await _client(share_app, "emp1")
    try:
        assert (await _share(owner, other_run)).status == 404
        assert (await _share(owner, open_run)).status == 404
    finally:
        await owner.close()


async def test_share_requires_login(share_app, initialized_db):
    anon = await _client(share_app)
    try:
        assert (await _share(anon, str(uuid.uuid4()))).status == 401
    finally:
        await anon.close()


async def test_new_qr_cancels_the_previous_one(share_app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    phone = await _client(share_app)
    try:
        first = (await (await _share(owner, run_id)).json())["path"]
        second = (await (await _share(owner, run_id)).json())["path"]
        assert (await phone.post(f"{first}/download")).status == 410
        assert (await phone.post(f"{second}/download")).status == 200
    finally:
        await owner.close()
        await phone.close()


async def test_expired_and_unknown_links_are_refused(share_app, initialized_db):
    from ciq.reports import share_routes

    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    phone = await _client(share_app)
    try:
        path = (await (await _share(owner, run_id)).json())["path"]
        token = path.rsplit("/", 1)[1]
        share_routes._shares[token].expires_at = datetime.utcnow() - timedelta(seconds=1)
        assert (await phone.get(path)).status == 410
        assert (await phone.post(f"{path}/download")).status == 410
        assert (await phone.get("/report-share/not-a-real-token")).status == 410
    finally:
        await owner.close()
        await phone.close()


async def test_qr_download_serves_the_stored_screen_pdf(share_app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    phone = await _client(share_app)
    screen_pdf = b"%PDF-1.4 screen capture with charts"
    try:
        up = await owner.post(f"/me/reports/{run_id}/pdf", data=screen_pdf, headers={"Content-Type": "application/pdf"})
        assert (await up.json()) == {"stored": True}

        path = (await (await _share(owner, run_id)).json())["path"]
        pdf = await phone.post(f"{path}/download")
        assert pdf.status == 200
        assert await pdf.read() == screen_pdf
        assert (await phone.post(f"{path}/download")).status == 410
    finally:
        await owner.close()
        await phone.close()


async def test_username_match_ignores_case_and_spaces(share_app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    owner = await _client(share_app, "emp1")
    try:
        assert (await _share(owner, run_id, "  EMP1 ")).status == 200
        # Another real user's name is still a mismatch.
        assert (await _share(owner, run_id, "emp2")).status == 403
    finally:
        await owner.close()
