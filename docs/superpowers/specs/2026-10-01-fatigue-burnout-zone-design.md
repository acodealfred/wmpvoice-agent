# Fatigue ↔ Burnout Zone: Design

- **Status:** Draft for owner review (revised after adversarial review, see §12)
- **Date:** 2026-10-01
- **Branch:** `feature/fatigue-burnout-zone` (from `feat/biometrics-bugs` @ `597b662`)

## 1. Purpose

Give each employee a simple, repeatable picture of where they sit and whether they are improving,
using measurements the app already collects. It is a wellbeing guide. It is not a scientific
instrument and not a diagnosis.

The picture has three parts:
- **Position:** a line from **Fatigue** (short-term tiredness, which rest is likely to fix) to
  **Burnout** (detachment or loss of control, where something about the situation may need to change).
- **Severity:** how much strain overall, in four zones.
- **Direction:** Improving / Steady / Worsening compared with recent check-ins.

### Decisions already made with the owner

| Decision | Choice |
|---|---|
| Scale shape | Two ends (Fatigue ↔ Burnout), plus a separate severity level |
| Biometrics | Supporting "fatigue signals" only. They never move the marker, the severity or the trend. |
| Audience | The person's own data only, on their home screen, their session report and their chat assistant. No manager or team view. |
| Improvement rule | Latest severity vs the average of the previous up to 3 complete runs, with a ±5 dead zone |
| Architecture | Calculate on demand from stored answers (approach A). Nothing new is persisted. |
| Survey scope | PILOT survey only (BAT-4 + CBI-WRB3). Other survey types are ignored. |

### Grounding in the repo
- The owner's `CIQ-Signal-Thresholds-Reference.pdf` (repo root, page 2 §05) says burnout has no
  momentary biometric signature and biometrics can at most add a longitudinal fatigue trend. That
  is why biometrics stay out of the score.
- Biometric changes are relative to a baseline that is overwritten and expires after 12 h
  (`app/backend/db.py:15, 267-311`). Values from different weeks are therefore not strictly comparable.
- The existing employee trend card (`guest-score-trend.tsx:25-29`) and the chat tool
  `get_my_score_trend` (`ciq/chat/tools.py:242-250`) read only `totalScore`. PILOT runs have no
  `totalScore`, so both are empty for PILOT users today. Neither is modified (§8).

## 2. Inputs

**Source.** `survey_records` rows for the logged-in user, fetched with the existing
`get_user_survey_records(user_id)` (`db.py:230-242`, newest first).

**A row is used only if:**
- `(survey_type or "").upper() == "PILOT"`. `survey_type` can be `""` or NULL (`db.py:109-121`).
- `survey_results` is a non-empty JSON object. Rows with NULL, empty or `"{}"` are skipped
  silently; this covers demo rows (`demo_data.py:155-156`) and prompt-only rows. Rows whose JSON
  can't be parsed are skipped with a warning.

**Shape of `survey_results`.** A JSON object keyed by question ID; each entry has `score` (the
**raw** answer), `blinkRateChange` (defaults to `0`) and `responseLatencyMs` (defaults to `null`)
(`survey_loader.py:222-240`).

**Items** (`app/backend/surveys/pilot-survey.json`):

| ID | Wording (short) | Allowed raw values | Reverse | Group |
|---|---|---|---|---|
| `bat_q1` | Mentally exhausted at work | 1, 2, 3, 4, 5 | no | Fatigue |
| `bat_q2` | Struggle to find enthusiasm | 1, 2, 3, 4, 5 | no | Burnout |
| `bat_q3` | Trouble staying focused | 1, 2, 3, 4, 5 | no | Fatigue |
| `bat_q4` | Unable to control emotions | 1, 2, 3, 4, 5 | no | Burnout |
| `cbi_q1` | Work emotionally exhausting (CBI 7) | 0, 25, 50, 75, 100 | no | Fatigue |
| `cbi_q2` | Exhausted in the morning (CBI 11) | 0, 25, 50, 75, 100 | no | Fatigue |
| `cbi_q3` | Energy for family/friends (CBI 13) | 0, 25, 50, 75, 100 | **yes** | Fatigue |

