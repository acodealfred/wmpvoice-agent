# Pilot Data Platform — Applicable Changes & Timeline

Source: `CIQ_Platform_Required_Changes.pdf` (20 July 2026 scientific/technical review).
This doc narrows that review down to what's realistically buildable *right now*
given the current codebase, and estimates effort as a solo backend developer
would plan it — with buffer, and with specialist/research-team dependencies
called out explicitly.

Full field-level implementation plan (schema, functions, call sites) lives at
the bottom of this doc under [Implementation reference](#implementation-reference).

---

## 1. What's applicable right now

The review document lists ~10 sections of change (scoring validation → pupil
CV pipeline → device integration → ML model validation → operational
dashboard). Most of that is multi-week, multi-specialist greenfield work that
depends on earlier phases landing first (see the document's own Recommended
Sequence). Five P0 items are buildable immediately against the existing
codebase, with no new specialist skillset required:

| # | Item | Why it's applicable now |
|---|---|---|
| 1 | Item-level response table | Replaces fixed `response_1..4`/`item_7/11/13` columns with a generic per-question table. Real pilot data already exists in the old tables, so this needs a backfill + reconciliation check, not a bare cutover. |
| 2 | Research-ID / deidentification layer | `research_participant_id` generated separately from `user_id`; pilot export reworked to key off it. Direct precedent already exists in the codebase (`auth.py` mints `session_id` alongside `session_token` the same way). |
| 3 | Scoring-validation test suite | Per-instrument dummy-profile tests (BAT-4, CBI-3) — known responses → known total/category. Extends test infrastructure that already exists (`tests/unit/test_survey_loader.py`). |
| 4 | Consent versioning + withdrawal (record-only) | Adds `consent_version`/`withdrawn_at` to `user_consents` and a withdraw endpoint. Enforcement (blocking a withdrawn user from new sessions) is explicitly deferred — see open items below. |
| 5 | Data-quality flags on biometrics (annotate-only) | Face-not-detected/multi-face signals already exist end-to-end and just need surfacing; low-FPS is new instrumentation, threshold TBD by research team. |

**Deferred, not applicable yet** (needs Phase 1 above to land first, per the
document's own sequencing): pupil/iris CV pipeline (§2), device-adapter layer
for EEG/HRV (§4), time-series biometric storage (§5 beyond item-level), the
full scientific preprocessing → feature-selection → model-training →
validation pipeline (§6), measured/predicted output separation on the
dashboard (§7), and the two-mode dashboard split (§8). None of these are
buildable in parallel with the 5 items above without specialist input (see
§3 below).

---

## 2. Timeline (solo backend developer, sequential, with buffer)

Build order follows the dependency chain confirmed in planning: **1 → 2 → 3 → 4 → 5**
(2 depends on 1 landing first; 3/4/5 are independent but sequenced this way
so scoring tests and consent/quality work land against a stable base).

Estimates assume ~1 backend developer at realistic (not 100%-dedicated)
capacity, plus a frontend touch-point for item 5. "Buffer" = time for review,
fixing test failures, and the reconciliation step in item 1 — not padding for
its own sake.

| Week | Item | Core effort | Buffer | Notes |
|---|---|---|---|---|
| **1** | Item 1 — item-level response table | 3 dev days | 2 days | Buffer covers running the backfill against a **copy** of the real pilot DB and manually reviewing the reconciliation log before cutting over the write path in production. Do not skip this — real participant data is involved. |
| **2** | Item 2 — research-ID layer + export rework | 3 dev days | 1–2 days | Buffer covers verifying the reworked multi-sheet export still matches what researchers currently get from the flat sheet. |
| **3** | Item 3 — scoring-validation tests | 1.5 dev days | 1 day | Buffer covers getting instrument threshold sign-off from the research team (see §3) before treating the tests as authoritative. |
| **3–4** | Item 4 — consent versioning + withdrawal (record-only) | 2 dev days | 1 day | Buffer covers a short product/legal review of withdrawal semantics (see open items). |
| **4** | Item 5 — data-quality flags (backend + frontend FPS) | 2 dev days backend + 2–3 dev days frontend | 1–2 days | Needs an actual FPS threshold from the research team before it means anything (currently a placeholder). Frontend FPS measurement can run in parallel with items 3/4 if a second developer is available. |
| **5** | Integration pass | — | 2–3 days | End-to-end pilot run through the UI, full `pytest app/backend`, review of the reconciliation log, sign-off. |

**Total: ~4–5 calendar weeks solo, ~3–4 weeks with a second developer taking
item 5's frontend half in parallel.** This is a rough planning estimate, not
a commitment — the item 1 backfill/reconciliation step in particular is
unpredictable until it's actually run against the real data.

---

## 3. Where a specialist or the research team is needed

Not everything here is a pure engineering call. Flagging explicitly so these
don't get decided by default inside a code change:

| Decision | Who should weigh in | Why it's not just an engineering call |
|---|---|---|
| Low-FPS threshold (item 5) | Research team | No existing signal in the codebase to derive a number from — needs to reflect what the blink/pupil measurement pipeline actually requires to stay valid. |
| WIB-3 in/out of scope (item 3) | Research team | No WIB-3 survey config exists anywhere in the repo today; confirmed deferred for this pass, but the research team should confirm it's genuinely out of scope for the pilot, not just missing. |
| Instrument scoring thresholds (item 3) | Research team / clinical reviewer | The tests validate that the *code* matches the *configured* BAT-4/CBI-3 bands — they don't validate that those bands are the scientifically correct ones. Someone with domain expertise should sign off on `pilot-survey.json`'s thresholds against the published instruments. |
| Consent withdrawal enforcement policy (item 4) | Product owner / legal / IRB-equivalent | Whether a withdrawn participant should be blocked from new sessions is a protocol/compliance decision, not a technical default — deferred in this pass pending that answer. |
| Research-ID reversibility (item 2) | Privacy/compliance advisor | Current plan stores it as a plain admin-readable column (same trust boundary as everything else in this codebase). If the pilot's ethics approval requires a stronger separation (e.g., a genuinely separate key-management store), that changes the design and should be confirmed before, not after, building it. |

Beyond the 5 items in scope now, later phases from the source document
require skillsets this team doesn't need yet but will for those phases:

- **Pupil/iris measurement pipeline (§2 of the source doc)** — needs a
  computer-vision engineer (face→eye→iris→pupil segmentation, ellipse
  fitting, head-pose correction). Not a general web-dev task.
- **Biometric device integration (§4)** — needs someone with EEG/HRV
  hardware/SDK integration experience; device selection itself needs
  research-team input on which device meets "research-grade raw data"
  requirements.
- **Scientific pipeline / model validation (§6)** — needs a data
  scientist/biostatistician for feature selection, model comparison, and
  train/validation participant separation. This is explicitly gated behind
  the item-level data (item 1) and device integration being in place first.

---

## Implementation reference

Exact schema, function signatures, call-site changes, and file-by-file diff
scope for the 5 items above. **Nothing below has been executed yet** — this
is the approved plan, kept here for full visibility in one place.

### Context

`CIQ_Platform_Required_Changes.pdf` calls for CIQ to move from a
questionnaire-and-dashboard MVP toward a scientifically defensible
data-collection platform. A review of the codebase confirmed the platform is
genuinely behind on the document's P0 items: survey answers are stored as
fixed per-instrument columns rather than a generic item-level table, there is
no research-ID/deidentification layer (real `user_id` is used directly in
every pilot table and the export), scoring is tested only at the mechanics
level (no per-instrument "known responses → known result" validation),
consent is recorded but never versioned or revocable, and the biometrics
pipeline has no data-quality flags at all.

**Confirmed:** `pilot_bat4_scores` / `pilot_cbi3_scores` already hold real
pilot-participant data — so item 1 needs a verified backfill + reconciliation
step before cutover, not a bare hard-cutover. Consent withdrawal (item 4) is
**record-only, no enforcement** for this pass.

All schema changes follow the existing `db_init.py` conventions already in
the file: `CREATE TABLE IF NOT EXISTS` for new tables, `ALTER TABLE ... ADD
COLUMN` wrapped in `try/except aiosqlite.OperationalError` for additive
columns, and the rename→recreate→copy→drop pattern (already used for
`pilot_behaviour_snapshots`) when a `PRIMARY KEY` shape must change. No new
migration framework.

### Item 1 — Item-level response table

**Schema** (`app/backend/db_init.py`):

```sql
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
    gaze_position             TEXT,
    response_latency_ms       REAL,
    display_order             INTEGER,
    created_at                TEXT NOT NULL,
    UNIQUE (survey_run_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_item_responses_run  ON survey_item_responses(survey_run_id);
CREATE INDEX IF NOT EXISTS idx_survey_item_responses_user ON survey_item_responses(user_id, created_at);
```

`display_order` records insertion order in the `snapshots` list as a
best-effort ordering proxy — there is no true per-question timestamp
anywhere in the system today (`SessionState.survey_results` has no
`answered_at` key), so this plan does not invent one.

**Backfill (real data exists — do this carefully):**

1. Add a tiny `schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT)` table.
2. One-time backfill in `init_db()`, guarded by `'backfill_survey_item_responses' NOT IN schema_migrations`: for every existing `survey_records` row, parse its `survey_results` JSON (already per-question-shaped via `serialize_survey_results`) and insert one `survey_item_responses` row per question. `pupil_mm_change` will be `NULL` for all backfilled rows (today's `serialize_survey_results` drops it) — acceptable, flag it in a log line.
3. **Reconciliation check (required given real data is involved):** for every backfilled PILOT run, recompute BAT-4/CBI-3 section totals from the new rows via `survey_loader.compute_section_scores()` and compare against the frozen `pilot_bat4_scores.total_score` / `pilot_cbi3_scores.total_score`. Log (don't crash on) any mismatch.

**`db.py`:**

```python
async def save_survey_item_responses(
    survey_run_id: str, user_id: str, session_id: str | None,
    survey_config: dict, snapshots: list[dict],
) -> None:
    """Upsert one row per answered question for a survey run (any survey type).
    Computes effective_score via survey_loader so this table can never diverge
    from the deterministic report. Built from snapshots (raw request body),
    not serialize_survey_results, because snapshots still carries pupilMmChange."""

async def get_survey_item_responses(survey_run_id: str) -> list[dict]: ...
```
Uses `INSERT ... ON CONFLICT(survey_run_id, question_id) DO UPDATE`, one execute per item (looping `enumerate(snapshots)` for `display_order`), following `save_bat4_scores`'s existing style.

**Call-site changes:** `ciq/reports/routes.py::analyze_report()` — call `save_survey_item_responses(...)` unconditionally (all survey types) right after the existing `save_survey_record_results(...)` call. Also add the same call in `generate_ssot_report()` for the case where `/analyze-report` was never hit directly.

**Cutover of `pilot_bat4_scores` / `pilot_cbi3_scores`:** do not drop the tables — existing rows stay as-is, permanently queryable. After the reconciliation check passes (or logged discrepancies are reviewed), remove the `save_bat4_scores(...)` / `save_cbi3_scores(...)` calls from `_persist_pilot_subscales()` — stop writing to the fixed-column tables going forward. `pilot_behaviour_snapshots` is untouched (it's inherently whole-window data, not per-item).

### Item 2 — Research-ID / deidentification layer

**Schema:**
```sql
-- ALTER TABLE users ADD COLUMN research_participant_id TEXT (wrapped in try/except)
-- one-time backfill: uuid4() for every existing NULL row
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_research_participant_id ON users(research_participant_id);
```

Minted the same way `auth.py::login()` already mints `session_id` alongside `session_token` — inline in `auth.py::signup()`:
```python
user_id = str(uuid.uuid4())
research_participant_id = str(uuid.uuid4())
await create_user(user_id, name, password_hash, role="employee", research_participant_id=research_participant_id)
```
`db.create_user()` gains `research_participant_id: str | None = None`; `SEED_USERS` in `db_init.py` mints one per seed user too, so fixtures stay consistent.

**`db.py`:**
```python
async def get_or_create_research_participant_id(user_id: str) -> str: ...   # lazy-generate for pre-migration rows
async def get_research_participant_id_for_user(user_id: str) -> str | None: ...
async def get_user_id_for_research_participant_id(research_participant_id: str) -> str | None: ...  # admin reverse lookup
```
Trust boundary: `research_participant_id` is a plain column on `users`, reversible by anyone with admin-route access — the same trust boundary as every other admin-gated field in this codebase today.

**Export rework** (`ciq/api/history_routes.py`, depends on item 1) — replace `db.get_pilot_survey_export_rows()` with:
```python
async def get_pilot_item_export_rows() -> list[dict]:
    """One row per (survey_run_id, question_id) for PILOT runs, joined only to
    users.research_participant_id — never selects name/department/etc."""

async def get_pilot_behaviour_export_rows() -> list[dict]:
    """Same join shape as today's pilot_behaviour_snapshots read, re-keyed to research_participant_id."""
```
`admin_export_pilot_survey()` becomes a multi-sheet workbook:

1. **"Item Responses"** — long format, one row per `(survey_run_id, question_id)`, straight from `survey_item_responses`, keyed by `research_participant_id` + `survey_run_id`.
2. **"Section Scores"** — one row per run; grouped item rows fed into `survey_loader.compute_section_scores()` to get BAT-4/CBI-WRB3 totals — recomputed the same way the live report computes them, so the export can never diverge from scoring logic.
3. **"Behaviour Windows"** — same data as today (`pilot_behaviour_snapshots`), re-keyed to `research_participant_id` instead of carrying no participant key at all.
4. **"Legacy Summary"** — reproduces today's exact single-row-per-run flat layout (same 10 columns, same order: Index, BAT-4 total/average, CBI-WRB3 total/average, blink/pupil before-after, response latency), computed from sheets 1–3 rather than the old fixed-column tables. Kept so any existing analysis workflow built against the current export format keeps working unchanged, even though the underlying tables it's sourced from have changed.

Nothing existing is removed. RBAC: no new mechanism needed — everything stays under the existing `_ADMIN_PREFIXES` table in `auth.py`.

### Item 3 — Scoring-validation test suite

New file `app/backend/tests/unit/test_scoring_validation.py` — per-instrument "dummy participant profile" tests distinct from the existing mechanics tests in `test_survey_loader.py` (which stay as-is):

```python
PILOT = load_survey("PILOT")

def test_bat4_profile_low_burnout_all_never(): ...      # bat_q1-4 = 1,1,1,1 -> avg 1.0 -> Low
def test_bat4_profile_high_burnout_all_always(): ...    # bat_q1-4 = 5,5,5,5 -> avg 5.0 -> High
def test_bat4_profile_moderate_mixed(): ...             # e.g. 3,3,2,3 -> avg 2.75 -> Moderate
def test_cbi3_profile_low_burnout(): ...
def test_cbi3_profile_high_burnout_with_reverse_item(): ...  # explicit reverse-scoring assertion on item 13
def test_full_pilot_survey_end_to_end_profile(): ...    # compute_survey_summary(PILOT, full_snapshot_set)
```
Each docstring cites the instrument's actual cutoff source from `pilot-survey.json` so a reviewer can audit thresholds against the literature, not just the code.

New integration test `app/backend/tests/integration/test_pilot_scoring_e2e.py` — extends the existing `StubRtmt`/`report_client` fixture pattern from `test_analyze_report.py`, posts a dummy PILOT profile to `/analyze-report`, and asserts both the response `sections` totals/bands and (once item 1 lands) that `survey_item_responses` contains the expected rows.

**WIB-3 confirmed out of scope** — no survey config or scoring logic exists for it anywhere in the repo.

### Item 4 — Consent versioning + withdrawal (record-only)

`user_consents`'s PK today is `(user_id, consent_type)` — versioning needs history preserved across re-consents, so this uses the rename→recreate→copy→drop pattern (same as `pilot_behaviour_snapshots`'s existing migration):

```sql
CREATE TABLE user_consents (
    user_id         TEXT NOT NULL REFERENCES users(user_id),
    consent_type    TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    accepted_at     TEXT NOT NULL,
    withdrawn_at    TEXT,
    PRIMARY KEY (user_id, consent_type, consent_version)
);
```
Migration copies every existing row forward with `consent_version = 'v1'`, `withdrawn_at = NULL`. New small file `app/backend/consent_config.py`: `CURRENT_CONSENT_VERSION = {"pilot_study": "v1"}`.

**`db.py`:**
```python
async def get_user_consent(user_id, consent_type="pilot_study") -> dict | None: ...       # most recent row
async def record_user_consent(user_id, consent_type="pilot_study", consent_version=None) -> None: ...  # clears withdrawn_at on re-accept
async def withdraw_user_consent(user_id, consent_type="pilot_study") -> bool: ...
async def get_consent_history(user_id, consent_type="pilot_study") -> list[dict]: ...
```

**Routes** (`ciq/api/consent_routes.py`): `GET /consent` gains additive fields (`version`, `withdrawnAt`, `currentVersion` — frontend today only reads `accepted`, so this stays backward compatible); `POST /consent` accepts optional `consent_version`; new `POST /consent/withdraw` handler.

**Explicitly out of scope for this pass:** no enforcement. A withdrawn user can still start new PILOT surveys / connect to `/realtime` — this pass only records the fact.

### Item 5 — Data-quality flags on biometrics capture (annotate-only)

Face-not-detected and multi-face signals **already exist end-to-end** — `analyze_face()` already returns sentinel strings `"No face detected"` / `"multiple_faces_detected"`, already forwarded through `POST /biometrics` into `sess.current_face_emotion`, already read at answer-time in `survey_tool()`. Low-FPS has **no existing signal** — genuinely new instrumentation, needing a webcam FPS measurement on the frontend that doesn't exist today.

1. `ciq/biometrics/routes.py::analyze_face()` — additive `dataQuality: {faceNotDetected, multiFace}` field on the response.
2. `ciq/realtime/routes.py::update_biometrics()` — accept optional `fps: float | None`, derive `low_fps` server-side against `MIN_ACCEPTABLE_FPS = 15.0` (placeholder — needs a real value from the research team).
3. `ciq/realtime/session.py::SessionState` — add `current_low_fps: bool = False` plus a `data_quality_flags()` helper deriving all 3 flags; reset alongside the other `current_*` resets.
4. `ciq/realtime/tools/handlers.py::survey_tool()` — spread the 3 flags into both `sess.survey_results[question_id]` and the `client_message["snapshot"]` dict, so they round-trip through the frontend back to `/analyze-report`.
5. `db.py::save_survey_item_responses()` — extend `survey_item_responses` with 3 more nullable columns (`face_not_detected`, `multi_face`, `low_fps`) via `ALTER TABLE`, populated straight from `snapshots[i]`.

**Frontend touch-points required for real (non-null) data:** `useBiometrics.ts` / `useVideoCapture.ts` need to measure actual frame rate and send it on the `/biometrics` POST; `types.ts`'s `BiometricSnapshot` interface needs the 3 new optional fields.

Data-quality flags are **annotate-only** — nothing is rejected or blocked server-side.

### File-by-file diff scope

| File | Item(s) | Scope |
|---|---|---|
| `app/backend/db_init.py` | 1,2,4,5 | New table + indexes + backfill + reconciliation log (1); `ALTER TABLE users` + backfill + unique index (2); consent table migration (4); 3 `ALTER TABLE` (5). Medium-large. |
| `app/backend/db.py` | 1,2,4 | New save/reader functions (1); new functions + reworked export functions (2); reworked consent functions (4). Medium. |
| `app/backend/ciq/reports/routes.py` | 1 | New call in `analyze_report()` + `generate_ssot_report()`; remove 2 calls from `_persist_pilot_subscales()`. Small. |
| `app/backend/auth.py` | 2 | `signup()` mints `research_participant_id`; `create_user()` gains a param. Small. |
| `app/backend/ciq/api/consent_routes.py` | 4 | Rework 2 handlers, add 1 new handler. Small. |
| `app/backend/ciq/api/history_routes.py` | 2 | Rework export into multi-sheet builder. Medium. |
| `app/backend/ciq/server.py` | 2,4 | 1-2 new route registrations. Trivial. |
| `app/backend/ciq/realtime/session.py` | 5 | +1 field, +1 helper, extend reset methods. Small. |
| `app/backend/ciq/realtime/routes.py` | 5 | `update_biometrics()` gains fps/low_fps handling. Small. |
| `app/backend/ciq/realtime/tools/handlers.py` | 5 | `survey_tool()` spreads 3 new keys into 2 dicts. Small. |
| `app/backend/ciq/biometrics/routes.py` | 5 | `analyze_face()` gains `dataQuality`. Trivial. |
| `app/backend/consent_config.py` | 4 | New file (a dict). Trivial. |
| `app/backend/tests/unit/test_scoring_validation.py` | 3 | New file, ~10 test functions. Medium. |
| `app/backend/tests/integration/test_pilot_scoring_e2e.py` | 3 | New file, extends existing fixture pattern. Small-medium. |
| `app/frontend/src/hooks/useBiometrics.ts` / `useVideoCapture.ts` | 5 | FPS measurement + send on `/biometrics`. Not backend, but needed for real data. Medium. |
| `app/frontend/src/types.ts` | 5 | 3 new optional fields. Trivial. |

### Verification

- `pytest app/backend/tests/unit/test_scoring_validation.py app/backend/tests/unit/test_survey_loader.py -v` — instrument-level and mechanics-level scoring checks.
- `pytest app/backend/tests/integration/test_pilot_scoring_e2e.py -v` — end-to-end `/analyze-report` → `survey_item_responses` check.
- Full suite: `pytest app/backend`.
- Manual: run `./scripts/start.sh`, complete one PILOT survey run through the UI, then inspect `survey_item_responses` rows and the reworked `/admin/pilot-survey/export` multi-sheet output to confirm section totals recomputed from item rows match what the report UI showed live.
- Reconciliation log from the item-1 backfill should be reviewed manually once (on a copy of the real pilot DB, not in-place) before the cutover removes the old write path in production.
