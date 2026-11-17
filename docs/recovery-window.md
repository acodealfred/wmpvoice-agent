# Recovery Window

A short, optional, voice-guided check-in a participant can open **after** their
assessment report. The agent asks a 9-question intake, the server picks one of
four pre-written **guided recovery tracks**, and the agent walks the participant
through it, step by step. It finishes with a short reflection.

It is a wellbeing support session, **not a treatment**. Every message and
rationale string follows the copy-audit table in `ciq/recovery/guardrails.py`
(for example, "Your score suggests elevated work-related burnout risk", never
"You have burnout").

| Piece | Where |
|---|---|
| Package | `app/backend/ciq/recovery/` |
| Voice tools | `ciq/realtime/tools/recovery_schemas.py`, `recovery_handlers.py` |
| Agent script | `ciq.prompts.builder.recovery_window_instructions` |
| UI | `app/frontend/src/components/ui/recovery-window-screen.tsx`, `recovery-window-card.tsx` |
| Feature flag | `ENABLE_RECOVERY_WINDOW_VOICE` (**on** by default; `false` disables the voice flow) |

## Flow

1. **Start.** `POST /api/recovery-window/start` opens a session linked to the
   participant's survey run.
2. **Preliminary track.** Before asking anything, the server suggests a track
   from the survey score and the blink-rate band alone
   (`router.get_preliminary_recovery_recommendation`). The agent always calls it
   *preliminary*.
3. **Intake (9 questions).** These are asked by voice and recorded with
   `record_recovery_intake_answer` / `record_recovery_safety_answer`. The single
   source of truth is `ciq/recovery/intake_questions.py`:

   | id | Asks about |
   |---|---|
   | `sleep_hours` | Hours slept in the last 24 h (0–14) |
   | `sleep_quality` | Sleep quality (1–5) |
   | `mental_drain` | Mental drain right now (1–5) |
   | `emotional_heaviness` | Emotional heaviness today (1–5) |
   | `physical_tension` | Physical tension (1–5) |
   | `high_stakes_task` | Whether a high-stakes task is coming up, and when |
   | `current_need` | What would help most right now |
   | `duration` | 3, 7 or 12 minutes |
   | `safety` | `no` / `yes` / `prefer_not_to_say` |

4. **Safety interlock.** This runs before any recommendation
   (`guardrails.check_safety_interlock`), and the router checks it again as a
   second line of defence:
   - `yes` → **urgent support**: no track, the flow stops, and a static crisis /
     EAP message is shown. The session is flagged for admin review.
   - `prefer_not_to_say` → **grounding only**: simple grounding content only,
     with support resources shown. The session is flagged.
   - `no` → continue.
5. **Final recommendation** (`router.get_recovery_recommendation`). This is
   deterministic code with no LLM involved. `current_need` decides first. If it
   is `unknown`, score-based rules decide:

   | Situation | Track |
   |---|---|
   | Thoughts overloaded, or heavy drain + poor sleep | `cbt_reframe_reset` |
   | Body tense, or high tension + elevated blink band | `mindfulness_downshift` |
   | Emotionally drained / disconnected, or steady heaviness + drain | `act_values_recalibration` |
   | Wants a plan, high burnout with calm signals, or mixed signals | `practical_recovery_plan` (the safe default) |

   If a high-stakes task is due **within 1 hour** and the participant's signals
   are critically low, the rationale also suggests the organisation's safety
   process as an option. It never says the person is "unfit".
6. **Track.** The participant picks the recommended track or an alternative
   (`select_recovery_track`). The agent then reads the static steps
   (`track_scripts.py`), and each step is logged with `advance_recovery_track_step`.
7. **Reflection.** The participant answers whether they feel more settled, how
   helpful it was, their next step, and whether they want follow-up
   (`record_recovery_reflection`). The session is then marked `completed`.

All recommendation and persistence logic lives in `ciq/recovery/service.py`.
Both the voice tools and the REST routes call it, so the two paths can never
give different results. The REST routes are a fallback for a non-voice UI.

Session `status` values: `not_started`, `intake_in_progress`,
`track_recommended`, `session_in_progress`, `completed`, `urgent_support`.

## Privacy model

Recovery Window data is **individual-only**. It follows the same principle as the
personal Wellbeing Assistant (`docs/manager-chat.md`):

- Raw intake answers, transcripts and reflections are **never** shown to a
  manager or employer dashboard, not even in aggregate. No `/manager/*` route
  reads these tables.
- Every non-admin route checks that the session belongs to the logged-in user
  (`request["auth_session"]["user_id"]`). The user id is never taken from the
  request body.
- Admins see only **safety-flagged** sessions, so that someone can follow up:
  `GET /admin/recovery-window/flagged` and
  `POST /admin/recovery-window/flagged/{id}/ack`. These are gated by the
  existing `/admin/*` rule in `auth_middleware`.
- `aggregate_eligible` is set to 1 when a session completes, but nothing reads
  it yet. It is reserved for any future aggregate view, and that view would
  need its own privacy review.

## Storage

These tables are created in `db_init.py` (columns are listed in
`.claude/context/database.md`):

- `recovery_window_sessions`: one row per session (tracks, safety flag, reflection).
- `recovery_window_intake_responses`: one row per intake answer.
- `recovery_window_track_progress`: one row per track step.

## Before production

The crisis and grounding messages (`STATIC_CRISIS_MESSAGE`,
`STATIC_GROUNDING_MESSAGE` in `guardrails.py`) are **generic placeholders**.
Before a real rollout, replace them with the organisation's actual EAP and
crisis-line details.

## Tests

There are **no dedicated automated tests** for this package yet. The router,
guardrails and service are pure or near-pure, so they are easy to unit-test.
Good first cases:

- each safety answer → the correct interlock outcome;
- each `current_need` → the correct track;
- the "within 1 hour" safety-process note.
