# Admin Data Validation Dashboard — Spec

Status: **implemented** — backend `ciq/validation/` (`rules.py`, `routes.py`) +
`db.get_data_validation_runs`; frontend `components/ui/data-validation-panel.tsx`
(top-level "Data Validation" nav item, admin only) + `lib/data-validation.ts`.
Visual reference: [`docs/design/data-validation.dc.html`](design/data-validation.dc.html)
(Design Component source of the approved mockup; read it for layout, spacing,
colours and copy. It needs the design canvas runtime to render, so treat it as
markup reference, not a page to serve.)
Live mockup: https://claude.ai/artifact/EPJXzpYYPhR7cVAJFyYF4a

## 1. Goal

After an employee completes an assessment, admins need a way to confirm the run was
actually persisted (scores, report, export files) without opening the SQLite DB by
hand, and to download that run's files from one place.

New **Data Validation** tab in the Admin panel. Admin role only (`/admin/*`,
enforced by `auth_middleware`).

## 2. Population

Every `survey_records` run that recorded something, **whatever its lifecycle
`status`** — same inclusion rule as `db.get_user_survey_run_summaries` (has
`survey_results`/`prompt_info`, item responses, timeline frames or EEG). Runs that
captured nothing are left out. Newest first (`created_at DESC`). Demo runs
(`is_demo = 1`) are excluded — there is no demo toggle.

## 3. Validation status (per run)

Three values, shown as uppercase badges: **COMPLETED**, **PARTIAL**, **FAILED**.

"Partial" means the same thing as in the existing admin Survey Timeline Export
(`admin-panel.tsx` labels these runs "(partial — <status>)"): the user left the
survey **before the report was produced**, i.e. `survey_records.status` is not
`'completed'` (`closed` = closed mid-survey / started a new one, `paused` = paused and
not yet continued, `active` = still in progress).

| Status | Rule |
|---|---|
| PARTIAL | `survey_records.status != 'completed'`. The badge shows the lifecycle reason underneath, e.g. `PARTIAL · closed`. A partial run is never FAILED: its missing report and scores are expected. |
| FAILED | `status = 'completed'` but data that a completed run must have is missing: `technical_report` is NULL / unparseable, **or** no `survey_timeline_frames` rows, **or** a `PILOT` run is missing its `pilot_bat4_scores` or `pilot_cbi3_scores` row |
| COMPLETED | `status = 'completed'` and all of the above present |

The on-demand AI texts (behavioral analysis, consultative summary) do **not** affect
status — they are generated only when the user opens their report.

Colours: COMPLETED `#35C08A` (vapour), PARTIAL `#F0A63C` (sodium), FAILED `#E4572E`
(flare) — every status also carries a text label, never colour alone.

## 4. Report state

Derived from `survey_records`:

| Report | Rule |
|---|---|
| Saved | `technical_report` present (and parses as JSON) |
| Not generated | Partial run (status ≠ `completed`) with no `technical_report` — expected, grey chip |
| Missing | Completed run with `technical_report` NULL or unparseable — red chip (this is what makes it FAILED) |

The details card adds one informational line for Saved reports: whether the AI summary
was generated (`technical_report.analysis` non-empty and `prompt_info.agentResponse`
present) — "AI summary generated" / "AI summary not generated yet (generated when the
user opens the report)". Informational only.

## 4a. Date column

The "Completed" column/field shows `updated_at` for completed runs and `closed_at`
(else `paused_at`, else `updated_at`) for partial runs. The date-range filter applies
to `created_at`.

## 4b. Scores for partial runs

Scores are computed at report time, so partial runs usually have none: the Scores
section shows "Not scored — the run ended before the report." and the risk deviation
warning is not evaluated.

## 5. Export file availability

"Export files" column = number of per-run files that can be downloaded right now:

| File | Available when | Existing endpoint |
|---|---|---|
| Survey timeline CSV | run has `survey_timeline_frames` rows | `GET /admin/survey-timeline/export?survey_run_id=` |
| EEG raw JSON — whole run | run has EEG (`eeg_sessions` row or any `eeg_session_segments`) | `GET /admin/eeg-sessions/export?survey_run_id=` |
| EEG raw JSON — one segment | per entry of `eeg_segments` (one file per segment) | `GET /admin/eeg-sessions/export?survey_run_id=&segment=N` |
| Combined timeline + EEG CSV | timeline **and** EEG present | `GET /admin/survey-timeline/export-combined?survey_run_id=` |

