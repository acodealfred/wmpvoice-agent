
import asyncio
import uuid
import logging
from datetime import datetime
from pathlib import Path

import aiosqlite
import bcrypt

from db import DB_PATH

logger = logging.getLogger("voicerag")

# (name, password, role, department, shift, job_title). role is "admin",
# "manager" or "employee" (the assessed staff — formerly "guest"). Admins reach
# /admin/*, managers reach /manager/*; employees are blocked from both.
# Department/shift/job give the seed employees a place in the dashboard's
# departmental views. Admins/managers carry no department (not assessed staff).
SEED_USERS = [
    ("system1", "sys123", "admin", None, None, None),
    ("system2", "sys123", "admin", None, None, None),
    ("system3", "sys123", "admin", None, None, None),
    ("admin1", "sys123", "admin", None, None, None),
    ("admin2", "sys123", "admin", None, None, None),
    ("admin3", "sys123", "admin", None, None, None),
    ("guest1", "sys123", "employee", "Legal / Regulatory", "Day", "Legal officer"),
    ("guest2", "sys123", "employee", "HR / Workforce", "Night", "HR officer"),
    ("guest3", "sys123", "employee", "IT / Digital", "Evening", "IT support"),
    ("manager1", "sys123", "manager", None, None, None),
    ("manager2", "sys123", "manager", None, None, None),
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
                role          TEXT NOT NULL DEFAULT 'employee',
                department    TEXT,
                shift         TEXT,
                job_title     TEXT,
                is_demo       INTEGER NOT NULL DEFAULT 0,
                active        INTEGER NOT NULL DEFAULT 1,
                created_at    TEXT NOT NULL
            )
        """)

        # Migrations for databases created before a column existed.
        # CREATE TABLE IF NOT EXISTS won't add a column to an existing table, so
        # add each explicitly and ignore the "duplicate column" error on re-run.
        for stmt in (
            "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'",
            "ALTER TABLE users ADD COLUMN department TEXT",
            "ALTER TABLE users ADD COLUMN shift TEXT",
            "ALTER TABLE users ADD COLUMN job_title TEXT",
            "ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
        ):
            try:
                await db.execute(stmt)
            except aiosqlite.OperationalError:
                pass  # column already present

        # Rename the assessed-staff role from the old "guest" to "employee".
        await db.execute("UPDATE users SET role = 'employee' WHERE role = 'guest'")
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

        # Records informed-consent acceptance once per user (e.g. the pilot study
        # consent form) so it is never re-shown after the first acceptance — durable
        # across logins/devices, unlike the old localStorage-only flag.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_consents (
                user_id      TEXT NOT NULL REFERENCES users(user_id),
                consent_type TEXT NOT NULL,
                accepted_at  TEXT NOT NULL,
                PRIMARY KEY (user_id, consent_type)
            )
        """)

        # PILOT-survey-only subscale tables. One row per survey run (not per question),
        # written alongside (not instead of) the technical_report JSON blob on
        # survey_records, so existing report generation is unaffected.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS pilot_bat4_scores (
                survey_run_id  TEXT PRIMARY KEY REFERENCES survey_records(survey_run_id),
                user_id        TEXT NOT NULL REFERENCES users(user_id),
                session_id     TEXT,
                response_1     INTEGER,
                response_2     INTEGER,
                response_3     INTEGER,
                response_4     INTEGER,
                total_score    INTEGER,
                average_score  REAL,
                risk_level     TEXT,
                created_at     TEXT NOT NULL
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS pilot_cbi3_scores (
                survey_run_id     TEXT PRIMARY KEY REFERENCES survey_records(survey_run_id),
                user_id           TEXT NOT NULL REFERENCES users(user_id),
                session_id        TEXT,
                item_7            INTEGER,
                item_11           INTEGER,
                item_13           INTEGER,
                item_13_reversed  INTEGER,
                total_score       INTEGER,
                mean_score        REAL,
                risk_level        TEXT,
                created_at        TEXT NOT NULL
            )
        """)

        # One row per survey run: two 10s biometric capture windows (right before the
        # first question and right after the last one) stored as before/after column
        # pairs, plus the overall average voice-response latency across the survey.
        # blink_rate_* is an absolute rate in blinks/minute (not a % change vs.
        # baseline); pupil_dilation_* is currently a raw mm delta vs. baseline.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS pilot_behaviour_snapshots (
                survey_run_id          TEXT PRIMARY KEY REFERENCES survey_records(survey_run_id),
                user_id                TEXT NOT NULL REFERENCES users(user_id),
                session_id             TEXT,
                blink_rate_before      REAL,
                blink_rate_after       REAL,
                pupil_dilation_before  REAL,
                pupil_dilation_after   REAL,
                response_latency_ms    REAL,
                captured_before_at     TEXT,
                captured_after_at      TEXT,
                created_at             TEXT NOT NULL,
                updated_at             TEXT NOT NULL
            )
        """)

        # Migrate the old phase-row layout (separate 'pre'/'post' rows, keyed by an
        # autoincrement id) into the new one-row-per-run before/after layout. Only
        # runs once per DB — detected via the old table's 'phase' column, which is
        # gone for good once this block drops the renamed old table below.
        cur = await db.execute("PRAGMA table_info(pilot_behaviour_snapshots)")
        cols = [r[1] for r in await cur.fetchall()]
        if "phase" in cols:
            await db.execute(
                "ALTER TABLE pilot_behaviour_snapshots RENAME TO pilot_behaviour_snapshots_old"
            )
            await db.execute("""
                CREATE TABLE pilot_behaviour_snapshots (
                    survey_run_id          TEXT PRIMARY KEY REFERENCES survey_records(survey_run_id),
                    user_id                TEXT NOT NULL REFERENCES users(user_id),
                    session_id             TEXT,
                    blink_rate_before      REAL,
                    blink_rate_after       REAL,
                    pupil_dilation_before  REAL,
                    pupil_dilation_after   REAL,
                    response_latency_ms    REAL,
                    captured_before_at     TEXT,
                    captured_after_at      TEXT,
                    created_at             TEXT NOT NULL,
                    updated_at             TEXT NOT NULL
                )
            """)
            old_rows = await (await db.execute(
                """SELECT survey_run_id, user_id, session_id, phase, blink_rate,
                          pupil_dilation, response_latency_ms, captured_at
                   FROM pilot_behaviour_snapshots_old ORDER BY id"""
            )).fetchall()
            merged: dict[str, dict] = {}
            for run_id, user_id, session_id, phase, blink_rate, pupil, latency, captured_at in old_rows:
                row = merged.setdefault(run_id, {"user_id": user_id, "session_id": session_id})
                if phase == "pre":
                    row["blink_rate_before"] = blink_rate
                    row["pupil_dilation_before"] = pupil
                    row["captured_before_at"] = captured_at
                else:
                    row["blink_rate_after"] = blink_rate
                    row["pupil_dilation_after"] = pupil
                    row["response_latency_ms"] = latency
                    row["captured_after_at"] = captured_at
            migrate_now = datetime.utcnow().isoformat()
            for run_id, row in merged.items():
                await db.execute(
                    """INSERT INTO pilot_behaviour_snapshots
                       (survey_run_id, user_id, session_id, blink_rate_before, blink_rate_after,
                        pupil_dilation_before, pupil_dilation_after, response_latency_ms,
                        captured_before_at, captured_after_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        run_id, row["user_id"], row["session_id"],
                        row.get("blink_rate_before"), row.get("blink_rate_after"),
                        row.get("pupil_dilation_before"), row.get("pupil_dilation_after"),
                        row.get("response_latency_ms"),
                        row.get("captured_before_at"), row.get("captured_after_at"),
                        migrate_now, migrate_now,
                    ),
                )
            await db.execute("DROP TABLE pilot_behaviour_snapshots_old")
            logger.info(
                "[DB] Migrated %d pilot_behaviour_snapshots row(s) from phase layout to before/after layout",
                len(merged),
            )

        # Manager "Wellbeing Assistant" chat history. One chat_sessions row per
        # conversation; many chat_messages per chat. See docs/manager-chat.md.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS chat_sessions (
                chat_id    TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(user_id),
                title      TEXT,
                scope      TEXT NOT NULL DEFAULT 'manager',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # 'scope' separates the manager (org) surface from the personal (guest)
        # surface so a user's two chat lists never mix. Additive migration for
        # DBs created before the column existed (defaults to 'manager').
        try:
            await db.execute(
                "ALTER TABLE chat_sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'manager'"
            )
        except aiosqlite.OperationalError:
            pass  # column already present
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
        for name, password, role, department, shift, job_title in SEED_USERS:
            user_id = str(uuid.uuid4())
            password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            await db.execute(
                """INSERT OR IGNORE INTO users
                   (user_id, name, password_hash, role, department, shift, job_title, active, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (user_id, name, password_hash, role, department, shift, job_title, now),
            )
            # Keep an existing seed account's role/attributes in sync (idempotent).
            await db.execute(
                "UPDATE users SET role = ?, department = ?, shift = ?, job_title = ? WHERE name = ?",
                (role, department, shift, job_title, name),
            )

        await db.commit()

    logger.info("[DB] Database initialised at %s with %d seed users", DB_PATH, len(SEED_USERS))


if __name__ == "__main__":
    asyncio.run(init_db())