The group assignment is a product judgement, not a validated factor structure. It lives in
`ZONE_CONFIG["groups"]`, and the list of item IDs comes from there. A unit test asserts that the
groups cover exactly the question IDs in `pilot-survey.json`, so a survey edit fails loudly.

**Survey config guard.** The config comes from `load_survey("PILOT")`. That call silently falls back
to the TEST survey if the PILOT file is missing or malformed (`survey_loader.py:36-44`). The zone
code therefore requires `config.get("type") == "PILOT"` and a non-empty `scoringSections`.
Otherwise it raises `ZoneConfigError`, which becomes a logged `500` (§7).

## 3. Scoring (`compute_zone`)

1. **Validity.** Every item ID in `ZONE_CONFIG["groups"]` must be present, and its `score` must be:
   - an `int` that is **not** a `bool`, and
   - a member of that item's allowed option values, taken from
     `options_for_question(config, qid)` (`survey_loader.py:54-66`).

   Membership, not a min/max range, is required because the realtime tool accepts one combined
   list of values for both scales (`ciq/realtime/tools/schemas.py:46-48`), so a `3` on a CBI item
   would pass a range check. If any item fails, `compute_zone` returns `None`: the run is
   *incomplete*, gets no zone and is left out of the trend. A missing answer is never treated as
   0, even though `effective_score()` returns 0 for `None` (`survey_loader.py:86-87`); validity is
   checked first.
2. **Strain per item, 0–100** (higher = more strain):
   - `lo, hi = get_score_bounds(config, qid)` (`survey_loader.py:69-73`)
   - `eff = effective_score(config, qid, raw)` (this flips reverse items exactly once)
   - `strain = (eff − lo) / (hi − lo) × 100`
3. **Fatigue** = the mean strain of the Fatigue group. **Burnout** = the mean strain of the Burnout
   group. Both are kept as floats internally.
4. **Severity** = (Fatigue + Burnout) / 2. The groups are weighted equally even though they have 5
   and 2 items, so the 2 burnout items aren't drowned out.
5. **Rounding.** Every number returned is rounded half-up to an integer:
   `int(Decimal(x).quantize(0, ROUND_HALF_UP))`. This applies to `fatigue`, `burnout`, `severity`,
   `leanValue`, `marker`, `delta` and `ref`. Zone and lean decisions use the **unrounded** values.
   Fatigue moves in steps of 5 and Burnout in steps of 12.5, so severity is always a multiple of
   1.25. That means 24.5, 49.5 and 74.5 can't occur, and rounding never changes a zone.
6. **Severity zone** (based on unrounded severity):

   | Severity | Zone key | Label |
   |---|---|---|
   | < 25 | `well` | Doing well |
   | 25 to < 50 | `mild` | Mild strain |
   | 50 to < 75 | `moderate` | Moderate strain |
   | ≥ 75 | `high` | High strain |

7. **Lean.** `leanValue = Burnout − Fatigue`, from −100 to +100.
   - ≤ −15: `fatigue` ("Fatigue-leaning")
   - ≥ +15: `burnout` ("Burnout-leaning")
   - otherwise: `mixed`
   - If the zone is `well`, `lean = "none"` and `marker = null`. `leanValue` is still returned, and
     the UI shows the line greyed out with no marker.
8. **Marker** on a 0–100 line (0 = Fatigue end, 100 = Burnout end) = `50 + leanValue / 2`. It is
   always within 0–100 by construction, so no clamping is needed.

**Example** (reachable):
- Answers: `bat_q1=4`, `bat_q3=3`, `cbi_q1=75`, `cbi_q2=50`, `cbi_q3=50` (reversed to 50),
  `bat_q2=2`, `bat_q4=2`.
