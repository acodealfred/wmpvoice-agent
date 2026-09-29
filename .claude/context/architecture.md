# CIQ Architecture Reference

> **Quick Context for Agents**: CIQ is a voice-enabled burnout assessment platform. Users interact with an AI voice agent administering the Burnout Assessment Tool (BAT/CBI) while client-side and cloud biometrics run concurrently. A two-stage LLM pipeline generates behavioral and consultative reports. Managers access aggregated dashboards and grounded chat.

---

## 1. System Topology & Monorepo Structure

```
wmpvoice-agent/
├── app/
│   ├── backend/             # Python 3.11+ aiohttp server + ciq package
│   │   ├── app.py           # Thin entrypoint shim → ciq.server.create_app
│   │   ├── rtmt.py          # Thin entrypoint shim → ciq.realtime.middle_tier.RTMiddleTier
│   │   ├── auth.py          # Session auth, cookies, bcrypt, role gates
│   │   ├── db.py            # SQLite async query functions (aiosqlite)
│   │   ├── db_init.py       # Table schema DDL, idempotent migrations, seed data
│   │   ├── survey_loader.py # Survey definitions, scoring SSOT, reverse scoring
│   │   ├── biometric_interpreter.py # Blink-rate stress state engine
│   │   ├── ragtools.py      # Azure AI Search tools (currently disabled)
│   │   ├── data/ciq.db      # SQLite database in WAL mode (Litestream replicated)
│   │   ├── surveys/         # Survey definition JSONs (bat-full, cbt-full, pilot, test)
│   │   ├── tests/           # Pytest test suite (unit/ and integration/)
│   │   ├── static/          # Built frontend assets served by backend at /
│   │   └── ciq/             # Decomposed domain modules (see section 2)
│   └── frontend/            # React 18 + TypeScript + Vite + TailwindCSS
│       ├── src/
│       │   ├── App.tsx      # Main application state & surface coordinator (112KB)
│       │   ├── components/  # Admin, Manager, Guest, Report, Recovery, EEG components
│       │   ├── hooks/       # useRealtime, useBiometrics, useVideoCapture, useMuse, useChatStream
│       │   ├── lib/         # Utility functions, bands calculation
│       │   ├── muse/        # Muse BLE protocol, simulated headset, decoders
│       │   └── session/     # Assessment recording, telemetry, pulse tests
│       └── vite.config.ts   # Dev proxy (/realtime -> ws://localhost:8765)
├── infra/                   # Azure Bicep IaC (Container App, OpenAI, Blob Storage)
├── scripts/                 # Dev startup, python env loader, env writer scripts
└── docs/                    # Architectural specs (refactoring, persistence, manager-chat)
```

---

## 2. Backend Package Architecture (`app/backend/ciq/`)

The backend was refactored from legacy god-files into cohesive domain modules:

| Subpackage / Module | Location | Core Responsibilities |
|---|---|---|
| **Server Composition** | `ciq/server.py` | `create_app()`: composition root, middlewares, 43 registered routes, static serving |
| **Bootstrap** | `ciq/bootstrap.py` | Builds `RTMiddleTier`, wires environment config, sets active persona and tools |
| **Config** | `ciq/config.py` | `APP_VERSION`, survey type constants, environment flag helpers |
| **Realtime Proxy** | `ciq/realtime/` | `middle_tier.py` (WS relay between client and Azure OpenAI), `session.py` (SessionState/SessionStore), `timeline_capture.py` (per-second frame recorder), `spoken_report.py` |
| **Realtime Tools** | `ciq/realtime/tools/` | Tool schemas & handlers (`record_survey_response`, `report_sentiment`, `query_survey_results`, `recovery_*`) |
| **Reports Engine** | `ciq/reports/` | Two-stage LLM pipeline prompts (`prompts.py`) & endpoints (`routes.py`: `/analyze-report`, `/report/*`, `/ssot-report`) |
| **Wellbeing Chat** | `ciq/chat/` | Manager & Personal LLM chat: RBAC (`rbac.py`), tools (`tools.py`), prompts (`prompts.py`), guardrails (`guardrails.py`), orchestrator (`orchestrator.py`) |
| **Recovery Window** | `ciq/recovery/` | 9-question intake state machine, 5 recovery tracks, clinical guardrails, session progress routes |
| **EEG Sessions** | `ciq/eeg/` | Muse 2 raw headset recording upload, timeline sync (`combine.py`), admin export |
| **Knowledge Base** | `ciq/kb/` | Mithra client HTTP proxy, research paper search, admin KB configuration |
| **Biometrics** | `ciq/biometrics/` | AWS Rekognition facial emotion analysis (`rekognition.py`, `routes.py`) |
| **API Endpoints** | `ciq/api/` | Baseline calibration, consent, session history, admin data exports, manager analytics |
| **Common** | `ciq/common/` | Resilient JSON parsing (`json_utils.py`) |

