import json
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent / "data" / "ciq.db"


@asynccontextmanager
async def _open_db():
    """Open a connection with WAL mode and busy-timeout on every call.

    WAL mode is a DB-file property, but applying the PRAGMA on each
    connection guarantees it is active even if a prior process wrote the
    file without WAL.  busy_timeout lets readers wait briefly instead of
    raising 'database is locked'.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=3000")
        yield db


async def get_user_by_name(name: str) -> dict | None:
    async with _open_db() as db:
        async with db.execute(
            "SELECT user_id, name, password_hash FROM users WHERE name = ?", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def get_session_by_token(token: str) -> dict | None:
    async with _open_db() as db:
        async with db.execute(
            "SELECT * FROM user_sessions WHERE session_token = ?", (token,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def create_user_session(session_token: str, user_id: str, session_id: str) -> None:
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO user_sessions
               (session_token, user_id, session_id, created_at, last_active_at)
               VALUES (?, ?, ?, ?, ?)""",
            (session_token, user_id, session_id, now, now),
        )
        await db.commit()


async def update_session_activity(session_token: str) -> None:
    async with _open_db() as db:
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
    async with _open_db() as db:
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


async def save_survey_snapshot(
    session_token: str,
    survey_results: dict,
    technical_report: dict,
) -> None:
    """Save survey results and basic technical report only if not already set.

    Called from /ssot-report so that survey sessions are always recorded in
    history even when /analyze-report is never called from the frontend.
    Does NOT touch prompt_info so a later update_session_ssot_report call
    can safely merge into it.
    """
    async with _open_db() as db:
        await db.execute(
            """UPDATE user_sessions
               SET survey_results  = COALESCE(survey_results, ?),
                   technical_report = COALESCE(technical_report, ?),
                   last_active_at   = ?
               WHERE session_token = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                datetime.utcnow().isoformat(),
                session_token,
            ),
        )
        await db.commit()


async def delete_session(session_token: str) -> None:
    async with _open_db() as db:
        await db.execute(
            "DELETE FROM user_sessions WHERE session_token = ?", (session_token,)
        )
        await db.commit()


async def get_user_sessions(user_id: str) -> list[dict]:
    """Return sessions that have any recorded data, most recent first."""
    async with _open_db() as db:
        async with db.execute("""
            SELECT session_token, session_id, created_at, last_active_at,
                   survey_results, technical_report, prompt_info
            FROM user_sessions
            WHERE user_id = ?
              AND (survey_results IS NOT NULL OR prompt_info IS NOT NULL)
            ORDER BY created_at DESC
        """, (user_id,)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


async def update_session_ssot_report(session_token: str, ssot_result: dict) -> None:
    """Merge SSoT outcome (success or failure) into the prompt_info JSON column."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT prompt_info FROM user_sessions WHERE session_token = ?", (session_token,)
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return
        existing = json.loads(row["prompt_info"] or "{}")
        existing["ssotReport"] = ssot_result
        await db.execute(
            "UPDATE user_sessions SET prompt_info = ? WHERE session_token = ?",
            (json.dumps(existing), session_token),
        )
        await db.commit()


async def get_all_users_with_session_info() -> list[dict]:
    """Return all users with session count and most recent session details."""
    async with _open_db() as db:
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
