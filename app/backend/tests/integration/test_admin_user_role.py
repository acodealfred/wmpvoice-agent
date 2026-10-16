"""Admin role change — PATCH /admin/users/{userId}/role + db.update_user_role."""
import pytest_asyncio
from aiohttp import web

from tests.conftest import _make_client


@pytest_asyncio.fixture
async def role_client(auth_app):
    from ciq.api.history_routes import admin_list_users, admin_update_user_role

    async def manager_probe(request):
        return web.json_response({"ok": True})

    auth_app.router.add_get("/admin/users", admin_list_users)
    auth_app.router.add_patch("/admin/users/{userId}/role", admin_update_user_role)
    auth_app.router.add_get("/manager/probe", manager_probe)
    async with _make_client(auth_app) as client:
        yield client


async def _login(client, name):
    resp = await client.post("/login", json={"username": name, "password": "sys123"})
    assert resp.status == 200
    return (await resp.json())["user"]


async def _user_id(name):
    from db import get_user_by_name
    return (await get_user_by_name(name))["user_id"]


async def test_admin_promotes_employee(role_client):
    await _login(role_client, "admin1")
    guest_id = await _user_id("guest1")

    resp = await role_client.patch(f"/admin/users/{guest_id}/role", json={"role": "manager"})
    assert resp.status == 200
    assert await resp.json() == {"user_id": guest_id, "role": "manager"}

    users = (await (await role_client.get("/admin/users")).json())["users"]
    assert next(u for u in users if u["user_id"] == guest_id)["role"] == "manager"


async def test_new_role_applies_on_next_request(role_client):
    from db import update_user_role

    await _login(role_client, "guest1")
    assert (await role_client.get("/manager/probe")).status == 403

    assert await update_user_role(await _user_id("guest1"), "manager") == "ok"
    assert (await role_client.get("/manager/probe")).status == 200


async def test_non_admin_forbidden(role_client):
    await _login(role_client, "manager1")
    guest_id = await _user_id("guest1")
    resp = await role_client.patch(f"/admin/users/{guest_id}/role", json={"role": "admin"})
    assert resp.status == 403


async def test_invalid_role_and_json(role_client):
    await _login(role_client, "admin1")
    guest_id = await _user_id("guest1")
    resp = await role_client.patch(f"/admin/users/{guest_id}/role", json={"role": "superuser"})
    assert resp.status == 400
    resp = await role_client.patch(f"/admin/users/{guest_id}/role", data="not json")
    assert resp.status == 400


async def test_unknown_user(role_client):
    await _login(role_client, "admin1")
    resp = await role_client.patch("/admin/users/does-not-exist/role", json={"role": "manager"})
    assert resp.status == 404


async def test_cannot_change_own_role(role_client):
    me = await _login(role_client, "admin1")
    resp = await role_client.patch(f"/admin/users/{me['user_id']}/role", json={"role": "employee"})
    assert resp.status == 409


async def test_unchanged_role_is_ok(role_client):
    await _login(role_client, "admin1")
    guest_id = await _user_id("guest1")
    resp = await role_client.patch(f"/admin/users/{guest_id}/role", json={"role": "employee"})
    assert resp.status == 200


async def test_last_admin_cannot_be_demoted(initialized_db):
    # Unreachable over HTTP (the actor is itself an admin and can't target
    # itself), so the DB-level guard is tested directly.
    import aiosqlite

    from db import DB_PATH, update_user_role

    admin_id = await _user_id("admin1")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET role = 'employee' WHERE role = 'admin' AND user_id != ?",
            (admin_id,),
        )
        await db.commit()

    assert await update_user_role(admin_id, "employee") == "last_admin"
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT role FROM users WHERE user_id = ?", (admin_id,)) as cur:
            assert (await cur.fetchone())[0] == "admin"