- Fatigue = mean(75, 50, 75, 50, 50) = 60. Burnout = mean(25, 25) = 25.
- Severity = 42.5, which reports as **43**, zone `mild`.
- Lean = −35, so `fatigue`. Marker = 32.5, which reports as **33**.

```json
{ "surveyRunId": "…", "date": "2026-10-01", "fatigue": 60, "burnout": 25, "severity": 43,
  "zone": "mild", "lean": "fatigue", "leanValue": -35, "marker": 33,
  "signals": [ { "key": "blink_up", "label": "Blink rate above your baseline", "approximate": true } ] }
```

## 4. Trend (`compute_trend`)

**Ordering.** `build_zone_trend` sorts the complete runs **ascending** by
`(created_at, survey_run_id)`. `created_at` is an ISO UTC timestamp written when the report is
first saved (`db.py:107-114`). Dates are displayed as `created_at[:10]`, the same as `_assessment_row`
(`tools.py:163`).

**Which run is "latest".** The newest **complete** run. If the newest row is incomplete, it is
ignored.

- **0 complete runs:** `{"status": "none"}`. The UI shows "Complete a check-in to see your zone".
- **1 complete run:** `{"status": "first"}`, labelled "First check-in".
- **≥ 2 complete runs:** `ref` is the mean unrounded severity of the up to 3 complete runs
  immediately before the latest, and `delta = latest − ref`.
  - `delta ≤ −5`: `improving`
  - `delta ≥ +5`: `worsening`
  - otherwise: `steady`
- The output includes `delta`, `ref`, `compared` (the number of earlier runs used, 1–3) and
  `points`: an `[{surveyRunId, date, severity, zone, lean}]` list, oldest first, capped at the 20
  most recent, for the chart.

**Granularity note for the owner.** One answer step moves severity by **6.25** on a burnout-group
item (`bat_q2`, `bat_q4`) but only **2.5** on a fatigue-group item. So against a single previous run,
one changed burnout answer always crosses the ±5 dead zone, while one changed fatigue answer never
does. This is accepted for v1. The thresholds can be changed in `ZONE_CONFIG`.

## 5. Fatigue signals (supporting only)

Signals are calculated only for the **latest** complete run, in `build_zone_trend`. They never
change `severity`, `zone`, `lean` or the trend.

| Key | Condition | Label |
|---|---|---|
| `blink_up` | The mean of the **usable** `blinkRateChange` values for the run is **> +20** (percent above baseline) | "Blink rate above your baseline" |
| `slower` | The median of the run's usable `responseLatencyMs` is **≥ 25% above** the median of the previous up to 3 complete runs' latency medians | "Slower responses than your recent check-ins" |

- **Where the thresholds come from.** +20% is the lower edge of the fatigue/recovery blink row in
  the thresholds PDF ("rate +20–50%"). The existing `blink_band` uses ±15/40 from the
  cognitive-load row, which is the wrong context here. It is **not** reused or string-parsed.
  +25% is the latency "High" band in the same PDF.
- **Usable values.**
  - Blink: numeric, not a `bool`, and not exactly `0`. The serializer stores missing blink as `0`
    (`survey_loader.py:234`), so `0` is treated as "no data".
  - Latency: numeric and > 0.
  - A signal needs **at least 5 of the 7** items to have usable values. `slower` also needs at
    least 1 previous complete run with a usable latency median.
- **Missing data.** Without enough data the chip is **hidden**. It is never shown as "normal".
- **Data-quality caveat** (shown as "approximate" on every chip):
  - The per-question blink value falls back to the session's rolling average when the question
    window is too short (`ciq/realtime/tools/handlers.py:240-249`). Several items can therefore
    carry the same averaged value.
  - Blink detection itself has known accuracy issues, tracked outside the repo in
    `CIQ MVP/EYE_METRICS_IMPROVEMENTS.md`.

