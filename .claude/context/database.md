# CIQ Database & Persistence Architecture

## 1. Engine & Storage Overview

- **Engine**: SQLite 3 accessed asynchronously via `aiosqlite`.
- **Database File**: `app/backend/data/ciq.db`.
- **Concurrency Mode**: WAL mode (`PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`) enabled on startup in `db_init.py`. This ensures readers never block writers.
- **Cloud Replication**: **Litestream** streams WAL frames directly to an Azure Blob container. The DB is restored on startup (`entrypoint.sh`). Requires a **single writer replica**.

---

## 2. Table Schema Catalog (`db_init.py`)

### 1. `users`
Core user identity and RBAC role.
- `user_id` (TEXT PK)
- `name` (TEXT UNIQUE NOT NULL)
- `password_hash` (TEXT NOT NULL, bcrypt)
- `role` (TEXT NOT NULL DEFAULT 'employee') — `'admin'`, `'manager'`, or `'employee'` (formerly 'guest')
- `department`, `shift`, `job_title` (TEXT nullable) — employee organizational metadata
- `is_demo` (INTEGER DEFAULT 0) — flag to separate mock demo data from live pilot data
- `active` (INTEGER DEFAULT 1) — active status (manager dashboards filter `active = 1`)
- `created_at` (TEXT ISO8601)

### 2. `user_sessions`
Active browser authentication sessions.
- `session_token` (TEXT PK), `user_id` (TEXT FK), `session_id` (TEXT)
- `created_at`, `last_active_at` (TEXT ISO8601)
- `survey_results`, `technical_report`, `prompt_info` (TEXT JSON blobs)

### 3. `survey_records`
Permanent log of completed assessment runs (multiple runs per user).
- `survey_run_id` (TEXT PK), `user_id` (TEXT FK), `session_token` (TEXT), `session_id` (TEXT)
- `survey_type` (TEXT), `created_at`, `updated_at` (TEXT ISO8601)
- `survey_results`, `technical_report`, `prompt_info` (TEXT JSON blobs), `is_demo` (INTEGER)

### 4. `survey_item_responses`
Normalized per-question answer records for any survey.
- `id` (INTEGER PK AUTOINCREMENT), `survey_run_id` (TEXT FK), `user_id` (TEXT FK), `session_id` (TEXT)
- `question_id` (TEXT NOT NULL), `domain` (TEXT)
- `raw_score` (INTEGER), `effective_score` (INTEGER, accounts for reverse scoring)
- `voice_sentiment` (TEXT), `blink_rate_change_percent` (REAL), `pupil_mm_change` (REAL)
- `left_gaze_position`, `right_gaze_position` (TEXT), `response_latency_ms` (REAL)
- `created_at` (TEXT ISO8601)

### 5. `survey_timeline_frames`
1-Hz per-second timeline telemetry captured across the full assessment session.
- `id` (INTEGER PK AUTOINCREMENT), `survey_run_id` (TEXT FK), `session_id` (TEXT), `user_id` (TEXT FK)
- `frame_index` (INTEGER NOT NULL), `timestamp` (TEXT), `turn_state` (TEXT: agent_question, agent_other, user_answer, idle)
- `question_id` (TEXT), `question_index` (INTEGER)
- `blink_rate_bpm`, `blink_rate_change_percent`, `pupil_mm_change` (REAL)
- `left_gaze_position`, `right_gaze_position` (TEXT)
- `face_emotion`, `voice_sentiment`, `stress_state` (TEXT)
- `created_at` (TEXT ISO8601)

### 6. `user_baselines`
Personal calibrated resting baseline (recorded once per user).
- `user_id` (TEXT PK FK), `pupil_size` (REAL), `blink_rate` (REAL)
- `created_at`, `updated_at` (TEXT ISO8601)

### 7. `user_consents`
Informed consent acceptance records.
- `user_id` (TEXT FK), `consent_type` (TEXT), `accepted_at` (TEXT ISO8601). PK: `(user_id, consent_type)`.

