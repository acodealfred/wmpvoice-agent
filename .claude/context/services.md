# CIQ Services & API Route Catalog

## 1. Process & Port Bindings

| Environment | Service | Port | Entrypoint / Command | Notes |
|---|---|---|---|---|
| **Local Dev** | Backend (aiohttp) | `8765` | `python app/backend/app.py` | Serves REST APIs + `/realtime` WebSocket |
| **Local Dev** | Frontend (Vite) | `5173` | `cd app/frontend && npm run dev` | Proxies `/realtime` to `ws://localhost:8765` |
| **Local Full** | Combined Dev | `8765` | `./scripts/start.sh` or `start.ps1` | Builds frontend, runs backend on port 8765 |
| **Production** | Azure Container App | `8000` | `/app/entrypoint.sh` → Gunicorn aiohttp | Single replica; Litestream WAL stream to Blob |

---

## 2. API Route Catalog (`ciq/server.py`)

### Authentication (`auth.py`)
- `POST /login` — Login with username + password; issues `session_token` cookie.
- `POST /logout` — Invalidate session in DB; clear cookie.
- `POST /api/signup` — Register new user account (`employee` role default).
- `GET /me` — Current authenticated user object, role, and profile.

### Realtime Control Plane & Biometrics (`ciq/realtime/`, `ciq/biometrics/`)
- `WS /realtime` — Bidirectional WebSocket proxy to Azure OpenAI GPT-4o Realtime API.
- `POST /biometrics` — Update active session biometrics (blink rate, pupil dilation, emotion).
- `POST /analyze` — Upload base64 JPEG frame for AWS Rekognition facial emotion analysis.
- `POST /analyze-stress` — Send blink-rate telemetry to `BiometricInterpreter`.
- `GET /config` — Return public runtime configuration (voice choice, feature flags).
- `POST /survey-type` — Change active survey definition (`bat-full`, `cbt-full`, `pilot`, `test`).
- `POST /survey-phase` — Update conversation phase (`intake`, `survey`, `report`).
- `POST /clear-conversation` — Reset active conversational state in middle tier.
- `POST /update-stress` — Update agent tone/pacing according to stress state.
- `GET /session` — Fetch active realtime session state and results.
- `POST /admin/biometric-guardrail` — **(Admin only)** Toggle descriptive-only guardrail.

### Recovery Window (`ciq/recovery/`)
- `POST /api/recovery-window/start` — Initiate a new recovery session.
- `GET /api/recovery-window/sessions/latest` — Fetch user's latest recovery session.
- `POST /api/recovery-window/sessions/{recoverySessionId}/recommend` — Calculate track recommendation.
- `POST /api/recovery-window/sessions/{recoverySessionId}/select-track` — Select recovery track.
- `POST /api/recovery-window/sessions/{recoverySessionId}/complete` — Complete session with reflection.
- `GET /api/recovery-window/sessions/{recoverySessionId}` — Fetch session details.
- `GET /admin/recovery-window/flagged` — **(Admin only)** List sessions flagged by safety guardrails.
- `POST /admin/recovery-window/flagged/{recoverySessionId}/ack` — **(Admin only)** Acknowledge safety flag.

### Reports Engine (`ciq/reports/`)
- `POST /analyze-report` — Two-stage LLM report execution (behavioral analysis + consultative summary).
- `POST /report/behavioral-analysis` — Stage 1 JSON behavioral anomaly report.
- `POST /report/consultative-summary` — Stage 2 conversational consultative report.
- `POST /ssot-report` — Deterministic survey score calculation without LLM invocation.

### EEG Headset (`ciq/eeg/`)
- `POST /eeg-sessions` — Upload complete Muse 2 recording JSON (`muse-web-bridge/3` format).
- `GET /admin/eeg-sessions/export` — **(Admin only)** Export recorded EEG sessions.

### History, Baseline, Consent & Analytics (`ciq/api/`)
- `GET /api/history` — Assessment history for current user.
- `GET /baseline`, `POST /baseline`, `DELETE /baseline` — Manage user calibrated biometric baseline.
- `GET /consent`, `POST /consent` — Get and accept informed consent form.
- `GET /admin/users` — **(Admin only)** List all registered users.
- `GET /admin/demo-data`, `POST /admin/demo-data` — **(Admin only)** Manage demo dataset.
- `GET /admin/pilot-survey/export` — **(Admin only)** Export pilot survey responses.
- `GET /admin/users/{userId}/survey-runs` — **(Admin only)** Export survey runs for a specific user.
- `GET /admin/survey-timeline/export` — **(Admin only)** Export 1-second timeline data.
- `GET /admin/survey-timeline/export-combined` — **(Admin only)** Export combined timeline + EEG.
- `GET /manager/overview` — **(Manager only)** Active employee headcount and risk distribution.
- `GET /manager/analytics` — **(Manager only)** Departmental breakdown and domain averages.
- `GET /manager/score-trend` — **(Manager only)** Historical burnout score trend line.

### Wellbeing Assistant Chat (`ciq/chat/`)
- **Manager Scope** (org-wide aggregated context):
  - `POST /manager/chat` — SSE streaming chat query.
  - `GET /manager/chats`, `GET /manager/chats/{chatId}`, `DELETE /manager/chats/{chatId}` — Chat history.
- **Personal Scope** (own assessment data only):
  - `POST /me/chat` — SSE streaming chat query.
  - `GET /me/chats`, `GET /me/chats/{chatId}`, `DELETE /me/chats/{chatId}` — Personal chat history.

### Mithra Knowledge Base (`ciq/kb/`)
- `GET /admin/kb/documents`, `POST /admin/kb/upload`, `DELETE /admin/kb/documents/{paperId}`
- `GET /admin/kb/settings`, `PATCH /admin/kb/settings`, `GET /admin/kb/debug`, `GET /admin/report-llm/debug`
- `POST /admin/kb/papers/search` — Search scientific burnout research papers.
- `POST /kb/chats`, `GET /kb/chats/{chatId}`, `POST /kb/chats/{chatId}/messages` — Direct KB chat proxy.
- `GET /version` — Returns application version and commit hash.

---

## 3. External Service Integrations

1. **Azure OpenAI**:
   - Realtime API (`wss://<name>.openai.azure.com`): Handles real-time speech-to-speech, turn detection, audio streaming.
   - Chat API (`gpt-4o`): Used by `AzureChatClient` for behavioral analysis reports and Wellbeing Assistant.
2. **AWS Rekognition**:
   - `detect_faces` in region `us-east-1` for dominant emotion detection from video frames.
3. **Mithra Knowledge Base**:
   - External scientific literature API authenticated via `MITHRA_APP_TOKEN`.
4. **Muse 2 BLE Headset**:
   - Web Bluetooth connection handled in browser (`useMuse.ts`). Uploaded directly to backend as raw telemetry.
