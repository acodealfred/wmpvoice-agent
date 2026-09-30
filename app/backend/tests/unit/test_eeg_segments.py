"""Per-segment EEG storage + combining (db.get_eeg_segments, ciq.eeg.combine.combine_segments)."""
import pytest

from ciq.eeg import combine


@pytest.fixture
def fake_compute(monkeypatch):
    """Replace the numpy maths with a recorder: each row is tagged with the file it came from."""
    calls = []

    def fake(file_json, frames):
        calls.append((file_json["id"], [f["frame_index"] for f in frames]))
        rows = [{**dict.fromkeys(combine.EEG_COLUMNS), "eeg_quality": file_json["id"]} for _ in frames]
        return rows, [f"note from {file_json['id']}"]

    monkeypatch.setattr(combine, "compute_unified_columns", fake)
    return calls


def _frames(*segments):
    return [{"frame_index": i, "segment_index": s, "timestamp": "t"} for i, s in enumerate(segments)]


def test_each_segment_is_combined_only_with_its_own_frames(fake_compute):
    frames = _frames(0, 0, 1, 1, 1)
    rows, warnings = combine.combine_segments({0: {"id": "A"}, 1: {"id": "B"}}, frames)
    assert fake_compute == [("A", [0, 1]), ("B", [2, 3, 4])]
    assert [r["eeg_quality"] for r in rows] == ["A", "A", "B", "B", "B"]
    assert warnings == ["Segment 0: note from A", "Segment 1: note from B"]


def test_segment_without_recording_keeps_rows_with_empty_eeg(fake_compute):
    rows, warnings = combine.combine_segments({0: {"id": "A"}}, _frames(0, 1, 1))
    assert [r["eeg_quality"] for r in rows] == ["A", None, None]
    assert "Segment 1 has no EEG recording, so its 2 rows have no EEG." in warnings


def test_recording_without_frames_is_reported(fake_compute):
    _, warnings = combine.combine_segments({0: {"id": "A"}, 3: {"id": "Z"}}, _frames(0))
    assert "Segment 3 has an EEG recording but no timeline rows, so it is not in the output." in warnings


def test_single_segment_warnings_are_unprefixed(fake_compute):
    _, warnings = combine.combine_segments({0: {"id": "A"}}, _frames(0, 0))
    assert warnings == ["note from A"]


def test_csv_string_segment_index_is_understood(fake_compute):
    frames = [{"frame_index": 0, "segment_index": "1", "timestamp": "t"}]
    rows, _ = combine.combine_segments({1: {"id": "B"}}, frames)
    assert rows[0]["eeg_quality"] == "B"


async def test_segments_are_stored_separately_with_legacy_fallback(initialized_db):
    from conftest import seed_user_id

    from db import get_eeg_segments, save_eeg_segment, save_eeg_session

    user = await seed_user_id("guest1")
    await save_eeg_session("legacy-run", user, "s", {"eeg": {}, "t0_epoch_ms": 1})
    legacy = await get_eeg_segments("legacy-run")
    assert [(s["segment_index"], s["file_json"]["t0_epoch_ms"]) for s in legacy] == [(0, 1)]

    await save_eeg_segment("run", 1, user, "s", {"eeg": {}, "t0_epoch_ms": 20})
    await save_eeg_segment("run", 0, user, "s", {"eeg": {}, "t0_epoch_ms": 10})
    await save_eeg_segment("run", 0, user, "s", {"eeg": {}, "t0_epoch_ms": 11})  # re-upload replaces
    segs = await get_eeg_segments("run")
    assert [(s["segment_index"], s["file_json"]["t0_epoch_ms"]) for s in segs] == [(0, 11), (1, 20)]
    assert await get_eeg_segments("no-eeg") == []


async def test_run_summaries_list_the_recorded_segments(initialized_db):
    from conftest import seed_user_id

    from db import (
        create_active_survey_run,
        get_user_survey_run_summaries,
        mark_survey_run_completed,
        save_eeg_segment,
        save_survey_record_results,
    )

    user = await seed_user_id("guest1")
    await create_active_survey_run("run", user, None, "s", "TEST")
    await save_survey_record_results("run", {"q1": {}}, {}, {})
    await mark_survey_run_completed("run")
    await save_eeg_segment("run", 2, user, "s", {"eeg": {}})
    await save_eeg_segment("run", 0, user, "s", {"eeg": {}})
    (summary,) = await get_user_survey_run_summaries(user)
    assert (summary["has_eeg_session"], summary["eeg_segments"]) == (True, [0, 2])


async def test_segment_download(initialized_db):
    import aiohttp
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from conftest import seed_user_id

    from auth import auth_middleware, login
    from ciq.eeg.routes import admin_export_eeg_session
    from db import save_eeg_segment

    user = await seed_user_id("guest1")
    await save_eeg_segment("run", 0, user, "s", {"eeg": {}, "t0_epoch_ms": 10})
    await save_eeg_segment("run", 1, user, "s", {"eeg": {}, "t0_epoch_ms": 20})

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/admin/eeg-sessions/export", admin_export_eeg_session)
    async with TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
        await client.post("/login", json={"username": "system1", "password": "sys123"})
        url = "/admin/eeg-sessions/export?survey_run_id=run"

        one = await client.get(url + "&segment=1")
        assert one.status == 200
        assert (await one.json())["t0_epoch_ms"] == 20
        assert "segment1" in one.headers["Content-Disposition"]

        bundle = await (await client.get(url)).json()
        assert [s["segment_index"] for s in bundle["segments"]] == [0, 1]

        assert (await client.get(url + "&segment=5")).status == 404
        assert (await client.get(url + "&segment=x")).status == 400