## 6. Components

**Every existing file this feature touches is listed below.** All changes are additions; no
existing behaviour, key, route, prompt or card changes, except the one prompt line in §6.3, which
needs owner sign-off.

### 6.1 Backend
- **`app/backend/ciq/zone.py` (new).** Pure functions with no DB or network:
  - `ZONE_CONFIG`
  - `ZoneConfigError`
  - `validate_config(config)`
  - `compute_zone(config, survey_results) -> dict | None`, which returns the scores without signals
  - `compute_signals(config, latest_results, previous_results_list) -> list`
  - `compute_trend(complete_runs) -> dict`
  - `build_zone_trend(records, config) -> {"latest": zone|null, "trend": trend}`, which filters
    and parses rows, sorts them, scores each run, then adds the trend and the latest run's signals
  - It reuses `effective_score`, `get_score_bounds` and `options_for_question` from `survey_loader`.
    `survey_loader` itself is not modified.
- **`GET /api/zone-trend` (new handler)** in `ciq/api/history_routes.py`:
  - It is a new function appended to the file and registered with one added line next to
    `/api/history` in `ciq/server.py:148`.
  - It uses `request["auth_session"]["user_id"]` only and never takes a user ID from the request.
  - It is authenticated by the existing middleware: `/api/*` is neither public nor admin-only
    (`auth.py:18-27`).
- **`/analyze-report` is NOT modified.**

### 6.2 Session report without touching `/analyze-report`
- `detailed-report.tsx` calls `GET /api/zone-trend` **after** `/analyze-report` resolves. By then
  the run has been saved (`ciq/reports/routes.py:102-115`).
- It shows the scale only if `latest.surveyRunId` equals the report's own `surveyRunId`. If the
  save failed (`routes.py:116-117` swallows the error) or the run was incomplete, the scale simply
  doesn't appear.
- The trend badge is shown in the report too, because it comes free from the same response.

### 6.3 Chat assistant
There are four touch points, all in existing files:
1. Append a `get_my_zone_trend` schema to `GUEST_TOOL_SCHEMAS` (`ciq/chat/tools.py:104-139`).
2. Add a `get_my_zone_trend` branch in `dispatch_tool` next to the other `get_my_*` branches
   (`tools.py:236-262`). It is bound to `auth.user_id`, loads the PILOT config and calls
   `build_zone_trend`.
3. Add `"get_my_zone_trend": _PERSONAL` to `TOOL_ACCESS` (`ciq/chat/rbac.py:27-38`).
   - Note: `_PERSONAL` allows the roles employee, manager and admin on the personal surface
     (`rbac.py:24`). Managers and admins chatting on `/me/chat` would get their **own** zone. No
     other person's data is reachable.
4. **⚠ Needs owner sign-off: one prompt line.** `GUEST_SYSTEM_PROMPT` lists the personal tools
   and sends trend questions to `get_my_score_trend` (`ciq/chat/prompts.py:28-29`), which is empty
   for PILOT users. Without a prompt change the model will rarely call the new tool.
   - Proposed change: add `get_my_zone_trend` to the tool list in that line, and append one sentence:
     *"For 'am I improving' or 'fatigue vs burnout' questions, call get_my_zone_trend; it is a
     wellbeing guide, not a diagnosis."*
   - If the owner declines, the chat part is dropped from v1 and touch points 1–3 are not made either.

### 6.4 Frontend
- **`app/frontend/src/lib/zone.ts` (new).** Pure helpers for zone and lean labels and colours,
  trend badge text, and empty-state text.
- **`components/ui/zone-scale.tsx` (new).** The Fatigue ↔ Burnout line with a marker (or greyed out
  when `lean = none`), the severity zone label, the trend badge, signal chips marked
  "approximate", and the disclaimer "A wellbeing guide, not a diagnosis."
- **`components/ui/zone-trend.tsx` (new).** A recharts `LineChart` of severity over time with zone
  bands shaded. Lower is better.
