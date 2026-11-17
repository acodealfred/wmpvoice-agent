# Changelog

## ciq-alpha-v3 — 2026-11

Branch `feature/ciq-alpha-v3`, compared with `release/ciq-alpha-v2` (41 commits).

### ⚠️ Upgrade notes — read before deploying

- **Realtime GA protocol.** Azure retired the Realtime *preview* API (it now
  fails with `realtime_beta_access_required`). The middle tier now uses the GA
  endpoint, `/openai/v1/realtime?model=<deployment>` (`ciq/realtime/ga_protocol.py`).
  `AZURE_OPENAI_REALTIME_DEPLOYMENT` must name a **GA** realtime deployment;
  `infra/main.bicep` provisions `gpt-realtime`. A `*-preview` deployment will
  not connect.
- **Schema migrations run automatically** on startup (`db_init.init_db`). Each
  one is idempotent: `ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`. New tables:
  `survey_item_responses`, `survey_timeline_frames`, `consent_events`,
  `recovery_window_sessions` / `_intake_responses` / `_track_progress`,
  `eeg_sessions`, `eeg_session_segments`, `password_reset_requests`,
  `report_pdfs`, `report_download_requests`. New `survey_records` columns:
  status/segment, the per-run `baseline_*`, and `report_download_count`. Take a
  DB backup first (see `docs/persistence.md`).
- **New feature flags.** All of these are **on by default**; set one to `false`
  to turn it off: `ENABLE_RECOVERY_WINDOW_VOICE`, `ENABLE_VOICE_FEATURES`,
  `ENABLE_LIVE_MONITOR`, `ENABLE_SIGNAL_COMPARISON`.
- **Only the PILOT survey is offered** on the assessment page
  (`AVAILABLE_SURVEY_TYPES = ["PILOT"]`). TEST, BATFULL, CBTFULL and the new
  READINESS definitions still exist in `survey_loader`.
- **Python dependencies are now fully pinned**, transitive ones included, in
  `requirements.txt`. New direct dependencies: `praat-parselmouth`, `numpy`,
  `scipy` (voice features); `reportlab`, `pillow`, `markdown-it-py` (PDFs).
  `gunicorn` moved from the Dockerfile into `requirements.txt`.
- **Single replica is still required.** Live Monitor data and QR share tokens
  are held in memory, in addition to the existing Litestream constraint.

### Added

**Assessment**
- Assessment lifecycle: Start / Pause / Continue / Close, with at most one open
  run per user and resumable runs (`docs/assessment-lifecycle.md`).
- Per-run two-phase resting baseline (eyes open, then eyes closed), replacing
  the per-user 12 h baseline.
- Per-second timeline covering the baseline as well, plus per-eye gaze position
  and the user's own words per answer (Whisper transcripts).
- Consent form shown on each assessment entry, with an audit trail (`consent_events`).
- Readiness survey: a natural-conversation, qualitative survey definition
  (`surveys/readiness-survey.json`). Not exposed in the UI yet.

**Sensors**
- Muse 2 / Muse S EEG headband over Web Bluetooth: recording per segment,
  battery indicator, per-sensor contact lights with fix guidance, and combined
  timeline + EEG export (`docs/muse-integration.md`, `docs/muse-2-findings.md`).
- Voice features: pitch, loudness and pauses of the user's speech, per second
  and per answer (`docs/voice-features.md`).

**Reports**
- Spoken PILOT report: a deterministic, numberless brief, voiced on Start with
  Pause/Continue, and automatically continued if Azure cuts it off at the
  output limit (`docs/reports.md`).
- Report cards: change since the last assessment, Fatigue ↔ Burnout zone and
  trend, and "your signals compared with your past check-ins"
  (`docs/signal-comparison.md`).
- Saved reports can be reopened from History (user) and Data Validation (admin).
- QR download: download the report PDF to a phone, once per report, with
  admin-approved extra downloads. The on-screen report is captured as a PDF in
  the browser.
- Admin bulk export: one participant-facing PDF per completed report, as a ZIP.

**Recovery and accounts**
- Recovery Window: an optional voice-guided post-report check-in with a
  9-question intake, safety interlock and four guided recovery tracks
  (`docs/recovery-window.md`).
- Forgot password: request from the login page, approve in the Admin panel,
  then a 2-minute window to set the new password.

**Admin**
- Data Validation dashboard: per-run data-quality checks and a ZIP export
  (`docs/data-validation-dashboard.md`).
- Live Monitor: per-second data health of running assessments (EEG, contact,
  camera), in memory only.
- Participant-map CSV (`P###` usernames → user ids) for research matching.

### Changed
- The manager dashboard and its terminology were adapted to the oil-and-gas domain.
- Verbal report wording; blink-rate bands; eye-biometrics fixes.
- Mobile layout fixes and general UI polish.

### Known gaps
- The Recovery Window crisis / grounding messages are **generic placeholders**.
  Replace them with the organisation's EAP and crisis-line details before a
  real rollout (`ciq/recovery/guardrails.py`).
- The Recovery Window package has no automated tests yet.
- Test status at release: backend **573 passed, 1 failed**; frontend **408 passed**.
  The failure is `tests/unit/test_survey_loader.py::test_pilot_summary_replaces_combined_score_with_sections`,
  and the cause is in the test itself. Its `_snap()` helper tags every answer
  with domain `"D"`, but the test expects the PILOT config's domain names.
  `_domain_totals` hasn't changed since v2, so this is not a v3 regression.
- `APP_VERSION` in `ciq/config.py` is still `"v2025-admin-routes"`. Bump it if
  you use `GET /version` to confirm which build is deployed.
