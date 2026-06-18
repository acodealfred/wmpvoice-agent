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


async def ensure_survey_record(
    survey_run_id: str,
    user_id: str,
    session_token: str | None,
    session_id: str | None,
    survey_type: str | None,
) -> None:
    """Create the survey_records row if it does not exist yet.

    Any of the three persistence writes (results / snapshot / SSoT) may be the
    first to fire for a given run, so each calls this first. INSERT OR IGNORE
    keeps it idempotent — a second caller never clobbers existing data, and a
    non-null survey_type on a later call backfills an earlier null.
    """
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT OR IGNORE INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (survey_run_id, user_id, session_token, session_id, survey_type, now, now),
        )
        if survey_type:
            await db.execute(
                "UPDATE survey_records SET survey_type = COALESCE(survey_type, ?) "
                "WHERE survey_run_id = ?",
                (survey_type, survey_run_id),
            )
        await db.commit()


async def save_survey_record_results(
    survey_run_id: str,
    survey_results: dict,
    technical_report: dict,
    prompt_info: dict,
) -> None:
    """Full write of one survey run's data (from /analyze-report)."""
    async with _open_db() as db:
        await db.execute(
            """UPDATE survey_records
               SET survey_results = ?, technical_report = ?, prompt_info = ?,
                   updated_at = ?
               WHERE survey_run_id = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                json.dumps(prompt_info),
                datetime.utcnow().isoformat(),
                survey_run_id,
            ),
        )
        await db.commit()


async def save_survey_record_snapshot(
    survey_run_id: str,
    survey_results: dict,
    technical_report: dict,
) -> None:
    """Save survey results and a basic technical report only if not already set.

    Called from /ssot-report so a run is recorded in history even when
    /analyze-report is never called. COALESCE means it never overwrites data
    saved by save_survey_record_results, and it leaves prompt_info untouched so
    a later update_survey_record_ssot can safely merge into it.
    """
    async with _open_db() as db:
        await db.execute(
            """UPDATE survey_records
               SET survey_results  = COALESCE(survey_results, ?),
                   technical_report = COALESCE(technical_report, ?),
                   updated_at       = ?
               WHERE survey_run_id = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                datetime.utcnow().isoformat(),
                survey_run_id,
            ),
        )
        await db.commit()


async def merge_survey_record_json(
    survey_run_id: str,
    *,
    technical_report_patch: dict | None = None,
    prompt_info_patch: dict | None = None,
) -> None:
    """Read-modify-write merge of keys into the technical_report / prompt_info JSON columns.

    Used by the on-demand AI endpoints (/report/behavioral-analysis, /report/consultative-summary)
    so each can enrich one part of an existing row (analysis / agentResponse) without
    clobbering the deterministic figures or the other endpoint's output.
    """
    async with _open_db() as db:
        async with db.execute(
            "SELECT technical_report, prompt_info FROM survey_records WHERE survey_run_id = ?",
            (survey_run_id,),
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return
        technical = json.loads(row["technical_report"] or "{}")
        prompt = json.loads(row["prompt_info"] or "{}")
        if technical_report_patch:
            technical.update(technical_report_patch)
        if prompt_info_patch:
            prompt.update(prompt_info_patch)
        await db.execute(
            "UPDATE survey_records SET technical_report = ?, prompt_info = ?, updated_at = ? "
            "WHERE survey_run_id = ?",
            (json.dumps(technical), json.dumps(prompt), datetime.utcnow().isoformat(), survey_run_id),
        )
        await db.commit()


async def update_survey_record_ssot(survey_run_id: str, ssot_result: dict) -> None:
    """Merge SSoT outcome (success or failure) into the prompt_info JSON column."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT prompt_info FROM survey_records WHERE survey_run_id = ?", (survey_run_id,)
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return
        existing = json.loads(row["prompt_info"] or "{}")
        existing["ssotReport"] = ssot_result
        await db.execute(
            "UPDATE survey_records SET prompt_info = ?, updated_at = ? WHERE survey_run_id = ?",
            (json.dumps(existing), datetime.utcnow().isoformat(), survey_run_id),
        )
        await db.commit()


async def get_user_survey_records(user_id: str) -> list[dict]:
    """Return a user's survey runs that have recorded data, most recent first."""
    async with _open_db() as db:
        async with db.execute("""
            SELECT survey_run_id, session_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info
            FROM survey_records
            WHERE user_id = ?
              AND (survey_results IS NOT NULL OR prompt_info IS NOT NULL)
            ORDER BY created_at DESC
        """, (user_id,)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


async def delete_session(session_token: str) -> None:
    async with _open_db() as db:
        await db.execute(
            "DELETE FROM user_sessions WHERE session_token = ?", (session_token,)
        )
        await db.commit()


async def get_all_users_with_session_info() -> list[dict]:
    """Return all users with assessment count and most recent survey details.

    session_count is now the number of recorded survey runs (assessments taken),
    and last_active_at / last_session_id reflect the most recent survey run.
    """
    async with _open_db() as db:
        async with db.execute("""
            SELECT
                u.user_id,
                u.name,
                u.created_at,
                COUNT(sr.survey_run_id) AS session_count,
                MAX(sr.updated_at)      AS last_active_at,
                (SELECT session_id FROM survey_records
                 WHERE user_id = u.user_id
                 ORDER BY updated_at DESC LIMIT 1) AS last_session_id
            FROM users u
            LEFT JOIN survey_records sr ON u.user_id = sr.user_id
            GROUP BY u.user_id
            ORDER BY u.name
        """) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
