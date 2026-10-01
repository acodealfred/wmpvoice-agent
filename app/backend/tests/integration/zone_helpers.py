"""Shared helpers for the Fatigue ↔ Burnout zone integration tests."""
import json

import aiosqlite

EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}
HIGH = {"bat_q1": 5, "bat_q2": 5, "bat_q3": 5, "bat_q4": 5, "cbi_q1": 100, "cbi_q2": 100, "cbi_q3": 0}


async def user_id(name: str) -> str:
    from db import get_user_by_name
    return (await get_user_by_name(name))["user_id"]


async def insert_run(uid, run_id, created_at, scores=None, survey_type="PILOT", raw=None):
    """Insert a survey_records row directly (the seeded DB has none)."""
    import db
    payload = raw if raw is not None else json.dumps(
        {q: {"score": s, "blinkRateChange": 0, "responseLatencyMs": None} for q, s in scores.items()}
    )
    async with aiosqlite.connect(db.DB_PATH) as conn:
        await conn.execute(
            """INSERT INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at, survey_results)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, uid, None, "s", survey_type, created_at, created_at, payload),
        )
        await conn.commit()
