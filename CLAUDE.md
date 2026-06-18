# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**CIQ** is a voice-enabled burnout assessment application. Users speak to an AI agent that administers the BAT (Burnout Assessment Tool) survey, while the browser optionally captures facial biometrics (blink rate via MediaPipe, emotions via AWS Rekognition). After the survey, a two-stage LLM pipeline generates a behavioral analysis report and a spoken consultative response.

The app originated from the Azure VoiceRAG sample and has been extended significantly. RAG (Azure AI Search) is currently disabled but the code is preserved in `ragtools.py` and commented out in `app.py`.

## Commands

### Run the full app (production-like)
```bash
./scripts/start.sh        # Linux/Mac: installs frontend deps, builds, starts backend on :8765
```

### Development (separate processes)
```bash
# Backend only
source .venv/bin/activate
python app/backend/app.py

# Frontend dev server (with WebSocket proxy to :8765)
cd app/frontend && npm run dev
```

### Lint and format
```bash
# Python lint
ruff check app/backend

# Frontend format
cd app/frontend && npm run format

# Frontend type check + build
cd app/frontend && npm run build
```

### Python environment setup
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r app/backend/requirements.txt
```

There are no automated tests in this repository.

## Environment variables (`app/backend/.env`)

**Required:**
```
AZURE_OPENAI_ENDPOINT=wss://<name>.openai.azure.com
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime-preview
AZURE_OPENAI_REALTIME_VOICE_CHOICE=alloy  # alloy | echo | shimmer
```

**Optional feature flags:**
```
ENABLE_SENTIMENT_ANALYSIS=true   # enables voice sentiment tool in RTMiddleTier
ENABLE_SURVEY_MODE=true          # switches to burnout-specialist persona + survey tools
ENABLE_BIOMETRIC_GUARDRAIL=true  # default for the descriptive-only biometric guardrail
                                 # (agent declines interpret/predict/prescribe on biometrics).
                                 # Runtime-togglable from the Admin tab via POST /admin/biometric-guardrail.
                                 # NOTE: that endpoint is auth-gated only (no admin role) — not a hardened boundary.
```

**AWS Rekognition (face emotion analysis):**
```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Omit `AZURE_OPENAI_API_KEY` and `AZURE_SEARCH_API_KEY` to use Entra ID / Managed Identity instead of key-based auth. When running locally with `azd`, `AzureDeveloperCliCredential` is used; in production, `DefaultAzureCredential` picks up the managed identity.

## Architecture

### Request flow

```
Browser mic → useAudioRecorder → WebSocket /realtime
                                       ↓
                              RTMiddleTier (rtmt.py)
                                       ↓
                       Azure OpenAI GPT-4o Realtime API (WebSocket)
```

`RTMiddleTier` (`app/backend/rtmt.py`) is the core: it opens a WebSocket to Azure OpenAI and proxies messages between the frontend and the model. It intercepts `function_call` and `function_call_arguments_done` events to handle three custom tools:

| Tool | Trigger | What it does |
|---|---|---|
| `report_sentiment` | After each utterance (when sentiment enabled) | Captures voice sentiment; broadcasts `sentiment_update` back to frontend |
| `record_survey_response` | After the model scores a BAT question | Stores score + biometrics in `_survey_results`; broadcasts `survey_biometric_update` |
| `query_survey_results` | When user asks about their results post-survey | Queries `_survey_results` and returns structured data to the model |

### Biometrics pipeline

The frontend runs two parallel pipelines driven by `useBiometrics.ts` and `useVideoCapture.ts`:

1. **Blink rate / stress**: MediaPipe FaceLandmarker → compute blinks-per-minute → `POST /analyze-stress` → `BiometricInterpreter` (singleton in `biometric_interpreter.py`) → stress state (stressed/relaxed/normal) → `POST /biometrics` to update `RTMiddleTier` state → `POST /update-stress` to adapt agent behavior
2. **Face emotion**: Base64 JPEG frame → `POST /analyze` → AWS Rekognition `detect_faces` → dominant emotion → stored in `RTMiddleTier`

Current biometrics (`_current_blink_rate_change`, `_current_face_emotion`) are captured by the `record_survey_response` tool at answer time, creating per-question snapshots included in the final report.

### Report generation (two-stage LLM)

`POST /analyze-report` (in `app.py`) performs two sequential `rtmt.analyze_with_prompt()` calls:

1. **Behavioral analysis**: Strict JSON output — correlations, contradictions, patterns derived only from blink-rate research rules + survey snapshot data.
2. **Consultative response**: Spoken summary for the user, referencing the behavioral analysis. Stored as conversation state (`report_delivered`) so the agent can answer follow-up questions.

### Frontend state and WebSocket messages

Custom message types injected by `RTMiddleTier` back to the frontend (not part of the Azure OpenAI protocol):
- `sentiment_update` — voice sentiment for current utterance
- `survey_update` — legacy per-question update
- `survey_biometric_update` — rich snapshot including score + biometrics

`useRealtime.tsx` dispatches these to typed callbacks. `App.tsx` manages all survey/biometric/sentiment state centrally and passes it to `DetailedReport` and `SentimentHistoryPanel` components.

### Frontend build path

`vite build` writes output to `app/backend/static/`. The aiohttp server serves the built frontend at `/` and the backend API at `/analyze`, `/analyze-report`, `/analyze-stress`, `/biometrics`, `/config`, `/clear-conversation`, and `/realtime` (WebSocket).

During frontend dev (`npm run dev`), `vite.config.ts` proxies `/realtime` to `ws://localhost:8765`.

## Key files

| File | Purpose |
|---|---|
| `app/backend/rtmt.py` | RTMiddleTier — WebSocket proxy + tool interception + biometric state |
| `app/backend/app.py` | aiohttp server — REST endpoints + app wiring |
| `app/backend/biometric_interpreter.py` | BiometricInterpreter singleton — blink-rate stress detection |
| `app/backend/ragtools.py` | RAG/Azure Search integration (currently disabled) |
| `app/frontend/src/App.tsx` | Root React component — survey/biometric/sentiment state |
| `app/frontend/src/hooks/useRealtime.tsx` | WebSocket client + message dispatch |
| `app/frontend/src/hooks/useBiometrics.ts` | Camera biometric capture loop |
| `app/frontend/src/components/ui/detailed-report.tsx` | Survey results + report UI |

## Infrastructure

Deployed to Azure Container Apps via `azd up`. Key files: `azure.yaml`, `infra/main.bicep`, `app/Dockerfile`. Post-provision hooks run `scripts/write_env.sh` and `scripts/setup_intvect.sh`.

Real-time API requires regions: `eastus2` or `swedencentral`.
