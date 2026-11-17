# Assessment lifecycle — Start, Pause, Continue, Close

From ciq-alpha-v3 on, an assessment is a **run** (one `survey_records` row). A
participant can pause a run and continue it later. Each run records its own
baseline and its own per-second timeline.

| Piece | Where |
|---|---|
| State machine | `app/backend/ciq/assessments/service.py` |
| Routes | `app/backend/ciq/assessments/routes.py` |
| Baseline protocol (browser) | `app/frontend/src/session/baseline-protocol.ts`, `hooks/useBaselineProtocol.ts` |
| Per-second timeline | `app/backend/ciq/realtime/timeline_capture.py` |
| User's own words per answer | `app/backend/ciq/realtime/transcripts.py` |

## States (`survey_records.status`)

```
active --pause--> paused --continue--> active --report saved--> completed
active | paused --close / start new--> closed
```

- A user has **at most one open run** (`active` or `paused`).
  `db.create_active_survey_run` enforces this inside one transaction.
- A run left `active` with no live connection (tab closed, network drop) can be
  resumed exactly like a paused one. Its answers and timeline were already saved.
- Each Start/Continue is a new **segment** (`current_segment`). Timeline frames
  and Muse EEG recordings are stored per segment (`eeg_session_segments`) and
  combined at export time, never joined into one file. A resumed run usually
  means a headband reconnect, which starts a new clock.

## Routes (own data only)

The user and the live session always come from `request["auth_session"]`, never
from the request body. Nobody can pause, continue or reset another user's run.

| Route | Does |
|---|---|
| `GET /me/assessment` | The user's resumable run, or `null` |
| `POST /me/assessment/start {surveyType?}` | Closes any open run, resets the live session, starts a fresh run |
| `POST /me/assessment/pause` | `active` → `paused`: stops sampling, saves the segment's frames |
| `POST /me/assessment/continue {surveyRunId}` | Resumes where the user left off; the live session is rebuilt from saved answers |
| `POST /me/assessment/close {surveyRunId}` | Discards a paused run (→ `closed`) |
| `POST /me/assessment/baseline {blinkRate, pupilSize}` | Records the run's completed baseline (once per run) |

The `start` and `continue` responses include `baselineRequired`. The
`continue` response also includes `baseline` when one already exists.

## Baseline (per run)

Before the questions start, the browser runs a two-phase resting baseline:

1. **Eyes open**: camera biometrics + EEG.
2. **Eyes closed**: EEG only, because blinks can't be measured with eyes shut.

The agent says one short cue at the start of each phase. The timer starts only
after the cue has finished playing, so the recording never overlaps the agent's
voice. Results are saved on the run itself (`survey_records.baseline_*`):

- every new run records its own baseline;
- a run paused **before** its baseline finished records it again on Continue;
- a run that **finished** its baseline reuses it on every Continue, with no time limit.

The old per-user `user_baselines` table (12 h TTL) and the `/baseline` routes are
gone; the table is kept only for old data. Blink-rate change is measured against
the run's own baseline. Pupil size is captured but not used anywhere.

## Per-second timeline

A 1 Hz background task starts when the assessment connects, so the baseline is
included, and runs until the survey ends. Each frame records:

- the turn state (`agent_question`, `agent_other`, `user_answer`, `idle`);
- the `stage` (`baseline_setup`, `baseline_eyes_open`, `baseline_eyes_closed`, `survey`);
- the live biometrics and, when enabled, voice pitch and loudness (`docs/voice-features.md`).

Frames are buffered in memory and written on pause, disconnect or report. They
are not written every second.

Azure only reveals what the agent said when its turn ends. At that point the
turn's frames are labelled by fuzzy-matching the transcript against the next
question's exact wording. A match means the turn was the agent asking that
question (`agent_question`); anything else, such as greetings or transitions,
becomes `agent_other`.

## The user's own words

`record_survey_response`'s `user_verbal_response` is the **model's**
paraphrase. The user's actual words come from Whisper input transcription, tied
to the question by conversation item id, never by arrival order. Whisper usually
finishes *after* the tool call, so the answer is first saved with the model's
text and then patched when the transcript arrives. Scored answers are the
exception: they always store the option label for their score.

## Consent

The consent form is shown every time a user enters the assessment page. Each
acceptance is a row in `consent_events` (with `consent_version`). For PILOT
runs, the acceptance is linked to the run it covered when the user starts or
continues.

## Tests

`tests/unit/test_assessment_state.py`, `test_baseline_protocol.py`,
`test_timeline_segments.py`, `test_transcripts.py`, `test_eeg_segments.py`;
`tests/integration/test_assessment_routes.py`; frontend
`session/baseline-protocol.test.ts`.
