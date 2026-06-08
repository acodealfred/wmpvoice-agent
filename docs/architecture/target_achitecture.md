# CIQ — Architecture Assessment

## 1. Application Overview

### 1.1 System Overview
CIQ is a voice-first burnout assessment application. A user authenticates, then converses
by voice with an AI agent (Azure OpenAI GPT-4o Realtime) that administers the a user selected survey possible values are inbuilt surveys are BAT Survey, Custom Challange Skill Matrix Survey, Anyother custom surveys. These all surveys are uploaded by user to the application. The application provide option to the authorized users or adminstrators to change the survey upload more survey types without changing the code. Then authenticated user selects the required survey. While the survey conversation runs, the browser captures
facial biometrics (blink rate, gaze, pupil size via MediaPipe). After the survey, a report pipeline produces a survey technical results table where it shows all the biometric changes and voice sentiment changes, voice response latency for each questions then upon user request it produces two seperate detailed analysis report based on the survey the user took and the results of the survey. One is the Core Survey Report, solely based on the survey score total , and question wiese or question domain/type wise scores, the second is optional report considering the survey score , question responses and also the behavioral biometrics, both of these reports are genrated with the mandatory grounded truth from extrnal single source of truth API by Mithra AI. Users are able to question query and ask further analysis of technical results, Core survey report, Behavioral report using the VOICE AI Agent. These contexts is presented to the back-end LLM throughout the user interaction session till logout and mandatory timeout of 30 minsutes. The same results, reports are stored in databse for future queries, where user can retrive the results and reports of past and question the AI agent on this, all of the answers are backed by the providd result/report context and the augmentation knoledge from SSOT. The aim of the second report behavioral report is to measure Cognitive load. Cache mechanisms are used to manage the context memeory.

It originated from the Azure VoiceRAG sample; Azure AI Search RAG is preserved but
disabled (`ragtools.py`).

```
Browser (React)                  Backend (aiohttp/Python)              External services
─────────────────               ─────────────────────────              ──────────────────
mic → useAudioRecorder ─┐
camera → MediaPipe      │
       → useBiometrics  │   WS  ┌────────────────────────┐   WS    Azure OpenAI
       → useVideoCapture┼──────►│   RTMiddleTier proxy   │────────► Realtime API
                        │ /realtime  (rtmt.py)           │         (gpt-4o-realtime)
useRealtime (WS client) ┘       └─────────┬──────────────┘
                                           │ REST                Azure OpenAI
App.tsx ── REST ──────────────────────────┤  /analyze-report ───► (chat completions,
  /login /me /config                      │  /ssot-report         analyze_with_prompt)
  /biometrics /analyze-stress             │  /analyze-stress
  /analyze /ssot-report                   │  /analyze (Rekognition)
  /analyze-report /api/history            │  /admin/kb/* /kb/chats/* ──► Mithra KB API
  /admin/* /survey-type                   │
                                           ▼
                                    SQLite (db.py) — users, sessions,
                                    survey results, reports
```

### 1.1 Use cases
Application provide capability to upload/write surveys to the applciation and enables the users to select form list of survey and right now the default available options are BAT Burinout Survey and Challange Skill Matrix survey. This application is capabale of measuring Burnout from BAT survey, and coginitve load from behavioral biometrics. This application is currently targeted for healthcare organizations for healthcare employees,  in Healthcare sector for healthcare professionl This survey and application is used in Healthcare sector for healthcare employees to measure Burnout, challange skil matrix and and in Engineering firms to check Burnout in ground level technicicans.

## 2. Backend Architecture (`app/backend/`)

### 2.1 `app.py` — aiohttp server and REST surface

`create_app()` wires together: env loading, Azure credentials (API key or
`DefaultAzureCredential`/`AzureDeveloperCliCredential`), SQLite init, `RTMiddleTier`
construction, feature-flag enablement, auth middleware, and route registration. It
serves the built frontend from `static/` and exposes:

- **Auth**: `POST /login`, `POST /logout`, `GET /me` (session-token cookie backed by
  SQLite `user_sessions`)
- **Realtime**: `WS /realtime` (delegated to `RTMiddleTier.attach_to_app`)
- **Survey/report pipeline**:
  - `POST /analyze-report` — two-stage LLM pipeline (behavioral analysis → consultative
    response), persists results, sets conversation state for follow-up Q&A
  - `POST /ssot-report` — builds a query from survey snapshots, queries the Mithra
    knowledge base, optionally runs a dedicated "report LLM" to format the answer,
    persists the result, and switches the agent into report-delivered/Q&A mode
- **Biometrics**: `POST /analyze` (AWS Rekognition emotion), `POST /analyze-stress`
  (delegates to `BiometricInterpreter`), `POST /biometrics` (pushes current readings
  into `RTMiddleTier` session state)
