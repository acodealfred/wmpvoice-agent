# Signal comparison (report card)

The PILOT report card **"Your signals, compared with your past check-ins"**. It lists every question
in survey order with the answer then → now. Where the person's own signals moved notably compared
with their previous PILOT check-ins, it adds one plain sentence per signal. Otherwise it says "No
notable change in your signals…" or "Not enough readings to compare this one." It only describes what was
recorded. It shows no numbers, no colours, no meaning or cause, and never judges the answer.

The full rationale, wording rules and research are in the design spec "CIQ Signal Comparison — Design
Spec" (19 Oct 2026). This page records what was built (Phase 1: the card; Phase 2: the spoken lines)
and where it differs from the spec.

## Where it lives

| Piece | File |
|---|---|
| Rules + every threshold (`SIGNAL_CONFIG`) | `app/backend/ciq/reports/signal_comparison.py` (pure, no I/O) |
| Route `GET /me/reports/{runId}/signal-comparison` | `app/backend/ciq/reports/signal_comparison_routes.py` |
| Feature flag `ENABLE_SIGNAL_COMPARISON` (default on) | `app/backend/ciq/config.py` |
| Fetch + sentence wording | `app/frontend/src/lib/report-signals.ts` |
| Card | `app/frontend/src/components/ui/report-signals-card.tsx`, rendered in `detailed-report.tsx` under "Compared with your last assessment" |
| Spoken lines (voice report section 3, question by question) | `signal_spoken_lines()` in `signal_comparison.py`; `app/backend/ciq/realtime/report_signals.py`; hooked in `middle_tier.py` (`report.cue`); step rules in `ciq/prompts/builder.py` |
| Spoken name of each question | `"spoken"` field per question in `app/backend/surveys/pilot-survey.json` |

Nothing is stored. The route reads `survey_records`, `survey_item_responses` and
`survey_timeline_frames` and computes the result on each request.

## Rules in short

