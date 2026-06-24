# CIQ Test Plan

A comprehensive, staged test plan covering both the **frontend (FE)** and **backend (BE)**.
Stages run **Critical → Optional** so testing can begin at the top and work down.

> Scope: this document is an analysis/plan only — it does not include test implementations.

---

## Testability notes

There are **no automated tests** in the repository today. Each item below is tagged with a
realistic test type:

- **Unit** — pure, deterministic functions; easy to automate now
  (`survey_loader.py`, `biometric_interpreter.py`, FE band helpers).
- **Integration** — aiohttp routes via a test client with mocked Azure / Mithra / DB.
- **E2E / Manual** — anything requiring the realtime WebSocket, microphone, or camera
  (MediaPipe / AWS Rekognition); hard to automate, script as manual checklists.

**Quick win:** `survey_loader`, `biometric_interpreter`, and the FE band helpers are pure and
deterministic — they should be the first automated unit suite.

**Priority legend:** 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low/Optional

---

## STAGE 1 — CRITICAL
*Data correctness, authentication, and the core flow. If any of these break, results are wrong or the app is unusable.*

### BE-C1 — Survey scoring SSOT (`survey_loader.py`) · Unit 🔴
The single source of truth every report depends on — **the highest-value tests in the plan.**

- `effective_score`: reverse items flip correctly (`reverse:true` → `(lo+hi)-raw`); non-reverse
  pass through; `None` → 0; bounds read from config, not hardcoded.
- `compute_survey_summary`: `totalScore`, `maxScore = len*hi`, `domainTotals` aggregation,
  risk thresholds at the **exact boundaries** (`low_max`, `moderate_max` → which bucket),
  interpretation text sourced from config.
- Run across all three surveys (`test`, `bat-full`, `cbt-full`), especially reverse items.
- `get_score_bounds` with missing/empty options → default (1,5).
- `blink_band` / `pupil_band`: boundary values (15/40%, 0.1/0.3 mm), `None` → Unknown, sign handling.

### BE-C2 — Auth & session middleware (`auth.py`) · Integration 🔴

- `login`: valid creds (bcrypt) → cookie set; bad password → 401; missing fields → 400;
  unknown user → 401; malformed JSON → 400.
- `auth_middleware`: no cookie → 401; invalid/expired token → 401; valid → request populated
  with `auth_session` / `session_token`.
- `logout` clears cookie + deletes session; `/me` returns user when authed, else 401.
- **Verify every non-public route is gated** (only login/static should be open).

### BE-C3 — Deterministic report `/analyze-report` · Integration 🔴

- Returns score/risk/domainTotals equal to `compute_survey_summary` (no LLM invoked here).
- Empty snapshots → 400; missing `rtmt` → 503.
- Persists a history row (`ensure_survey_record` + `save_survey_record_results`) and sets
  conversation state `report_delivered`.
- Persistence failure is swallowed but the response still returns (must not 500).

### FE-C1 — Core assessment happy path (`App.tsx`) · E2E/Manual 🔴

- Login → Start Conversation → agent greets → answer questions → progress advances →
  completion mounts the report.
- `surveyCompleted` / `surveyTotal` tracking; duplicate `survey_biometric_update` for the same
  `questionId` is de-duplicated.
- Survey-type switch (TEST/BATFULL/CBTFULL) disabled while recording; locked when
  `surveyTypeOverridden`.

### FE-C2 — Report rendering & band correctness (`detailed-report.tsx`) · Unit + Manual 🔴

- FE `blinkBand` / `pupilBand` thresholds **match BE** `blink_band` / `pupil_band` exactly
  (drift = inconsistent reports).
- Score column shows `user_answer` (1–5), never the internal burnout_contribution.
- `/analyze-report` auto-fires on mount; retry logic (`MAX_ATTEMPTS`) and the auto-save warning
  banner on failure.

---

## STAGE 2 — HIGH
*Realtime flow, report generation, biometrics, baseline. Primary features; degraded or misleading output if broken.*

### BE-H1 — Realtime WS proxy & tool interception (`middle_tier.py`, `tools/handlers.py`) · Integration/Manual 🟠

