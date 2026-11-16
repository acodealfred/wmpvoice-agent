"""Participant ID map CSV — GET /admin/users/participant-map.csv."""
import uuid

import pytest_asyncio

from tests.conftest import _make_client


@pytest_asyncio.fixture
async def map_client(auth_app):
    from ciq.api.participant_map import admin_participant_map_csv

    auth_app.router.add_get("/admin/users/participant-map.csv", admin_participant_map_csv)
    async with _make_client(auth_app) as client:
        yield client


async def _login(client, name):
    resp = await client.post("/login", json={"username": name, "password": "sys123"})
    assert resp.status == 200


def test_participant_rows_filter_and_order():
    from ciq.api.participant_map import participant_rows

    users = [{"user_id": str(i), "name": n} for i, n in enumerate(
        ["P060", "admin1", "p004", " P043 ", "P-5", "P004a", "Pat", "P", "guest1"]
    )]
    assert [r["name"] for r in participant_rows(users)] == ["p004", "P-5", " P043 ", "P060"]


def test_csv_quotes_odd_names():
    from ciq.api.participant_map import participant_map_csv

    assert participant_map_csv([]) == "user_id,username\r\n"
    assert participant_map_csv([{"user_id": "u-1", "name": "P001,x"}]) == 'user_id,username\r\nu-1,"P001,x"\r\n'


async def test_admin_downloads_only_participants(map_client):
    from db import create_user

    p_id = str(uuid.uuid4())
    await create_user(p_id, "P043", "x")
    await _login(map_client, "admin1")

    resp = await map_client.get("/admin/users/participant-map.csv")
    assert resp.status == 200
    assert resp.content_type == "text/csv"
    assert "attachment" in resp.headers["Content-Disposition"]
    text = (await resp.read()).decode("utf-8-sig")
    assert text == f"user_id,username\r\n{p_id},P043\r\n"


async def test_non_admin_forbidden(map_client):
    await _login(map_client, "manager1")
    assert (await map_client.get("/admin/users/participant-map.csv")).status == 403