- **Session/state**: `GET /session` (reconnect snapshot), `POST /update-stress`,
  `POST /clear-conversation`
- **Config**: `GET /config`, `POST /survey-type`
- **Knowledge base admin**: `POST/GET/DELETE /admin/kb/*`, `GET/PATCH /admin/kb/settings`,
  `POST /admin/kb/papers/search`, `POST/GET /kb/chats*`
- **History/admin**: `GET /api/history`, `GET /admin/users`, `GET /version`,
  `GET /admin/report-llm/debug`, `GET /admin/kb/debug`

An auth middleware (`auth.py`) gates every route except `/login`, `/logout`, `/config`
and `/`, validating the session-token cookie against SQLite and injecting
`auth_session`/`session_token` into the request.


### 2.2 `rtmt.py` — RTMiddleTier (the core)

A bidirectional WebSocket proxy between the browser and Azure OpenAI's Realtime API.
For each connection it:

1. Resolves a `session_id` (from the query string) to a per-user `SessionState`
   (survey results, biometric history/snapshots, stress state, conversation state,
   report context, connection count, timestamps). Sessions live in an in-memory dict
   with a 4-hour TTL and are exposed to coroutines via an `asyncio.ContextVar`, so tool
   handlers can reach session state without explicit parameter threading.
2. **Client → server**: rewrites `session.update` to inject dynamically composed
   instructions — base system message, meta-intent/app-context block, sentiment
   instructions, survey script, conversation-state instructions, *reconnect*
   instructions (so a resumed connection doesn't restart the survey or re-introduce
   itself), and stress-adaptive instructions — plus the registered tool schemas.
3. **Server → client**: strips internal config (`instructions`, `tools`, `max_tokens`)
   from `session.created`, intercepts `function_call`/`function_call_arguments_done`
   events to dispatch to tool handlers, detects report-delivery via keyword scanning to
   flip conversation state, tracks Q&A-mode transitions, measures voice response
   latency, and extracts `<SENTIMENT>` tags from model output before TTS.

**Custom tools** (each routed `TO_SERVER`, `TO_CLIENT`, or both):

| Tool | Routing | Purpose |
|---|---|---|
| `report_sentiment` | TO_CLIENT | Broadcasts `sentiment_update` for the current utterance |
| `record_survey_response` | TO_CLIENT (+ TO_SERVER ack) | Idempotently records score + aggregated biometric snapshot (avg blink-rate change, dominant emotion, gaze, response latency); broadcasts `survey_biometric_update` |
| `query_survey_results` | TO_SERVER | Lets the agent answer post-survey questions about scores/domains/risk from `_survey_results` |

`analyze_with_prompt()` provides a separate (non-realtime) chat-completions call used by
the two-stage report pipeline. `attach_to_app()` registers the WS handler at
`/realtime`.

The applciation is capable of querying data from past session results and send to LLM incase the user queries a summary f=of the results rather than the full report context at all prompts, with the help of query_toools.

### 2.3 `biometric_interpreter.py`

A small singleton (`BiometricInterpreter`) that converts a blink-rate reading (with an
optional personal baseline) into a `StressResult` (state: stressed/relaxed/normal,
confidence, trend). Backs `POST /analyze-stress`. Option too measure blink rate stress is not required in this application.  

### 2.4 `db.py` / `db_init.py`

SQLite (WAL mode) with `users` and `user_sessions` tables. `user_sessions` stores
`session_id`, JSON blobs for `survey_results`, `technical_report`, and `prompt_info`
(including the SSoT report outcome), and timestamps. Functions support login/logout,
activity touch, persisting survey/report results, merging SSoT results, and querying
history for the History/Admin tabs.The survey_results table holds survey results sumarry such as burnout score and burnout level in additon tot he question level score and behaviroal biometric changes.

### 2.5 `ragtools.py` (disabled)

Azure AI Search hybrid-search and grounding tool schemas/handlers, fully preserved but
commented out in `app.py`. Re-enabling requires installing the search SDK, uncommenting
the wiring, and setting `AZURE_SEARCH_*` env vars.

## 3. Frontend Architecture (`app/frontend/src/`)

### 3.1 `App.tsx`

The root component owns essentially all cross-cutting state: auth (`authState`,
`currentUser`, `sessionId`), active tab (Assessment/Admin/Test/History), feature flags
from `/config`, survey progress and biometric snapshots, sentiment, and stress results.
It wires together the realtime hook, the biometrics/video-capture hooks, and the report
modal, and is the single place that calls the `/biometrics`, `/login`, `/logout`,
`/config`, and `/survey-type` REST endpoints. 

