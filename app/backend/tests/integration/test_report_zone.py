"""Spoken Fatigue ↔ Burnout zone lines for the PILOT voice report (ciq.realtime.report_zone)."""
import json

import aiosqlite

from ciq.realtime.report_zone import report_zone_lines
from ciq.realtime.session import SessionState
from ciq.zone import SPOKEN_ZONE_DISCLAIMER

_IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]


def _results(bat: int, cbi: int) -> str:
    return json.dumps({qid: {"score": bat if qid.startswith("bat_") else cbi} for qid in _IDS})


async def _guest1() -> str:
    from db import get_user_by_name

    return (await get_user_by_name("guest1"))["user_id"]


async def _insert(db_path, run_id, user_id, created_at, results):
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO survey_records
               (survey_run_id, user_id, survey_type, created_at, updated_at, survey_results, status)
               VALUES (?, ?, 'PILOT', ?, ?, ?, 'completed')""",
            (run_id, user_id, created_at, created_at, results),
        )
        await db.commit()


def _bound(user_id, run_id) -> SessionState:
    sess = SessionState(session_id="s")
    sess.user_id, sess.survey_run_id = user_id, run_id
    return sess


async def test_lines_for_the_bound_run(initialized_db):
    uid = await _guest1()
    await _insert(initialized_db, "run-a", uid, "2026-09-01T09:00:00", _results(2, 25))
    await _insert(initialized_db, "run-b", uid, "2026-09-08T09:00:00", _results(4, 75))
    lines = await report_zone_lines(_bound(uid, "run-b"))
    assert lines[0].startswith("Overall, your strain is in the")
    assert "gone up" in " ".join(lines)          # run-b is worse than run-a
    assert lines[-1] == SPOKEN_ZONE_DISCLAIMER


async def test_no_lines_when_the_bound_run_is_not_the_latest_zone(initialized_db):
    uid = await _guest1()
    await _insert(initialized_db, "scored", uid, "2026-09-01T09:00:00", _results(3, 50))
    await _insert(initialized_db, "unscoreable", uid, "2026-09-02T09:00:00", json.dumps({"bat_q1": {"score": 3}}))
    assert await report_zone_lines(_bound(uid, "unscoreable")) == []


async def test_no_lines_without_a_bound_run(initialized_db):
    assert await report_zone_lines(SessionState(session_id="s")) == []


async def test_no_lines_when_the_config_is_unusable(initialized_db, monkeypatch):
    import ciq.realtime.report_zone as report_zone
    from survey_loader import load_survey

    uid = await _guest1()
    await _insert(initialized_db, "run-a", uid, "2026-09-01T09:00:00", _results(3, 50))
    monkeypatch.setattr(report_zone, "load_survey", lambda _t: load_survey("TEST"))
    assert await report_zone_lines(_bound(uid, "run-a")) == []