### 8. `pilot_bat4_scores` & 9. `pilot_cbi3_scores`
Pilot study subscale breakdowns for research export.
- `pilot_bat4_scores`: `survey_run_id` (PK FK), `user_id` (FK), `response_1..4`, `total_score`, `average_score`, `risk_level`
- `pilot_cbi3_scores`: `survey_run_id` (PK FK), `user_id` (FK), `item_7`, `item_11`, `item_13`, `item_13_reversed`, `total_score`, `mean_score`, `risk_level`

### 10. `pilot_behaviour_snapshots`
Pre- and post-assessment 10s biometric capture windows.
- `survey_run_id` (PK FK), `user_id` (FK)
- `blink_rate_before/after` (REAL), `pupil_dilation_before/after` (REAL), `response_latency_ms` (REAL)
- `captured_before/after_at` (TEXT)

### 11. `recovery_window_sessions`
Recovery Window lifecycle records.
- `recovery_session_id` (TEXT PK), `user_id` (TEXT FK), `survey_run_id` (TEXT FK)
- `status` (TEXT: not_started, intake_in_progress, track_recommended, session_in_progress, completed, urgent_support)
- `preliminary_track`, `recommended_track`, `selected_track` (TEXT)
- `grounding_only_mode`, `is_safety_flagged`, `safety_flag_reviewed` (INTEGER 0/1)
- `safety_flag_reviewed_by` (TEXT FK), `safety_flag_reviewed_at` (TEXT)
- `reflection_feels_more_settled`, `reflection_perceived_helpfulness`, `reflection_wants_follow_up` (INTEGER)
- `reflection_next_step_chosen` (TEXT), `aggregate_eligible` (INTEGER)

### 12. `recovery_window_intake_responses` & 13. `recovery_window_track_progress`
- `recovery_window_intake_responses`: Per-question intake answers (`question_id`, `theme`, `answer_value`).
- `recovery_window_track_progress`: Step-by-step progress through audio recovery tracks (`step_id`, `step_text`, `acknowledged`).

### 14. `chat_sessions` & 15. `chat_messages`
Wellbeing Assistant chat history.
- `chat_sessions`: `chat_id` (TEXT PK), `user_id` (TEXT FK), `title` (TEXT), `scope` (TEXT: 'manager' or 'personal')
- `chat_messages`: `message_id` (TEXT PK), `chat_id` (TEXT FK), `role` (TEXT), `content` (TEXT), `citations` (TEXT JSON), `tool_trace` (TEXT JSON)

### 16. `eeg_sessions`
Raw Muse 2 headset session recordings.
- `survey_run_id` (TEXT PK FK), `user_id` (TEXT FK), `device_name`, `preset`, `recorded_at`
- `t0_epoch_ms` (INTEGER), `marker_count` (INTEGER), `dropped_packets_json` (TEXT)
- `file_json` (TEXT NOT NULL, complete JSON payload from `useMuse.ts`)

---

## 3. Migration Pattern

Do NOT use external migration frameworks like Alembic. Instead, follow CIQ's native startup migration pattern inside `init_db()` in `app/backend/db_init.py`:

```python
for stmt in (
    "ALTER TABLE table_name ADD COLUMN new_column TEXT",
    "ALTER TABLE table_name ADD COLUMN another_col INTEGER NOT NULL DEFAULT 0",
):
    try:
        await db.execute(stmt)
    except aiosqlite.OperationalError:
        pass  # column already present
```

---

## 4. Default Seed Accounts

All seed users have default password: `sys123` (hashed via bcrypt on startup):
- **Admins**: `system1`, `system2`, `system3`, `admin1`, `admin2`, `admin3` (role: `admin`)
- **Managers**: `manager1`, `manager2` (role: `manager`)
- **Employees**: `guest1` (Legal), `guest2` (HR), `guest3` (IT) (role: `employee`)