- `report_sentiment` → emits `sentiment_update`.
- `record_survey_response` → stores score + biometrics, emits `survey_biometric_update`;
  **idempotency**: duplicate `question_id` ignored.
- `query_survey_results` returns SSOT-derived figures (must match `compute_survey_summary`).
- Survey-phase resolution: returning user (valid baseline) → `survey`; new/expired → `warmup`;
  `_resolve_survey_phase` only on first connection; `connection_count` increments; reconnect
  injects context, not a fresh greeting.

### BE-H2 — Session reset / new survey (`session.py`) · Integration 🟠

- `reset_for_new_survey`: clears `survey_results`, history buffers, resets `connection_count`→0,
  phase→`warmup`, `is_returning_user`→False.
- `/clear-conversation` requires `session_id` (400 without); `/survey-phase` only accepts
  `phase:"survey"` (400 otherwise).

### BE-H3 — Behavioral-analysis & consultative LLM reports · Integration (mock Azure) 🟠

- `/report/behavioral-analysis`: builds grounded prompt, parses LLM JSON (`parse_llm_json`),
  `strip_llm_error` path → 503 on empty; persists `analysis` patch.
- `/report/consultative-summary`: works **with and without** the optional `analysis`; persists
  `agentResponse`.
- Mock `AzureChatClient.analyze_with_prompt`: 200, non-200 (API error), malformed JSON,
  timeout → graceful 503/fallback, no 500.

### BE-H4 — KB / RAG report `/ssot-report` (`mithra_client.py`) · Integration (mock Mithra) 🟠

- Query templating from SSOT (risk + top-2 domains); `query_override` path (test generator).
- `call_mithra_kb_chat`: token missing → skip/None → 503; chat-create non-2xx; no `chat.id`;
  no assistant message; sources→citations mapping.
- Stage-2 `call_report_llm`: configured vs not (`llmUsed` flag); falls back to raw KB answer
  when LLM unset/errors.
- Persists snapshot + SSoT result to history.

### BE-H5 — Baseline lifecycle (`baseline_routes.py`, `db.py`) · Integration 🟠