The EEG presence / segment list logic already exists in
`db.get_user_survey_run_summaries` (`has_eeg_session`, `eeg_segments`); reuse it
rather than re-deriving it.

Display: `Available · N` (green chip with file icon) or `Not available` (dashed grey chip).

## 6. Layout

Matches the existing Admin panel: dark Petroleum theme (`--ciq-*` tokens),
`font-display` (Barlow Semi Condensed) headings, Mulish body, IBM Plex Mono
(`font-data`) for IDs, timestamps and numbers.

1. **Title row** — eyebrow `ASSESSMENT PERSISTENCE`, H1 `Data Validation`, one-line
   description; right side "Last checked <timestamp>".
2. **Filter bar** (one card)
   - Status pills: `ALL`, `COMPLETED`, `PARTIAL`, `FAILED`, each with its count;
     single-select, `aria-pressed`.
   - "Completed within" select: Today / Last 7 days / Last 30 days (default) / All time.
   - No search, survey-type, department, failed-check or demo filters.
3. **Summary tiles** (4): Total runs · Completed (+ % fully saved) · Partial
   ("left before the report") · Failed ("completed, but data missing").
   Counts follow the date filter, not the status filter.
4. **Runs table** (left, flexible width) — columns exactly:
   `Run` (survey_run_id, a button that selects the row) · `User ID` (first 8 chars,
   full id on hover) · `Type` (`survey_type` as
   stored: `PILOT`, `BATFULL`, `CBTFULL`, `READINESS`, `TEST`) · `Completed` (§4a) ·
   `Report` (Saved / Not generated / Missing chip) · `Export files` · `Status`
   (partial rows show the lifecycle reason, e.g. `PARTIAL · closed`).
   The **whole row is clickable** (the run-id button stays as the keyboard target);
   the selected row is highlighted. **10 rows per page** with previous / numbered /
   next controls and an `x–y of N` count; the page resets to 1 when the filter or
   date range changes. Empty state: "No runs match this filter."
   Wide table scrolls horizontally inside its card on narrow screens.
5. **Run details card** (right, ~400px)
   - **Height is aligned with the table card** (flex row `align-items: stretch`);
     its content sits in an inner scroll area (`position:absolute; inset:0;
     overflow-y:auto`) so extra content scrolls inside the card instead of growing it.
     Both cards have `min-height: 560px`; on phone width the card stacks under the
     table and keeps the 560px scrollable height. The scroll area is keyboard-focusable.
   - Contents, in order:
     1. `SURVEY_RUN_ID` + status badge
     2. User ID (full) · Survey type · Completed
     3. Report chip + one-line explanation (+ the AI-summary info line from §4)
     4. **Scores**: two tiles — BAT-4 (`pilot_bat4_scores.risk_level`, avg / 5) and
        CBI-WRB3 (`pilot_cbi3_scores.risk_level`, mean / 100). For non-PILOT runs the
        first tile is labelled with the survey type and shows
        `technical_report.riskLevel` (+ `totalScore`); the CBI tile says
        "Not part of this survey type." Partial runs: see §4b.
     5. **Risk deviation warning** (amber alert, `role="alert"`): PILOT runs only, shown
        when one of BAT-4 / CBI-WRB3 is `Low` and the other is `High`. Text:
        "Risk levels disagree — BAT-4 is {x} but CBI-WRB3 is {y}. Check the item
        responses before using this run." Low↔Moderate or Moderate↔High does not warn.
        (READINESS uses Low/Medium/High but never has both scores, so it never warns.)
     6. **Export this run** dropdown button (disabled with a red note when the run has
        0 files).
   - Not in the card: user name (only the id is shown), department, "Open in Assessments", "Re-validate run".

## 7. "Export this run" dropdown

Menu (`role="menu"`) with, in order:

1. **Survey timeline** — CSV
2. **Muse EEG** group (bordered box, header shows `1 session` / `N segments` / `none`)
   - If the run was paused and continued (more than one segment): note
     "This run was paused and continued, so EEG was recorded in N segments. Each
     segment has its own clock."
   - `All segments (raw)` / `EEG session (raw)` — JSON
   - One indented line per segment: `Segment N` + its recorded time span — JSON
   - `Combined timeline + EEG` — CSV
   - No EEG: "No EEG session was recorded for this run, so the EEG and combined files
     are not available."
3. *(No pilot-survey XLSX here — it stays on the Admin panel's all-runs Pilot Survey Export.)*
4. divider
5. **All files** — ZIP, "N files in one archive", followed by a preview of the archive tree.

Each option shows a small format tag (`CSV`, `JSON`, `ZIP`). Selecting a run
closes the menu.

### ZIP layout

```
ciq_export_<user8>_<survey_run_id>.zip
├─ survey_timeline_<user8>_<run8>.csv
├─ survey_timeline_combined_<user8>_<run8>.csv     (only if EEG; same name as the single download)
└─ eeg/                                            (only if EEG)
   ├─ eeg_segment1_<user8>_<run8>.json             (one per segment)
   ├─ eeg_segment2_<user8>_<run8>.json
   └─ eeg_segment3_<user8>_<run8>.json
```

A single-segment run has `eeg/eeg_session_<user8>_<run8>.json` instead. `<user8>` /
`<run8>` = first 8 chars of the owner's user id / the run id. Every name comes from
`ciq.common.export_names.export_filename`, shared with the single-file downloads (and
the Admin panel's, which now save under the server's filename).

### User id inside every exported file

- **Timeline and combined CSV**: `user_id`, `survey_run_id` are the **first two
  columns of every per-second row** (`_TIMELINE_EXPORT_HEADERS`), so CSVs pooled
  across users stay attributable. Columns after them shifted right by two.
- **EEG JSON**: each Muse file gets a top-level
  `"ciq": {"user_id", "survey_run_id", "segment_index"}` block, added to the
  downloaded copy only (the stored `file_json` is never modified); the
  all-segments bundle also carries a top-level `user_id`.

If the
stored EEG is malformed the combined CSV is left out and a `warnings.txt` explains why,
rather than failing the whole ZIP.

## 8. Backend work needed

| Item | Notes |
|---|---|
| `GET /admin/data-validation/runs?days=30` | Returns per run (all lifecycle statuses, §2): id, lifecycle status, completed-at (§4a), survey_type, created_at, report state, has_timeline, eeg_segments (+ recorded_at span per segment), pilot score presence, BAT-4/CBI-WRB3 risk level + avg/mean, derived status, file count. Single SQL pass with `EXISTS` subqueries / LEFT JOINs (pattern of `get_user_survey_run_summaries`); parameterized. |
| `GET /admin/data-validation/export-zip?survey_run_id=` | Builds the ZIP in memory (`zipfile` + `io.BytesIO`) by reusing the same functions behind the existing export routes — no duplicated CSV/EEG logic. |
| Route registration | In `ciq/server.py`; handlers in a domain module (e.g. `ciq/validation/routes.py`), not in the `app.py` / `rtmt.py` shims. |

No schema change is required.

## 9. Frontend work needed

- New component `src/components/ui/data-validation-panel.tsx`, shown as its own
  **top-level nav item "Data Validation"** (admin only) in `App.tsx`'s `NAV_TABS`, next
  to Admin / Test Generator / Muse EEG — not inside `admin-panel.tsx`.
- Downloads reuse `apiFetch`; `triggerBlobDownload` moves from `admin-panel.tsx` to
  `src/ui/download.ts` (exported as `downloadBlob`) and both screens import it.
- Status filter and date range are client state; date range is sent as `days`.

## 10. Tests

- Unit: status derivation (§3), report state (§4), deviation rule (Low/High only), file count.
- Integration: `/admin/data-validation/runs` returns 403 for manager/employee; ZIP
  contains the expected entries for a multi-segment EEG run and for a no-EEG run.
- Frontend (vitest): status pills filter rows; deviation alert shows only for
  Low↔High; export menu lists one line per EEG segment.