- **`guest-landing.tsx` (addition).** A **new, separate `<motion.section>`** containing the zone
  card, inserted **above** the existing trend/chat section (`guest-landing.tsx:312-317`). The
  existing section's markup and grid are untouched, so existing cards don't reflow.
- **`detailed-report.tsx` (addition).** One fetch after the analyze call, plus a conditional
  `<ZoneScale>` block (§6.2).
- **`types.ts` (addition).** `ZoneResult` and `ZoneTrend` types.

## 7. Error handling

| Case | Behaviour |
|---|---|
| Not logged in | `401` (existing middleware) |
| No PILOT rows, or none complete | `200 {latest: null, trend: {status: "none"}}`; the UI shows the empty state |
| A row with NULL, empty or `"{}"` `survey_results` | Skipped silently |
| A row with unparseable JSON | Skipped, with a warning logged |
| PILOT config missing or malformed (TEST fallback detected) | `ZoneConfigError` → logged `500`; the UI shows "Zone unavailable right now" |
| Invalid, wrong-scale, `bool`, `None` or missing item score | That run is incomplete |
| Zone fetch fails in `detailed-report` | The report renders normally without the scale |
| Chat tool hits `ZoneConfigError` | Returns `{"error": "zone unavailable"}`; the model says it can't see the zone right now |

## 8. Out of scope / not changed
- **Existing features stay as they are:**
  - the "Hitch Readiness Trend" card and `get_my_score_trend`
  - manager screens and APIs
  - the `/analyze-report` handler
  - `survey_loader.py`

  Hiding the empty legacy card for PILOT users would be a separate change needing owner approval.
- **Past reports in the History tab** (`user-history.tsx`) won't show a zone, because nothing is
  persisted. The home card's chart covers history. Adding it there can come later.
- **Not included:**
  - persisted zones or any schema change
  - EEG and pupil data
  - notifications and alerts
  - the blink-accuracy fixes, tracked separately

## 9. Testing

**Backend, pytest** (`app/backend/tests`, `asyncio_mode=auto`, existing `temp_db` / `initialized_db`
fixtures). `initialized_db` seeds only admin users, so tests create employee users with
`create_user` (`db.py:43`). SQLite foreign keys are off, so `survey_records` rows can be inserted directly.

`tests/unit/test_zone.py`:
- **Groups:** they exactly cover the `pilot-survey.json` question IDs.
- **Config guard:** the TEST config raises `ZoneConfigError`, and so does a config with no
  `scoringSections`.
- **Strain:** the min and max of BAT and CBI; CBI 13 reversed once (raw 100 → strain 0).
- **Validity:** each of these makes a run incomplete:
  - `cbi_q1=3`, `bat_q1=25`, `bat_q1=True`, `bat_q1=None`, `bat_q1="4"`
  - a missing item
- **Severity:** equal group weighting; the worked example in §3 gives exactly 60 / 25 / 43 /
  `mild` / `fatigue` / −35 / 33.
- **Rounding:** half-up at x.5 (12.5 → 13).
- **Zone boundaries:** unrounded severity at 23.75 / 25.0 / 48.75 / 50.0 / 73.75 / 75.0, plus 0 and 100
  (all reachable, as multiples of 1.25).
- **Lean boundaries:** −15 / −12.5 / +12.5 / +15. When the zone is `well`: `lean = none` and
  `marker = null`.
- **Trend:**
  - 0, 1, 2, 4 and 5 complete runs
  - `compared` capped at 3
  - delta exactly ±5 vs ±4.x
  - an incomplete newest row is ignored for "latest"
  - DESC input gets sorted correctly
- **Signals:**
  - `blink_up` at a mean of 20 (hidden) and 20.1 (shown)
  - blink `0` and `bool` treated as missing
  - 4 usable items hides the chip
  - `slower` with no previous run is hidden
  - `slower` at exactly the 25% boundary
  - signals never change severity, zone or trend

