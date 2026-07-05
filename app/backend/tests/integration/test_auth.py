"""BE-C2 — Auth & session middleware (auth.py)."""
import pytest


async def _login(client, username="system1", password="sys123"):
    return await client.post("/login", json={"username": username, "password": password})


# ── login ──────────────────────────────────────────────────────────────────
async def test_login_success_sets_cookie(auth_client):
    resp = await _login(auth_client)
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert body["user"]["name"] == "system1"
    assert "session_token" in resp.cookies


async def test_login_bad_password(auth_client):
    resp = await _login(auth_client, password="wrong")
    assert resp.status == 401


async def test_login_unknown_user(auth_client):
    resp = await _login(auth_client, username="ghost")
    assert resp.status == 401


async def test_login_missing_fields(auth_client):
    resp = await auth_client.post("/login", json={"username": "system1"})
    assert resp.status == 400


async def test_login_malformed_json(auth_client):
    resp = await auth_client.post("/login", data="not-json",
                                  headers={"Content-Type": "application/json"})
    assert resp.status == 400


# ── middleware gating ───────────────────────────────────────────────────────
async def test_me_requires_auth(auth_client):
    resp = await auth_client.get("/me")          # no cookie yet
    assert resp.status == 401


async def test_me_after_login(auth_client):
    await _login(auth_client)                    # cookie jar now holds session_token
    resp = await auth_client.get("/me")
    assert resp.status == 200
    body = await resp.json()
    assert "user_id" in body and "session_id" in body


async def test_invalid_token_rejected(auth_client):
    auth_client.session.cookie_jar.update_cookies({"session_token": "not-a-real-token"})
    resp = await auth_client.get("/me")
    assert resp.status == 401


# ── logout ──────────────────────────────────────────────────────────────────
async def test_logout_clears_session(auth_client):
    await _login(auth_client)
    assert (await auth_client.get("/me")).status == 200
    logout = await auth_client.post("/logout")
    assert logout.status == 200
    # Session row deleted server-side → /me is unauthorized again.
    auth_client.session.cookie_jar.clear()
    assert (await auth_client.get("/me")).status == 401