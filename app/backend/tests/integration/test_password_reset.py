"""Forgot-password flow — /password-reset/* (public) + /admin/password-resets/*."""
import aiosqlite
import pytest_asyncio

from tests.conftest import _make_client


@pytest_asyncio.fixture
async def reset_app(auth_app):
    from ciq.api.password_reset_routes import (
        admin_approve_password_reset,
        admin_deny_password_reset,
        admin_list_password_resets,
        complete_password_reset_route,
        password_reset_status,
        request_password_reset,
    )

    auth_app.router.add_get("/admin/password-resets", admin_list_password_resets)
    auth_app.router.add_post("/admin/password-resets/{requestId}/approve", admin_approve_password_reset)
    auth_app.router.add_post("/admin/password-resets/{requestId}/deny", admin_deny_password_reset)
    auth_app.router.add_post("/password-reset/request", request_password_reset)
    auth_app.router.add_post("/password-reset/status", password_reset_status)
    auth_app.router.add_post("/password-reset/complete", complete_password_reset_route)
    return auth_app


@pytest_asyncio.fixture
async def user_client(reset_app):
    """The browser on the login page (not logged in)."""
    async with _make_client(reset_app) as client:
        yield client


@pytest_asyncio.fixture
async def admin_client(reset_app):
    async with _make_client(reset_app) as client:
        resp = await client.post("/login", json={"username": "admin1", "password": "sys123"})
        assert resp.status == 200
        yield client


async def _request(client, username="guest1"):
    resp = await client.post("/password-reset/request", json={"username": username})
    assert resp.status == 200
    return await resp.json()


async def _status(client, req):
    resp = await client.post("/password-reset/status", json=req)
    return resp.status, await resp.json()


async def _complete(client, req, pw="newpass123", confirm=None):
    body = {**req, "new_password": pw, "confirm_password": confirm if confirm is not None else pw}
    return await client.post("/password-reset/complete", json=body)


async def test_full_flow(user_client, admin_client):
    req = await _request(user_client)
    assert (await _status(user_client, req))[1]["status"] == "pending"

    pending = (await (await admin_client.get("/admin/password-resets")).json())["requests"]
    assert [p["name"] for p in pending] == ["guest1"]

    resp = await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    assert resp.status == 200
    _, body = await _status(user_client, req)
    assert body["status"] == "approved" and 0 < body["seconds_left"] <= 120

    assert (await _complete(user_client, req)).status == 200
    assert (await _status(user_client, req))[1]["status"] == "completed"

    old = await user_client.post("/login", json={"username": "guest1", "password": "sys123"})
    assert old.status == 401
    new = await user_client.post("/login", json={"username": "guest1", "password": "newpass123"})
    assert new.status == 200


async def test_reset_signs_out_existing_sessions(reset_app, user_client, admin_client):
    async with _make_client(reset_app) as logged_in:
        await logged_in.post("/login", json={"username": "guest1", "password": "sys123"})
        assert (await logged_in.get("/me")).status == 200

        req = await _request(user_client)
        await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
        assert (await _complete(user_client, req)).status == 200

        assert (await logged_in.get("/me")).status == 401


async def test_cannot_complete_before_approval(user_client):
    req = await _request(user_client)
    assert (await _complete(user_client, req)).status == 409


async def test_denied_request(user_client, admin_client):
    req = await _request(user_client)
    await admin_client.post(f"/admin/password-resets/{req['request_id']}/deny")
    assert (await _status(user_client, req))[1]["status"] == "denied"
    assert (await _complete(user_client, req)).status == 409
    # Can't flip a decided request.
    resp = await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    assert resp.status == 409


async def test_approval_window_expires(user_client, admin_client):
    from db import DB_PATH

    req = await _request(user_client)
    await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE password_reset_requests SET approved_until = '2000-01-01T00:00:00.000000' WHERE request_id = ?",
            (req["request_id"],),
        )
        await db.commit()

    assert (await _status(user_client, req))[1]["status"] == "expired"
    assert (await _complete(user_client, req)).status == 409


async def test_unanswered_request_expires(user_client, admin_client):
    from db import DB_PATH

    req = await _request(user_client)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE password_reset_requests SET created_at = '2000-01-01T00:00:00.000000' WHERE request_id = ?",
            (req["request_id"],),
        )
        await db.commit()

    assert (await _status(user_client, req))[1]["status"] == "expired"
    assert (await (await admin_client.get("/admin/password-resets")).json())["requests"] == []
    resp = await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    assert resp.status == 409


async def test_wrong_token_rejected(user_client, admin_client):
    req = await _request(user_client)
    await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    stolen = {"request_id": req["request_id"], "token": "guessed"}
    assert (await _status(user_client, stolen))[0] == 404
    assert (await _complete(user_client, stolen)).status == 404


async def test_password_validation(user_client, admin_client):
    req = await _request(user_client)
    await admin_client.post(f"/admin/password-resets/{req['request_id']}/approve")
    assert (await _complete(user_client, req, pw="short")).status == 400
    assert (await _complete(user_client, req, confirm="different123")).status == 400
    # Still usable after a validation error.
    assert (await _complete(user_client, req)).status == 200


async def test_new_request_cancels_previous(user_client, admin_client):
    first = await _request(user_client)
    second = await _request(user_client)
    assert (await _status(user_client, first))[1]["status"] == "cancelled"
    pending = (await (await admin_client.get("/admin/password-resets")).json())["requests"]
    assert [p["request_id"] for p in pending] == [second["request_id"]]


async def test_rate_limit(user_client):
    for _ in range(3):
        await _request(user_client)
    resp = await user_client.post("/password-reset/request", json={"username": "guest1"})
    assert resp.status == 429


async def test_unknown_username(user_client):
    resp = await user_client.post("/password-reset/request", json={"username": "nobody"})
    assert resp.status == 404


async def test_admin_routes_forbidden_for_non_admin(reset_app, user_client):
    req = await _request(user_client)
    async with _make_client(reset_app) as manager:
        await manager.post("/login", json={"username": "manager1", "password": "sys123"})
        assert (await manager.get("/admin/password-resets")).status == 403
        resp = await manager.post(f"/admin/password-resets/{req['request_id']}/approve")
        assert resp.status == 403
