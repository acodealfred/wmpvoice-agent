import json
import asyncio
from datetime import datetime
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent / "data" / "ciq.db"


async def get_user_by_name(name: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT user_id, name, password_hash FROM users WHERE name = ?", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def get_session_by_token(token: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM user_sessions WHERE session_token = ?", (token,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def create_user_session(session_token: str, user_id: str, session_id: str) -> None:
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO user_sessions
               (session_token, user_id, session_id, created_at, last_active_at)
               VALUES (?, ?, ?, ?, ?)""",
            (session_token, user_id, session_id, now, now),
        )
        await db.commit()


async def update_session_activity(session_token: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE user_sessions SET last_active_at = ? WHERE session_token = ?",
            (datetime.utcnow().isoformat(), session_token),
        )
        await db.commit()


async def save_session_results(
    session_token: str,
    survey_results: dict,
    technical_report: dict,
    prompt_info: dict,
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE user_sessions
               SET survey_results = ?, technical_report = ?, prompt_info = ?,
                   last_active_at = ?
               WHERE session_token = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                json.dumps(prompt_info),
                datetime.utcnow().isoformat(),
                session_token,
            ),
        )
        await db.commit()


async def delete_session(session_token: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM user_sessions WHERE session_token = ?", (session_token,)
        )
        await db.commit()


async def get_all_users_with_session_info() -> list[dict]:
    """Return all users with session count and most recent session details."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT
                u.user_id,
                u.name,
                u.created_at,
                COUNT(s.session_token) AS session_count,
                MAX(s.last_active_at)  AS last_active_at,
                (SELECT session_id FROM user_sessions
                 WHERE user_id = u.user_id
                 ORDER BY last_active_at DESC LIMIT 1) AS last_session_id
            FROM users u
            LEFT JOIN user_sessions s ON u.user_id = s.user_id
            GROUP BY u.user_id
            ORDER BY u.name
        """) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