### 3.2 Hooks

- **`useRealtime.tsx`** — thin WebSocket client over `/realtime?session_id=...`;
  dispatches typed callbacks for audio deltas, sentiment/survey/biometric updates, and
  manages reconnection (deferring `session.update` until `session.created` arrives so
  the backend can inject reconnect context).
- **`useBiometrics.ts`** — runs MediaPipe `FaceLandmarker` at ~30 FPS to derive blink
  rate (EAR-threshold + rolling-window + EMA smoothing), gaze position (iris landmarks,
  amplified/clamped), pupil size, head pose, mouth/smile blend shapes; manages a 30-second
  baseline-capture session persisted to `localStorage` for percent-change calculations.
- **`useVideoCapture.ts`** — manages the camera stream and periodically posts JPEG
  frames to `/analyze` for AWS Rekognition emotion detection (degrades silently if AWS
  isn't configured).
- **`useAudioRecorder.tsx`** — captures mic audio and emits base64-encoded chunks for
  the realtime input buffer.

### 3.3 Key UI

`detailed-report.tsx` shows the technical score/risk breakdown and the per-question
biometric snapshot table, and triggers `/ssot-report` generation. Supporting components
include `LoginScreen`, `VideoPanel`, `GazeIndicator`, `AdminPanel` (KB management),
`TestGenerator`, and `UserHistory`.

## 4. End-to-End Flows

### 4.1 Survey administration

Browser captures biometrics continuously → periodically `POST /biometrics` updates
`RTMiddleTier` session history. The agent asks survey questions per the injected survey
script; after the user answers, it calls `record_survey_response`, which aggregates the
latest biometric history into a snapshot, stores it in `SessionState.survey_results`,
and pushes a `survey_biometric_update` to the browser, driving the progress UI. On
completion the report modal is shown. These all biometric changes values are captured and logged to in applciation logs for analysis selected biometrics will be used in applciation observalbility dahboards and these logs should be preserved for future analysis. All AI interactions are logged with correlationIDs, userid , sessionids so AI interactiosn are traceable and can be used in AI observability also. 

### 4.2 Report generation

`DetailedReport` posts snapshots to `/ssot-report`, which computes score/risk, persists
the snapshot, builds a query for the Mithra knowledge base, optionally reformats the
answer with a dedicated report LLM, persists the SSoT outcome, and flips the
`RTMiddleTier` session into `report_delivered` state with the report text stored as
context. `/analyze-report` performs the alternative two-stage (behavioral analysis →
consultative response) pipeline using `analyze_with_prompt`.

### 4.3 Conversation state machine and reconnects

`SessionState.conversation_state` moves `active → report_delivered → qa_mode`,
detected via keyword scanning of agent output and subsequent user turns. On any
WebSocket reconnect with the same `session_id`, `connection_count` increments and
`_get_reconnect_instructions()` injects a summary of answered/remaining questions and
current conversation state so the agent resumes naturally instead of restarting.

## 5. Architectural Patterns Worth Noting

- **Message-interception proxy**: all custom behavior (tool execution, instruction
  injection, state-machine transitions) is layered onto the Azure Realtime protocol by
  rewriting messages in transit, with no changes to the underlying API.
- **Context-variable session scoping**: `asyncio.ContextVar` lets tool handlers access
  the active session implicitly across the two relay tasks (client→server,
  server→client) of a single connection.
- **Tool-result routing** (`TO_SERVER` / `TO_CLIENT`): cleanly separates "the agent
  needs this to keep talking" from "the UI needs this to update," and some tools do
  both.
- **Graceful degradation**: Mithra KB, AWS Rekognition, the report LLM, and Azure AI
  Search are all optional; their absence produces explicit fallbacks/errors rather than
  crashes.
- **In-memory session state with TTL + SQLite persistence**: live conversational state
  (biometric buffers, survey-in-progress) lives in `RTMiddleTier._sessions` with
  eviction after 4 hours of inactivity, while durable results (final scores, reports)
  are written to SQLite for history/admin views.
- **Redis Cache Usage for context memeory**: To support the growing context and memory management, Redis Azure Cache is used. This reduces the memoery slip issues.`RTMiddleTier._sessions` is now uses Redis cache memory — horizontal scaling of the backend
  will be supported by this.

## 6. Notable Risks / Observations

- Report-delivery detection relies on keyword scanning of LLM output, which is
  inherently brittle if the model phrases summaries differently.
- SQLite with WAL mode is adequate for the current single-instance deployment but would
  need replacing for multi-instance/high-concurrency production use.
- `ragtools.py` represents meaningful dead code; if RAG remains permanently disabled it
  could be removed, or documented as an extension point more prominently.


