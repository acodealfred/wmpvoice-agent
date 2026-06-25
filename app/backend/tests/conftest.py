"""Shared fixtures: a temp SQLite DB, seeded users, and aiohttp test clients.

Every fixture points the app at a throwaway DB so tests never touch app/backend/data/ciq.db.
"""
import pathlib
import sys

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

# Make app/backend importable even if pytest is launched from the repo root.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    """Redirect both db.py and db_init.py at a temp DB file (each imports DB_PATH by value)."""
    import db
    import db_init

    db_path = tmp_path / "ciq_test.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db_init, "DB_PATH", db_path)
    return db_path


@pytest_asyncio.fixture
async def initialized_db(temp_db):
    """Create the schema and seed users (system1/system2/system3 — password 'sys123')."""
    from db_init import init_db

    await init_db()
    return temp_db


def _make_client(app: web.Application) -> TestClient:
    # unsafe=True is REQUIRED: aiohttp's default cookie jar drops cookies set on an
    # IP host (127.0.0.1), which would silently break the login→/me session flow.
    return TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))


@pytest_asyncio.fixture
async def auth_app(initialized_db):
    """Minimal app with only the auth middleware + auth routes (no Azure/rtmt needed)."""
    from auth import auth_middleware, login, logout, me

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_post("/logout", logout)
    app.router.add_get("/me", me)
    return app


@pytest_asyncio.fixture
async def auth_client(auth_app):
    async with _make_client(auth_app) as client:
        yield client