- GET (none → `{baseline:null}`), POST (upsert + validation: non-numeric → 400), DELETE.
- **TTL/expiry** in `get_user_baseline` (returning-user logic hinges on this) — fresh vs expired.
- Per-user isolation (user A cannot read B's baseline).

### BE-H6 — Stress analysis (`biometric_interpreter.py`) · Unit 🟠

- Thresholds: `>35` stressed, `<25` relaxed, between → normal; with vs without baseline;
  confidence/trend fields; singleton behavior.

### FE-H1 — Baseline state machine (`useBiometrics.ts`, `App.tsx`) · Manual 🟠

- States drive the persistent card: `idle/none → REQUIRED → RECORDING (30s) → RECORDED`.
- **Re-record reliability**: Start Baseline after stopping mid-recording (no longer stuck on
  `collecting`); Rerecord deletes server copy + re-records.
- Zero-sample completion (face out of frame) → `NOT SET` + re-recordable, console warn fires.
- Returning user with stored baseline skips the 30s recording; cleared baseline records fresh.
- localStorage persistence vs server `/baseline` agreement.

### FE-H2 — Reconnect / reset audio behavior (`useRealtime.tsx`, `App.tsx`) · Manual 🟠

- Start New Survey: agent silenced **before** the confirm dialog; cancel leaves session intact.
- No stale audio bleed after reset (`suppressAgentAudioRef` lifted on `session.created`).
- Fast reconnect (~250 ms, not 5 s) before first word; backoff on genuine drops.
- Post-report guardrail reset reconnect does not cut off the spoken report.

### FE-H3 — Audio pipeline (`useAudioRecorder`, `useAudioPlayer`, worklets) · Manual 🟠

- Mic capture → PCM append; player worklet buffering; `stop()` flush; barge-in
  (`input_audio_buffer.speech_started` stops playback); analyser feeds the avatar.

### FE-H4 — Biometrics capture math (`useBiometrics.ts`) · Unit (extract pure fns) 🟠

- Blink detection (EAR threshold, 250 ms debounce, 30 s window), pupil mm calc, gaze axis
  amplification / baseline EMA, blink-rate %-change vs baseline. Glasses / no-face edge cases.

---

## STAGE 3 — MEDIUM
*History, admin/KB, config, secondary flows.*

| ID | Area | Test type | Focus |
|----|------|-----------|-------|
| BE-M1 🟡 | History `/api/history` | Integration | Per-user records, ordering, shape matches FE |
| BE-M2 🟡 | Admin KB routes | Integration (mock Mithra) | list/upload/delete/settings(patch)/search/debug; **authorization** (role-gating intent) |
| BE-M3 🟡 | `/config`, `/survey-type` | Integration | Flags reflected; override lock; invalid type rejected |
| BE-M4 🟡 | Biometric guardrail toggle | Integration | `/admin/biometric-guardrail` flips prompt behavior; not a hardened boundary |
| BE-M5 🟡 | Face emotion `/analyze` (Rekognition) | Integration (mock boto3) | base64 decode, dominant emotion, AWS error / missing creds |
| BE-M6 🟡 | KB chat proxy `/kb/chats/*` | Integration | create/get/send passthrough + auth |
| FE-M1 🟡 | User History tab (`user-history.tsx`) | Manual | Loads, renders past runs, SSoT/analysis display |
| FE-M2 🟡 | Admin panel (`admin-panel.tsx`) | Manual | KB upload/delete, settings save, user list, guardrail toggle, paper search |
| FE-M3 🟡 | Test Generator (`test-generator.tsx`) | Manual | `query_override` → `/ssot-report`, LLM-token handling |
| FE-M4 🟡 | 401 handling (`lib/api.ts`) | Unit/Manual | `setAuthExpiredHandler` drops to login on any 401 |

---

## STAGE 4 — LOW / OPTIONAL
*Polish, resilience, non-functional.*

- **FE-O1** ⚪ Theming (light/dark persistence), font-scale (`fontScale.ts`), responsive grid
  (8-of-12), video expand / avatar toggle.
- **FE-O2** ⚪ i18n (`react-i18next`, `fr` locale) — fallbacks, missing keys.
- **FE-O3** ⚪ Charts/visualizations (Recharts report, gaze indicator, cyber-avatar) — render with
  sparse/edge data; lazy-load + ErrorBoundary fallback.
- **FE-O4** ⚪ Accessibility — focus rings, aria labels, keyboard nav, band-pill color contrast.
- **FE-O5** ⚪ Sentiment history panel, grounding-files components (RAG-disabled legacy — confirm
  dead/hidden).
- **BE-O1** ⚪ `/version`, `/session`, logging/observability, `safe_json` serialization edges.
- **NFR-O2** ⚪ Performance: bundle size (685 KB chunk warning), MediaPipe frame budget (33 ms),
  report latency.
- **NFR-O3** ⚪ Resilience: Azure/Mithra/DB outage → graceful UI; concurrent sessions; WS drop
  mid-survey resume.

---

## Cross-cutting (run alongside every stage)

- **Security**: cookie flags (HttpOnly/SameSite/Secure); no secrets in responses
  (`report-llm/debug`, `kb/debug` leak risk); Mithra `ssl=False` (`mithra_session`) is a known gap;
  guardrail/admin endpoints are auth-only, not role-gated — confirm intent.
- **Config matrix**: key-auth vs Managed Identity; Mithra token set/unset; report-LLM set/unset;
  survey-mode / sentiment / guardrail flags on/off.
- **SSOT consistency invariant**: the score a user sees must be identical across `/analyze-report`,
  `/ssot-report`, `query_survey_results`, and the FE table — assert this explicitly in an
  integration test.

---

## Suggested starting order

1. **BE-C1** — scoring unit tests (pure, fast, protects correctness).
2. **BE-C2** — auth integration.
3. **FE-C2 + BE-C1 cross-check** — band threshold parity (FE ↔ BE).
4. **Stage 2**, prioritizing **FE-H1 / FE-H2** (areas under active change).
