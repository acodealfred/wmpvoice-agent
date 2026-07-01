
import asyncio
import uuid
import logging
from datetime import datetime
from pathlib import Path

import aiosqlite
import bcrypt

from db import DB_PATH

logger = logging.getLogger("voicerag")

# (name, password, role). role is "admin" or "guest". Admins can reach the
# /admin/* routes; guests are blocked from them by auth_middleware.
SEED_USERS = [
    ("system1", "sys123", "admin"),
    ("system2", "sys123", "admin"),
    ("system3", "sys123", "admin"),
    ("admin1", "sys123", "admin"),
    ("admin2", "sys123", "admin"),
    ("admin3", "sys123", "admin"),
    ("guest1", "sys123", "guest"),
    ("guest2", "sys123", "guest"),
    ("guest3", "sys123", "guest"),
    ("manager1", "sys123", "manager"),
    ("manager2", "sys123", "manager"),
]


async def init_db() -> None:
    """Create tables and seed users. Safe to call on every startup."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        # WAL mode lets readers proceed concurrently with writers — prevents
        # "database is locked" errors during biometrics-heavy survey phases.
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=5000")
        await db.commit()

        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id       TEXT PRIMARY KEY,
                name          TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'guest',
                department    TEXT,
                shift         TEXT,
                job_title     TEXT,
                is_demo       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL
            )
        """)

        # Migrations for databases created before a column existed.
        # CREATE TABLE IF NOT EXISTS won't add a column to an existing table, so
        # add each explicitly and ignore the "duplicate column" error on re-run.
        for stmt in (
            "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'guest'",
            "ALTER TABLE users ADD COLUMN department TEXT",
            "ALTER TABLE users ADD COLUMN shift TEXT",
            "ALTER TABLE users ADD COLUMN job_title TEXT",
            "ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0",
        ):
            try:
                await db.execute(stmt)
            except aiosqlite.OperationalError:
                pass  # column already present
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_sessions (
                session_token   TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL REFERENCES users(user_id),
                session_id      TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                last_active_at  TEXT NOT NULL,
                survey_results  TEXT,
                technical_report TEXT,
                prompt_info     TEXT
            )
        """)

        # One row per completed survey run. A single login (user_sessions row)
        # can own many survey_records, so a user's full assessment history is
        # preserved instead of each survey overwriting the last.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS survey_records (
                survey_run_id    TEXT PRIMARY KEY,
                user_id          TEXT NOT NULL REFERENCES users(user_id),
                session_token    TEXT,
                session_id       TEXT,
                survey_type      TEXT,
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                survey_results   TEXT,
                technical_report TEXT,
                prompt_info      TEXT,
                is_demo          INTEGER NOT NULL DEFAULT 0
            )
        """)
        try:
            await db.execute(
                "ALTER TABLE survey_records ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0"
            )
        except aiosqlite.OperationalError:
            pass  # column already present
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_survey_records_user
            ON survey_records(user_id, created_at DESC)
        """)

        # One calibrated biometric baseline per user (pupil size + blink rate),
        # keyed by user_id so it follows the user across devices/browsers. A new
        # recording upserts this row; "Re-record" deletes it so a fresh one is taken.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_baselines (
                user_id    TEXT PRIMARY KEY REFERENCES users(user_id),
                pupil_size REAL NOT NULL,
                blink_rate REAL NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        # Manager "Wellbeing Assistant" chat history. One chat_sessions row per
        # conversation; many chat_messages per chat. See docs/manager-chat.md.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS chat_sessions (
                chat_id    TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(user_id),
                title      TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                message_id TEXT PRIMARY KEY,
                chat_id    TEXT NOT NULL REFERENCES chat_sessions(chat_id),
                role       TEXT NOT NULL,
                content    TEXT NOT NULL,
                citations  TEXT,
                tool_trace TEXT,
                created_at TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
            ON chat_messages(chat_id, created_at)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
            ON chat_sessions(user_id, updated_at DESC)
        """)

        now = datetime.utcnow().isoformat()
        for name, password, role in SEED_USERS:
            user_id = str(uuid.uuid4())
            password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            await db.execute(
                """INSERT OR IGNORE INTO users (user_id, name, password_hash, role, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (user_id, name, password_hash, role, now),
            )
            # Keep an existing seed account's role in sync if it predates roles.
            await db.execute(
                "UPDATE users SET role = ? WHERE name = ?",
                (role, name),
            )

        await db.commit()

    logger.info("[DB] Database initialised at %s with %d seed users", DB_PATH, len(SEED_USERS))


if __name__ == "__main__":
    asyncio.run(init_db())
