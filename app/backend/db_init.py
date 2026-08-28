
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

        # Generic per-question response table — one row per answered question,
        # for any survey type (not just PILOT). Replaces the need for fixed
        # response_1..4 / item_7/11/13-style columns going forward.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS survey_item_responses (
                id                        INTEGER PRIMARY KEY AUTOINCREMENT,
                survey_run_id             TEXT NOT NULL REFERENCES survey_records(survey_run_id),
                user_id                   TEXT NOT NULL REFERENCES users(user_id),
                session_id                TEXT,
                question_id               TEXT NOT NULL,
                domain                    TEXT,
                raw_score                 INTEGER,
                effective_score           INTEGER,
                voice_sentiment           TEXT,
                blink_rate_change_percent REAL,
                pupil_mm_change           REAL,
                left_gaze_position        TEXT,
                right_gaze_position       TEXT,
                response_latency_ms       REAL,
                created_at                TEXT NOT NULL,
                UNIQUE (survey_run_id, question_id)
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_survey_item_responses_run
            ON survey_item_responses(survey_run_id)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_survey_item_responses_user
            ON survey_item_responses(user_id, created_at)
        """)

        # Per-second timeline log for a survey run: one row per elapsed second,
        # covering the whole session (not just answered questions). turn_state
        # is agent_question | agent_other | user_answer | idle — resolved by
        # matching the agent's spoken transcript against the survey's question
        # bank (see ciq.realtime.timeline_capture). question_id/question_index
        # are only set while a matched question is being asked or its answer
        # window is open. Buffered in memory for the whole survey and bulk
        # inserted once at report time (same pattern as survey_item_responses).
        await db.execute("""
            CREATE TABLE IF NOT EXISTS survey_timeline_frames (
                id                        INTEGER PRIMARY KEY AUTOINCREMENT,
                survey_run_id             TEXT NOT NULL REFERENCES survey_records(survey_run_id),
                session_id                TEXT,
                user_id                   TEXT NOT NULL REFERENCES users(user_id),
                frame_index               INTEGER NOT NULL,
                timestamp                 TEXT NOT NULL,
                turn_state                TEXT NOT NULL,
                question_id               TEXT,
                question_index            INTEGER,
                blink_rate_bpm            REAL,
                blink_rate_change_percent REAL,
                pupil_mm_change           REAL,
                left_gaze_position        TEXT,
                right_gaze_position       TEXT,
                face_emotion              TEXT,
                voice_sentiment           TEXT,
                stress_state              TEXT,
                created_at                TEXT NOT NULL,
                UNIQUE (survey_run_id, frame_index)
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_survey_timeline_frames_run
            ON survey_timeline_frames(survey_run_id, frame_index)
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

        # Recovery Window: one row per intake attempt (never overwritten — a retake
        # creates a new row so a user's whole recovery history is preserved, same
        # pattern as survey_records vs. user_sessions). status walks through
        # not_started -> intake_in_progress -> track_recommended ->
        # session_in_progress -> completed, or short-circuits to urgent_support /
        # grounding_only if the safety question trips (see ciq/recovery/guardrails.py).
        # aggregate_eligible is reserved for a future k-anonymity manager-facing
        # aggregate view (docs/recovery-window.md) — unused/unset for now.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS recovery_window_sessions (
                recovery_session_id              TEXT PRIMARY KEY,
                user_id                          TEXT NOT NULL REFERENCES users(user_id),
                survey_run_id                    TEXT REFERENCES survey_records(survey_run_id),
                status                           TEXT NOT NULL DEFAULT 'not_started',
                preliminary_track                TEXT,
                preliminary_rationale             TEXT,
                recommended_track                TEXT,
                recommendation_rationale         TEXT,
                session_length_minutes           INTEGER,
                selected_track                   TEXT,
                grounding_only_mode              INTEGER NOT NULL DEFAULT 0,
                is_safety_flagged                INTEGER NOT NULL DEFAULT 0,
                safety_flag_reviewed             INTEGER NOT NULL DEFAULT 0,
                safety_flag_reviewed_by          TEXT REFERENCES users(user_id),
                safety_flag_reviewed_at          TEXT,
                reflection_feels_more_settled    INTEGER,
                reflection_perceived_helpfulness INTEGER,
                reflection_next_step_chosen      TEXT,
                reflection_wants_follow_up       INTEGER,
                aggregate_eligible                INTEGER NOT NULL DEFAULT 0,
                created_at                       TEXT NOT NULL,
                updated_at                       TEXT NOT NULL
            )
        """)

        # Migrations for a recovery_window_sessions table created before a column
        # existed (e.g. an earlier build of this feature) — CREATE TABLE IF NOT
        # EXISTS above is a no-op against an already-existing table, so every
        # column beyond the always-present core (id/user_id/survey_run_id/status/
        # created_at/updated_at) is added explicitly here, same idempotent
        # try/except pattern used for `users` above.
        for stmt in (
            "ALTER TABLE recovery_window_sessions ADD COLUMN preliminary_track TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN preliminary_rationale TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN recommended_track TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN recommendation_rationale TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN session_length_minutes INTEGER",
            "ALTER TABLE recovery_window_sessions ADD COLUMN selected_track TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN grounding_only_mode INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE recovery_window_sessions ADD COLUMN is_safety_flagged INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE recovery_window_sessions ADD COLUMN safety_flag_reviewed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE recovery_window_sessions ADD COLUMN safety_flag_reviewed_by TEXT REFERENCES users(user_id)",
            "ALTER TABLE recovery_window_sessions ADD COLUMN safety_flag_reviewed_at TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN reflection_feels_more_settled INTEGER",
            "ALTER TABLE recovery_window_sessions ADD COLUMN reflection_perceived_helpfulness INTEGER",
            "ALTER TABLE recovery_window_sessions ADD COLUMN reflection_next_step_chosen TEXT",
            "ALTER TABLE recovery_window_sessions ADD COLUMN reflection_wants_follow_up INTEGER",
            "ALTER TABLE recovery_window_sessions ADD COLUMN aggregate_eligible INTEGER NOT NULL DEFAULT 0",
        ):
            try:
                await db.execute(stmt)
            except aiosqlite.OperationalError:
                pass  # column already present
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_recovery_window_sessions_user
            ON recovery_window_sessions(user_id, created_at DESC)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_recovery_window_sessions_run
            ON recovery_window_sessions(survey_run_id, created_at DESC)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_recovery_window_sessions_flagged
            ON recovery_window_sessions(is_safety_flagged, safety_flag_reviewed, created_at DESC)
        """)

        # One row per answered intake question (spec's 9-question set — see
        # ciq/recovery/intake_questions.py). theme is denormalised from the
        # canonical question list at write time so this table stays readable on
        # its own (e.g. for the admin flagged-session review) without a join.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS recovery_window_intake_responses (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                recovery_session_id  TEXT NOT NULL REFERENCES recovery_window_sessions(recovery_session_id),
                user_id              TEXT NOT NULL REFERENCES users(user_id),
                question_id          TEXT NOT NULL,
                theme                TEXT,
                answer_value         TEXT,
                created_at           TEXT NOT NULL,
                UNIQUE (recovery_session_id, question_id)
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_recovery_window_intake_responses_session
            ON recovery_window_intake_responses(recovery_session_id)
        """)

        # One row per delivered guided-track step (ciq/recovery/track_scripts.py),
        # so a session's guided-track transcript can be reconstructed for review.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS recovery_window_track_progress (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                recovery_session_id  TEXT NOT NULL REFERENCES recovery_window_sessions(recovery_session_id),
                user_id              TEXT NOT NULL REFERENCES users(user_id),
                track_id             TEXT NOT NULL,
                step_index           INTEGER NOT NULL,
                step_id              TEXT NOT NULL,
                step_text            TEXT,
                acknowledged         INTEGER NOT NULL DEFAULT 0,
                created_at           TEXT NOT NULL,
                UNIQUE (recovery_session_id, step_index)
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_recovery_window_track_progress_session
            ON recovery_window_track_progress(recovery_session_id)
        """)

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
