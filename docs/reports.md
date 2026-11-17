# Assessment reports — on screen, spoken, saved and downloaded

How a participant's report is produced, explained aloud, reopened later and
downloaded. For the "signals vs past check-ins" card see `docs/signal-comparison.md`.
For the two-stage LLM written report (`POST /analyze-report`) see `CLAUDE.md`.

## 1. After the last question

1. `POST /analyze-report` builds the written report and saves it on
   `survey_records`.
2. The frontend shows the **report progress** screen
   (`components/ui/report-progress.tsx`) until the data is ready. On its last
   step it sends the closing cue (`App.tsx` `sendClosingCue`).
3. The report screen (`detailed-report.tsx`) shows scores and charts, plus these
   PILOT-only cards:
   - **Since your last assessment**: the score change vs the previous run of the
     *same* survey type. Uses `GET /me/reports/{runId}/comparison` and
     `ciq/reports/comparison.py`. Survey scores only, never biometrics.
   - **Fatigue ↔ Burnout zone + trend**: uses `GET /api/zone-trend` and
     `ciq/zone.py`. It is calculated on demand and never stored. Biometric
     "fatigue signals" only support the result: they never move the marker,
     the zone or the trend.
   - **Your signals vs past check-ins**: uses
     `GET /me/reports/{runId}/signal-comparison` (`docs/signal-comparison.md`).
4. In the background, the browser captures the on-screen report as a light-theme
   PDF and uploads it **once**: `lib/report-pdf.ts` →
   `POST /me/reports/{runId}/pdf` → the `report_pdfs` table. A later upload for
   the same run is ignored.

## 2. Spoken (verbal) PILOT report

When the participant presses **Start** on the report screen, the browser sends a
custom `report.cue` message over `/realtime`: `report_explain`, or
`report_continue` after a Pause. `RTMiddleTier` does not forward this message to
Azure. Instead, the server computes the report content itself and sends a
`response.create` with fixed instructions (`ciq.prompts.builder.report_cue_instructions`).

Speaking order (each part is skipped when it has nothing to say):

| Part | Built by |
|---|---|
| Since your last assessment | `ciq/realtime/report_comparison.py` → `comparison.comparison_spoken_lines` |
| Fatigue ↔ Burnout zone | `ciq/realtime/report_zone.py` → `zone.zone_spoken_lines` |
| Where your capacity is going · domain areas · the opportunity · what this unlocks | `ciq/realtime/spoken_report.py` (`build_pilot_spoken_report`) |
| Question by question vs past check-ins | `ciq/realtime/report_signals.py` |

Rules:

- **Code chooses every claim.** The framing, the signal wording and which
  reassurance line is allowed are all decided deterministically in code. The LLM
  only voices that text. The spoken report contains no numbers. Pupil size is
  stored but never reported (`tests/unit/test_pupil_not_used.py`).
- **Follow-up questions stay grounded.** The same text is kept as
  `SessionState.spoken_report_text`, so later questions are answered from it.
- **Cut-off recovery.** If Azure ends the explanation at its output-token limit
  (`status=incomplete`, `max_output_tokens`), the middle tier asks the model to
  carry on from exactly where it stopped, a bounded number of times
  (`ciq/realtime/report_continuation.py`). Any other ending clears this state,
  so normal replies are never continued.

## 3. Reopening a saved report

- `GET /me/reports/{runId}`: the user's own completed run. Another user's run
  returns **404, not 403**, so run ids can't be probed.
- `GET /admin/reports/runs/{runId}`: any run, from the Data Validation panel.

Both return the calculated report only. The AI Insights texts are deliberately
not included. Opened from History → `SavedReportDialog` (`ciq/reports/saved_routes.py`).

## 4. QR download to a phone (one download per report)

`ciq/reports/share_routes.py`:

1. `POST /me/reports/{runId}/share {username, tz_offset}` (logged in). The
   participant re-types their username to confirm the report is theirs; the
   username is a confirmation step, not a secret. The server returns a one-time
   token, shown as a QR code (`report-qr-dialog.tsx`). A new token cancels the
   previous one. Returns 409 if the report was already downloaded.
2. `GET /report-share/{token}` (public) shows a page with a Download button.
   Opening this page **doesn't** use up the token, so a phone camera previewing
   the link can't spend it.
3. `POST /report-share/{token}/download` (public) uses up the token, sets
   `survey_records.report_download_count` (atomically), and returns the PDF. It
   serves the stored on-screen PDF if there is one, otherwise a server-rendered
   text PDF (`ciq/reports/pdf.py`, reportlab).

Tokens are **in memory only** and expire after 5 minutes (`SHARE_TTL`), with a
failed-attempt limit. After a restart the user simply generates a new QR code.
This relies on the single-replica deployment.

### Asking for another download

`ciq/reports/download_request_routes.py`, table `report_download_requests`:

- `POST /me/reports/{runId}/download-request` creates a pending request (at most
  one pending per run, enforced by a partial unique index).
- `GET /admin/download-requests` lists pending requests. They appear as a
  notification at the top of the Admin panel, like password resets.
- `POST /admin/download-requests/{id}/approve` resets the download count to 0;
  `/deny` refuses the request.

## 5. Admin bulk export

`GET /admin/reports/export?period=today|7|30|all&tz_offset=<minutes>` returns a ZIP
with one PDF per completed report, named `<user_name>_<survey_run_id>.pdf`
(`ciq/reports/export_routes.py`, Admin → "Participant reports"). Each PDF is the
same file the QR download serves.

The text PDF is the **participant version**. It contains name, date, survey type,
scores, risk levels, interpretations and the AI summary. User id, per-question
answers and biometrics are left out (`ciq/reports/export.py`).

Per-run research exports (timeline, combined, EEG, data-validation ZIP) share one
filename scheme, `<user8>_<run8>`, from `ciq/common/export_names.py`.

## 6. Safety notes

- The only writes are small single-row ones: the download counter, the PDF
  upload and download requests. These are safe with Litestream's single writer.
- AI-summary Markdown is turned into a small, escaped subset before reportlab
  renders it, so raw HTML in it is never interpreted. Characters the built-in
  PDF fonts can't draw are replaced with plain equivalents.

## Tests

`tests/integration/test_report_share.py`, `test_report_pdf_store.py`,
`test_download_requests.py`, `test_report_export_routes.py`,
`test_saved_report_routes.py`, `test_report_comparison_route.py`,
`test_report_zone.py`, `test_zone_trend.py`; `tests/unit/test_spoken_report.py`,
`test_report_cues.py`, `test_report_continuation.py`, `test_report_export.py`,
`test_report_comparison*.py`.