`tests/integration/test_zone_trend.py`:
- `/api/zone-trend`:
  - returns `401` when logged out
  - returns only the caller's runs, with two employees seeded
  - ignores non-PILOT, `""`-type, `"{}"` and malformed rows
  - returns a `500` when the PILOT config is monkeypatched to a bad path
- Chat:
  - `GUEST_TOOL_SCHEMAS` contains `get_my_zone_trend`
  - `dispatch_tool("get_my_zone_trend", {}, ChatAuth(role="employee", scope="personal", user_id=…))`
    returns only that caller's data
  - the tool is denied on the `manager` scope
  - (only if §6.3 point 4 is approved) the prompt mentions `get_my_zone_trend`
- **Regression:** the existing `tests/integration/test_analyze_report.py` and
  `get_my_score_trend` tests still pass unchanged.

**Frontend, Vitest** (node environment): `src/lib/zone.test.ts` covers labels and colours for
every zone and lean, badge text for `none` / `first` / `improving` / `steady` / `worsening`, and
the greyed-out state when `marker` is null.

**Manual check** (there is no DOM test harness):
- Seed one employee with 4 PILOT runs.
- Check the home card, the empty state (a new user), the report scale (matching run ID), and the
  report without a scale (an incomplete run).
- Check the chart, the chip visibility, and the home layout at phone and desktop widths, with the
  existing cards unmoved.

## 10. Open risks
- **The scores come from the LLM.** The voice model maps speech to numbers. Membership validation
  catches wrong-scale values, but not a plausible wrong value (for example "3" for "Often").
- **The burnout group is small.** It has 2 items, so one answer moves the lean by 12.5 and severity
  by 6.25 (§4 granularity note).
- **Two bandings can disagree.** The report already shows BAT/CBI Low/Moderate/High. This zone is
  labelled "strain" so it reads as a different, combined measure.

## 11. Pre-existing issue found during review (not fixed here)
`/analyze-report` updates `survey_records` by a client-supplied `survey_run_id` with no ownership
check (`ciq/reports/routes.py:109-114` → `db.py:125-147`). A user holding another user's run UUID
could overwrite that user's answers, and therefore their zone history. UUIDv4 makes this
impractical, but the owner should decide whether to fix it separately.

## 12. Revision log: adversarial review (2026-10-01)
Accepted findings and their changes:
- Validity now uses option membership and rejects `bool`.
- `/analyze-report` is no longer touched; the report fetches `/api/zone-trend` and matches the run ID.
- All four chat touch points are listed, with the prompt line flagged for sign-off.
- A config guard catches the silent TEST fallback.
- Every touched file is listed; the home card goes in its own section so nothing reflows.
- `get_score_bounds` is the single source for the scale.
- Ordering and "latest" are defined explicitly.
- NULL and `"{}"` rows are skipped.
- Rounding is specified and the example is reachable.
- `marker = null` when the zone is `well`.
- A test checks the groups against the survey's question IDs.
- The blink threshold comes from the PDF's fatigue row (+20%); `blink_band` is not reused.
- The scope of the RBAC roles is clarified.
- The History limitation is stated.
- Test setup notes were added; the `""` survey type is handled.
- The marker clamp was removed.
- Line references were corrected.
- The step size is corrected: the review said 3.125, the actual step is 1.25. The conclusion
  (rounding never changes a zone) still holds; the boundary test values are now reachable ones.

Rejected or partly accepted:
- **"`EYE_METRICS_IMPROVEMENTS.md` does not exist":** it exists outside the repo, so it is now
  referenced as an external doc.
- **"Cut the `slower` signal (YAGNI)":** with `/analyze-report` untouched, both signals are computed
  in the single endpoint path with no extra DB plumbing, so it is kept.
- **"Tie-break test adds nothing":** the deterministic sort is kept, but its dedicated test is
  dropped in favour of a DESC-input sort test.
