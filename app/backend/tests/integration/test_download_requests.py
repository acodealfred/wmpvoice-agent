"""One QR download per report, and "request another download" → admin approve/deny
(ciq/reports/share_routes.py, ciq/reports/download_request_routes.py)."""
import uuid

import pytest
import pytest_asyncio
from conftest import seed_user_id
from test_report_share import (  # noqa: F401 — fixture reused
    _client,
    _seed,
    _share,
    share_app,
)


@pytest.fixture(autouse=True)
def _reset_share_state():
    from ciq.reports import share_routes

    for store in (share_routes._shares, share_routes._active_token, share_routes._failed_attempts):
        store.clear()
    yield


@pytest_asyncio.fixture
async def app(share_app):  # noqa: F811
    from ciq.reports.download_request_routes import (
        admin_approve_download_request,
        admin_deny_download_request,
        admin_list_download_requests,
        request_another_download,
    )

    share_app.router.add_post("/me/reports/{runId}/download-request", request_another_download)
    share_app.router.add_get("/admin/download-requests", admin_list_download_requests)
    share_app.router.add_post("/admin/download-requests/{requestId}/approve", admin_approve_download_request)
    share_app.router.add_post("/admin/download-requests/{requestId}/deny", admin_deny_download_request)
    return share_app


async def _download(owner, phone, run_id):
    """Get a QR link and use it on the phone; returns the download response status."""
    resp = await _share(owner, run_id)
    assert resp.status == 200, await resp.text()
    path = (await resp.json())["path"]
    return (await phone.post(f"{path}/download")).status


async def _setup(app, initialized_db):
    run_id = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp1"), run_id)
    return run_id, await _client(app, "emp1"), await _client(app), await _client(app, "system1")


async def _close(*clients):
    for c in clients:
        await c.close()


async def _pending(admin):
    return (await (await admin.get("/admin/download-requests")).json())["requests"]


async def test_second_qr_after_a_download_is_refused(app, initialized_db):
    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        assert await _download(owner, phone, run_id) == 200
        again = await _share(owner, run_id)
        assert again.status == 409
        body = await again.json()
        assert body["code"] == "already_downloaded" and body["request"] is None
        assert "Only one download" in body["error"]
    finally:
        await _close(owner, phone, admin)


async def test_limit_survives_a_restart(app, initialized_db):
    """Tokens are in memory; the download count is in the DB."""
    from ciq.reports import share_routes

    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        path = (await (await _share(owner, run_id)).json())["path"]
        assert (await phone.post(f"{path}/download")).status == 200
        for store in (share_routes._shares, share_routes._active_token):
            store.clear()  # as after a restart
        assert (await _share(owner, run_id)).status == 409
    finally:
        await _close(owner, phone, admin)


async def test_two_qr_codes_cannot_both_download(app, initialized_db):
    """Even if a token were still valid, the DB count lets only one download through."""
    from ciq.reports import share_routes

    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        path = (await (await _share(owner, run_id)).json())["path"]
        token = path.rsplit("/", 1)[1]
        kept = share_routes._shares[token]
        assert (await phone.post(f"{path}/download")).status == 200
        share_routes._shares[token] = kept  # resurrect the used token
        second = await phone.post(f"{path}/download")
        assert second.status == 410
        assert "Only one download" in await second.text()
    finally:
        await _close(owner, phone, admin)


async def test_request_approve_allows_one_more_download(app, initialized_db):
    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        assert await _download(owner, phone, run_id) == 200

        req = await owner.post(f"/me/reports/{run_id}/download-request")
        assert (await req.json()) == {"status": "pending"}
        # Asking again keeps the one pending request.
        assert (await (await owner.post(f"/me/reports/{run_id}/download-request")).json()) == {"status": "pending"}
        pending = await _pending(admin)
        assert len(pending) == 1 and pending[0]["user_name"] == "emp1"
        # The dialog sees the pending state.
        assert (await (await _share(owner, run_id)).json())["request"] == {"status": "pending"}

        approve = await admin.post(f"/admin/download-requests/{pending[0]['request_id']}/approve")
        assert approve.status == 200
        assert await _pending(admin) == []
        # Deciding twice is refused.
        assert (await admin.post(f"/admin/download-requests/{pending[0]['request_id']}/deny")).status == 409

        assert await _download(owner, phone, run_id) == 200
        assert (await _share(owner, run_id)).status == 409  # used again
    finally:
        await _close(owner, phone, admin)


async def test_deny_keeps_it_blocked(app, initialized_db):
    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        assert await _download(owner, phone, run_id) == 200
        await owner.post(f"/me/reports/{run_id}/download-request")
        request_id = (await _pending(admin))[0]["request_id"]
        assert (await admin.post(f"/admin/download-requests/{request_id}/deny")).status == 200

        again = await _share(owner, run_id)
        assert again.status == 409
        assert (await again.json())["request"] == {"status": "denied"}
        # A new request is allowed after a denial.
        assert (await (await owner.post(f"/me/reports/{run_id}/download-request")).json()) == {"status": "pending"}
    finally:
        await _close(owner, phone, admin)


async def test_request_rules(app, initialized_db):
    run_id, owner, phone, admin = await _setup(app, initialized_db)
    other_run = str(uuid.uuid4())
    await _seed(initialized_db, await seed_user_id("emp2"), other_run)
    try:
        # Not downloaded yet → nothing to request.
        assert (await owner.post(f"/me/reports/{run_id}/download-request")).status == 409
        # Someone else's run.
        assert (await owner.post(f"/me/reports/{other_run}/download-request")).status == 404
    finally:
        await _close(owner, phone, admin)


async def test_admin_routes_are_admin_only(app, initialized_db):
    run_id, owner, phone, admin = await _setup(app, initialized_db)
    try:
        assert (await owner.get("/admin/download-requests")).status == 403
        assert (await owner.post("/admin/download-requests/x/approve")).status == 403
        assert (await phone.get("/admin/download-requests")).status == 401
    finally:
        await _close(owner, phone, admin)
