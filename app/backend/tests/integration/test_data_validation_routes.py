"""/admin/data-validation/* (ciq/validation/routes.py) through the auth middleware."""
import csv
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta

import aiohttp
import aiosqlite
import bcrypt
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import seed_user_id


@pytest_asyncio.fixture
async def validation_app(initialized_db):
    from auth import auth_middleware, login
    from ciq.validation.routes import (
        admin_data_validation_export_zip,
        admin_data_validation_runs,
    )
    from db import create_user

    for name, role in (("emp1", "employee"), ("mgr1", "manager")):
        await create_user(str(uuid.uuid4()), name, bcrypt.hashpw(b"sys123", bcrypt.gensalt()).decode(), role)

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/admin/data-validation/runs", admin_data_validation_runs)
    app.router.add_get("/admin/data-validation/export-zip", admin_data_validation_export_zip)
    return app


async def _client(app, username):
    client = TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True))
    await client.start_server()
    resp = await client.post("/login", json={"username": username, "password": "sys123"})
    assert resp.status == 200
    return client


def _iso(days_ago: float = 0) -> str:
    return (datetime.utcnow() - timedelta(days=days_ago)).isoformat()


async def _seed_run(
    db_path, user_id, run_id, *, survey_type="PILOT", status="completed", report=True,
    frames=2, segments=(), bat4=None, cbi3=None, is_demo=0, days_ago=0.0,
):
    created = _iso(days_ago)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records (survey_run_id, user_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, status, is_demo, closed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, user_id, survey_type, created, created,
             json.dumps({"q1": {"score": 3, "userResponse": "Sometimes"}}),
             json.dumps({"analysis": {}, "riskLevel": "Moderate"}) if report else None,
             status, is_demo, created if status == "closed" else None),
        )
        for i in range(frames):
            await db.execute(
                """INSERT INTO survey_timeline_frames
                       (survey_run_id, user_id, frame_index, segment_index, timestamp, turn_state, created_at)
                   VALUES (?, ?, ?, ?, ?, 'idle', ?)""",
                (run_id, user_id, i, 0, created, created),
            )
        for seg in segments:
            await db.execute(
                """INSERT INTO eeg_session_segments (survey_run_id, segment_index, user_id, file_json, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (run_id, seg, user_id, json.dumps({"segment": seg}), created),
            )
        if bat4:
            await db.execute(
                "INSERT INTO pilot_bat4_scores (survey_run_id, user_id, average_score, risk_level, created_at) VALUES (?, ?, ?, ?, ?)",
                (run_id, user_id, 4.25, bat4, created),
            )
        if cbi3:
            await db.execute(
                "INSERT INTO pilot_cbi3_scores (survey_run_id, user_id, mean_score, risk_level, created_at) VALUES (?, ?, ?, ?, ?)",
                (run_id, user_id, 16.7, cbi3, created),
            )
        await db.commit()


async def test_non_admins_are_forbidden(validation_app):
    for name in ("emp1", "mgr1"):
        client = await _client(validation_app, name)
        try:
            assert (await client.get("/admin/data-validation/runs")).status == 403
            assert (await client.get("/admin/data-validation/export-zip?survey_run_id=x")).status == 403
        finally:
            await client.close()


async def test_runs_statuses_filters_and_exclusions(validation_app, initialized_db):
    uid = await seed_user_id("system1")
    await _seed_run(initialized_db, uid, "run-ok", bat4="High", cbi3="Low", segments=(0, 1))
    await _seed_run(initialized_db, uid, "run-closed", status="closed", report=False)
    await _seed_run(initialized_db, uid, "run-noreport", report=False, bat4="Low", cbi3="Low")
    await _seed_run(initialized_db, uid, "run-demo", is_demo=1, bat4="Low", cbi3="Low")
    await _seed_run(initialized_db, uid, "run-old", survey_type="BATFULL", days_ago=40)

    client = await _client(validation_app, "system1")
    try:
        runs = {r["surveyRunId"]: r for r in (await (await client.get("/admin/data-validation/runs")).json())["runs"]}
        assert set(runs) == {"run-ok", "run-closed", "run-noreport"}  # demo + >30 days excluded

        ok = runs["run-ok"]
        assert ok["userId"] == uid
        assert ok["userName"] == "system1"
        assert ok["status"] == "completed"
        assert ok["scores"]["riskDeviation"] is True
        assert [s["index"] for s in ok["eegSegments"]] == [0, 1]
        assert ok["fileCount"] == 4

        assert runs["run-closed"]["status"] == "partial"
        assert runs["run-closed"]["report"] == "not_generated"
        assert runs["run-noreport"]["status"] == "failed"
        assert runs["run-noreport"]["report"] == "missing"

        all_runs = (await (await client.get("/admin/data-validation/runs?days=all")).json())["runs"]
        assert "run-old" in {r["surveyRunId"] for r in all_runs}
        assert (await client.get("/admin/data-validation/runs?days=abc")).status == 400
    finally:
        await client.close()


async def test_zip_multi_segment_pilot_run(validation_app, initialized_db):
    uid = await seed_user_id("system1")
    await _seed_run(initialized_db, uid, "run-zip-0001", bat4="High", cbi3="Low", segments=(0, 1, 2))

    client = await _client(validation_app, "system1")
    try:
        resp = await client.get("/admin/data-validation/export-zip?survey_run_id=run-zip-0001")
        assert resp.status == 200
        assert resp.content_type == "application/zip"
        u8 = uid[:8]
        assert f'filename="ciq_export_{u8}_run-zip-0001.zip"' in resp.headers["Content-Disposition"]
        zf = zipfile.ZipFile(io.BytesIO(await resp.read()))
        names = set(zf.namelist())
        assert {
            f"survey_timeline_{u8}_run-zip-.csv",
            f"survey_timeline_combined_{u8}_run-zip-.csv",
            f"eeg/eeg_segment0_{u8}_run-zip-.json",
            f"eeg/eeg_segment1_{u8}_run-zip-.json",
            f"eeg/eeg_segment2_{u8}_run-zip-.json",
        } <= names
        assert not any(n.endswith(".xlsx") for n in names)  # pilot XLSX is not part of this export
        # User id inside every file: EEG `ciq` block, and the first CSV columns.
        seg1 = json.loads(zf.read(f"eeg/eeg_segment1_{u8}_run-zip-.json"))
        assert seg1 == {"segment": 1, "ciq": {"user_id": uid, "survey_run_id": "run-zip-0001", "segment_index": 1}}
        for csv_name in (f"survey_timeline_{u8}_run-zip-.csv", f"survey_timeline_combined_{u8}_run-zip-.csv"):
            header, first = list(csv.reader(io.StringIO(zf.read(csv_name).decode())))[:2]
            assert header[:2] == ["user_id", "survey_run_id"]
            assert first[:2] == [uid, "run-zip-0001"]
    finally:
        await client.close()


async def test_zip_malformed_eeg_omits_combined_with_warning(validation_app, initialized_db, monkeypatch):
    import ciq.api.history_routes as history_routes

    def broken_combine(*_args, **_kwargs):
        raise ValueError("bad EEG")

    monkeypatch.setattr(history_routes, "combine_segments", broken_combine)
    uid = await seed_user_id("system1")
    await _seed_run(initialized_db, uid, "run-bad-eeg1", bat4="Low", cbi3="Low", segments=(0,))

    client = await _client(validation_app, "system1")
    try:
        resp = await client.get("/admin/data-validation/export-zip?survey_run_id=run-bad-eeg1")
        assert resp.status == 200  # one bad file never fails the whole archive
        u8 = uid[:8]
        zf = zipfile.ZipFile(io.BytesIO(await resp.read()))
        assert f"survey_timeline_combined_{u8}_run-bad-.csv" not in zf.namelist()
        assert f"eeg/eeg_session_{u8}_run-bad-.json" in zf.namelist()
        assert f"survey_timeline_combined_{u8}_run-bad-.csv omitted" in zf.read("warnings.txt").decode()
    finally:
        await client.close()


async def test_zip_run_without_eeg(validation_app, initialized_db):
    uid = await seed_user_id("system1")
    await _seed_run(initialized_db, uid, "run-noeeg-01", survey_type="BATFULL")

    client = await _client(validation_app, "system1")
    try:
        resp = await client.get("/admin/data-validation/export-zip?survey_run_id=run-noeeg-01")
        assert resp.status == 200
        assert zipfile.ZipFile(io.BytesIO(await resp.read())).namelist() == [f"survey_timeline_{uid[:8]}_run-noee.csv"]
    finally:
        await client.close()


async def test_zip_errors(validation_app, initialized_db):
    uid = await seed_user_id("system1")
    await _seed_run(initialized_db, uid, "run-empty", status="closed", report=False, frames=0)

    client = await _client(validation_app, "system1")
    try:
        assert (await client.get("/admin/data-validation/export-zip")).status == 400
        assert (await client.get("/admin/data-validation/export-zip?survey_run_id=nope")).status == 404
        # Recorded something (survey_results) but has no exportable file.
        assert (await client.get("/admin/data-validation/export-zip?survey_run_id=run-empty")).status == 404
    finally:
        await client.close()