- **Past check-ins** (the person's earlier, scored, non-demo PILOT runs): the median of the newest 3
  decides whether blink rate, response latency or voice pitch *moved*. Sentiment, face and the answer
  compare with the newest earlier run.
- **Today** (this run): blink relative to today's calm baseline, and latency/pitch relative to the
  person's other answers today. These only add a supporting clause ("…, and above your calm reading at
  the start"). Intensity compares only with today's other answers, because mic distance and gain differ
  between sessions.
- **A question is `changed`** (its signals are listed) when (a) at least two signals moved and at
  least one is full-weight (blink, latency, pitch, intensity), or (b) any one signal is *strong*.
  Sentiment and face are weak: they never make a question `changed` on their own.
- **Otherwise the question is `steady`** if at least one signal could be compared (readings today
  and before), or **`no_data`** if none could. A `steady` question lists no signals, so a lone small
  movement is never printed. "No notable change" stays accurate because the movement didn't meet the
  rule. A camera-off answer is `no_data`, never `steady`.
- **The card is hidden** for a non-PILOT run, a first PILOT check-in, or when every question is
  `no_data`.
- **From 4 earlier runs** the person's own spread (scaled MAD over up to 6 runs) can raise a threshold.
  It never lowers one.
- Pupil is never read (`tests/unit/test_pupil_not_used.py`).

## Deviations from the spec

1. **Face emotion: only real readings count.** The session's default face value is `"NEUTRAL"`, and
   frames can also hold `"No face detected"` and similar values. A frame's face label is counted only
   if it is a real Rekognition emotion *and* the frame has a camera (blink) reading. Otherwise a
   camera-off run would read as "calm".
2. **Answers come from `raw_score`**, never `effective_score`. Reverse-scored items would otherwise
   show the wrong option words.
3. **Sentiment comes from the item row**, not from frames. Frames carry the last sentiment forward.
4. **QR PDF:** the stored PDF is captured from a saved-mode copy of the report that makes no API calls.
   The live report therefore fetches the card's data with the zone and comparison data, before the
   capture starts, and passes it into that copy.
5. **Admin export:** the admin "Participant Reports" ZIP serves the stored QR PDF, so this card **is**
   included there. That was a deliberate decision on 20 Oct 2026, and the spec's footer sentence "Only
   you can see this." was dropped as a result. The spec says the admin export stays biometrics-free;
   this needs product sign-off.
6. **Every question is listed** (decision 21 Oct 2026). The spec shows only surfaced questions;
   here every question appears in survey order with a `status`: `changed`, `steady` or `no_data`.
   Phase 2 (spoken lines) speaks every question too; see 7.

7. **The voice explains every question** (decision 21 Oct 2026). The spec caps speech at the two
   most notable questions (`spoken_cap = 2`, §6 and §9) within about 20 seconds. Here every question
   is spoken in survey order, with quiet questions grouped. That is roughly 40–60 seconds, so the
   whole voice report runs about 2–2.5 minutes. `spoken_cap` was removed.

8. **"Your check-in at a glance" overview card** (decision 22 Oct 2026). A separate card, placed
   before the per-question card, gives the overall picture in a simple form:
   - **One headline:** how many answers changed, and on how many questions the person's own
     signals showed a notable change.
   - **A three-column table**, one row per question: the short question name (`"short"` in
     `pilot-survey.json`, sent as `shortLabel`), the answer then → now, and the signals in brief
     ("Blink rate higher · Tone more positive", "No notable change", "Not enough readings").

   Counts are words, never digits. Card only: the voice report does not say it. Built in the
   browser (`overviewHeadline()` / `overviewRows()` in `lib/report-signals.ts`,
   `report-signals-overview-card.tsx`). The plain table has no responsive breakpoints, so the
   screen and the PDF look the same.

## PDF page breaks

The QR PDF is cut into A4 pages between `ciq-print-keep` blocks (`lib/report-pdf.ts`, `pageBreaks`).
Every question block is one such block, so no question is split, and each overview table row is a
`<tr>`, which is never split either. The card's title is kept with the first question and the footer
with the last, so neither is left alone at a page edge. When a break lands within 48 px below the top
of an enclosing card (`LEAD_IN_PX`), it moves up to that card's top edge, so the edge isn't left
alone at the bottom of a page.

**Fonts:** the Google Fonts `<link>` in `index.html` carries `crossorigin="anonymous"`. Without it,
html-to-image cannot read the stylesheet (a `SecurityError` on `cssRules`) and, in the built app,
draws the PDF in a wider fallback font. Tight layouts then overlap: the overall scores, the radar
labels and the data table.

## Spoken lines (Phase 2, restructured 22 Oct 2026)

When the participant presses Start on the report screen, the agent explains the report in four
sections (`report_cue_instructions` in `ciq/prompts/builder.py`):

1. **Since your last check-in:** how each result compares with the previous assessment, then the
   Fatigue ↔ Burnout zone.
2. **This assessment:** "Where Your Capacity Is Going" (blink rate, answer pace and the overall
   voice tone, from `ciq/realtime/spoken_report.py`). The BAT-4 / CBI scores and the
   interpretation text under them are on screen, so they are **not** read out.
3. **Question by question:** the lines described below.
4. **Where your answers point:** the top domain area(s) are **always** named. Each area is scored
   as the mean of its questions' place in their own burnout range (reverse items flipped). The four
   BAT items each have their own area; the three CBI items share "work-related fatigue". The wording
   follows the level: high ("highest on …"), moderate ("leaned most toward …") or low ("came out
   slightly highest …"). It uses plain language and is never a diagnosis. This is followed by
   "The Opportunity" and "What This Unlocks".

**Length.** The whole explanation is ONE realtime response, and Azure caps output per response.
A heavy but realistic report must stay within 450 spoken words, about three minutes. The extreme
case, where every question is notable, must stay within 600 (unit tests in
`test_report_cues.py`). If a report response still ends `incomplete` / `max_output_tokens`, the
middle tier asks the model to carry on from where it stopped, at most twice
(`ciq/realtime/report_continuation.py`; state is on `ConnectionState`). Every `response.done` is
logged with its status, reason and output-token counts.

Question by question:

- **Same data as the card:** it calls `load_signal_comparison()`, so speech and card always agree.
  The `ENABLE_SIGNAL_COMPARISON` flag turns both off. Each question's `answer` also carries
  `recentValues` / `recentLabels`: the previous `answer_history_runs` (2) answers, newest first.
  This field is for speech only; the card ignores it.
- **What is spoken:** every question, in survey order (the card's order), with no limit:
  - **A. Notable signal change** (`changed`): its own sentence. It says what moved, the answer then
    → now, and a gentle reflection that the answer "might not tell the whole story". Three
    reflection phrasings rotate so the passage doesn't repeat itself.
  - **B. In line:** the answer is within one scale step of at least one of the last two answers.
    Neighbouring questions with the same status are grouped ("On A and B, your answers and your
    signals were in line with before, with no notable change."). If every question is like this,
    one sentence covers them all.
  - **C. Answer shift:** the signals are steady, but the answer is `answer_shift_steps` (2) or more
    scale steps away from every one of the last two answers (e.g. always → never). It gets its own
    sentence naming the shift and inviting reflection on whether it reflects a usual week or mostly
    today. Steps are positions on the answer scale, so BAT (1–5) and CBI (0–100) work the same way,
    and reverse-scored items need no special case.
- **Wording:** fixed sentences with no numbers. In this section each question is named by its
  short name, lower-cased ("On morning exhaustion, …"), to keep the passage brief.
  Reflections are observations and invitations only. The agent never says or implies an answer was
  wrong or untruthful, and never asks for an answer to change. A unit test bans words like lie,
  honest, contradict, wrong, should and burnout from these lines.
- **Follow-up questions:** the lines are appended to `spoken_report_text`, so follow-up answers stay
  grounded. The biometric guardrail still governs any "why" question.
- **Nothing to say** (first check-in, nothing changed, feature off, any error): the step is skipped
  silently and signals are not mentioned.