> **Critical Rule**: `app/backend/app.py` and `app/backend/rtmt.py` are **thin shims**. Never put business logic in them.

---

## 3. Realtime Voice & WebSocket Pipeline

```
Browser Microphone
       │ (16kHz PCM audio chunks via useAudioRecorder)
       ▼
Frontend WebSocket (useRealtime.tsx)
       │ (/realtime)
       ▼
Backend aiohttp Server (ciq/server.py)
       │
       ▼
RTMiddleTier (ciq/realtime/middle_tier.py)
       │ (WebSocket client)
       ▼
Azure OpenAI Realtime API (gpt-4o-realtime-preview)
```

### Tool Interception Protocol
`RTMiddleTier` intercepts model function calls and executes backend tools before replying to Azure OpenAI:
1. `record_survey_response`: Triggered when agent scores a question. Captures effective score, response latency, current blink rate, and face emotion. Persists snapshot and emits `survey_biometric_update` event to browser.
2. `report_sentiment`: Triggered on user speech turns. Emits `sentiment_update` (positive/neutral/negative) to frontend.
3. `query_survey_results`: Allows model to speak user results accurately post-survey.
4. `recovery_*`: Handles Recovery Window intake questions and track progress transitions.

---

## 4. Dual Biometrics & EEG Pipeline

1. **Client-side Eye Tracking (MediaPipe)**:
   - `useBiometrics.ts` runs MediaPipe `FaceLandmarker` in requestAnimationFrame.
   - Calculates blinks per minute (BPM) and pupil dilation delta vs user baseline.
   - Posts to `/analyze-stress` → `biometric_interpreter.py` evaluates relaxed/normal/stressed states.
   - Updates RTMiddleTier state via `POST /biometrics` and `POST /update-stress`.
2. **Cloud Facial Emotion (AWS Rekognition)**:
   - `useVideoCapture.ts` captures periodic JPEG snapshots.
   - Sends to `POST /analyze` → `ciq/biometrics/rekognition.py` queries AWS Rekognition `detect_faces`.
   - Returns dominant emotion (happy, calm, stressed, etc.) and attaches to active survey snapshot.
3. **Muse 2 EEG Integration**:
   - `useMuse.ts` connects via Web Bluetooth in Chrome/Edge.
   - Streams raw EEG telemetry and per-question timestamp markers.
   - On survey completion, the complete session is uploaded to `/eeg-sessions` as a JSON blob.

---

## 5. Report Generation Pipeline (Two-Stage LLM)

Initiated via `POST /analyze-report` (`ciq/reports/routes.py`):
1. **Stage 1: Behavioral Analysis**:
   - Uses `AzureChatClient` (`ciq/llm/azure_chat.py`) with strict JSON schema.
   - Analyzes blink-rate deviations, pupil changes, latency anomalies, and survey response patterns against literature rules.
2. **Stage 2: Consultative Summary**:
   - Generates an empathetic spoken narrative for the user referencing the behavioral findings.
   - Sets conversation state flag `report_delivered = True` so subsequent user questions can query results directly.

---

## 6. Persistence & Deployment Model

- **Database**: Single local SQLite database at `app/backend/data/ciq.db`.
- **Concurrency**: SQLite runs in WAL mode (`journal_mode=WAL`) with a 5000ms busy timeout.
- **Durability**: **Litestream** (`app/backend/litestream.yml`, `app/Dockerfile`, `entrypoint.sh`). Litestream continuously streams WAL frames to an Azure Blob container and restores the DB upon container startup.
- **Deployment Constraint**: **Single Replica Only**. Litestream supports a single writer. The Azure Container App is pinned to `minReplicas = 1, maxReplicas = 1`. Do not introduce multi-replica shared memory state.
