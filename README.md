# CIQ — Voice-Enabled Burnout Assessment

CIQ is a voice-enabled burnout assessment web application. Users speak to an AI
agent that administers the **BAT (Burnout Assessment Tool)** survey while the
browser optionally captures facial biometrics (blink rate via MediaPipe,
emotions via AWS Rekognition). After the survey, a two-stage LLM pipeline
generates a behavioural analysis report and a spoken consultative response.
Managers get a de-identified organisational dashboard and a grounded "Wellbeing
Assistant" chat.

> The app originated from the Azure [VoiceRAG](https://aka.ms/voicerag) sample
> and has since diverged substantially. RAG (Azure AI Search) is currently
> **disabled** but preserved in `app/backend/ragtools.py`. For the authoritative
> architecture and conventions, see **`CLAUDE.md`** and **`docs/`** — this README
> is the quick-start overview.

* [Features](#features)
* [Architecture](#architecture)
* [Getting started (local)](#getting-started-local)
* [Environment variables](#environment-variables)
* [Deploying to Azure](#deploying-to-azure)
* [Documentation](#documentation)
* [Project history](#project-history)

## Features

* **Voice survey agent** — the browser mic streams to the Azure OpenAI GPT-4o
  Realtime API (proxied through `RTMiddleTier`), which administers and scores the
  BAT survey conversationally and can answer follow-up questions about results.
* **Facial biometrics (optional)** — MediaPipe FaceLandmarker computes blink
  rate → stress state; AWS Rekognition derives a dominant face emotion. Captured
  per question and folded into the report as descriptive context only.
* **Two-stage report** — a strict-JSON behavioural analysis followed by a spoken
  consultative summary, grounded in blink-rate research rules and the survey
  snapshot.
* **Roles & RBAC** — `admin`, `manager`, and `employee` (the assessed staff).
* **Manager dashboard** — de-identified org aggregates: risk distribution,
  per-department participation and risk mix, burnout-score trends, and a 3D
  campus view. See `docs/manager-dashboard.md`.
* **Wellbeing Assistant chat** — two RBAC-gated surfaces (manager org / personal)
  sharing one grounded, PII-safe engine. See `docs/manager-chat.md`.
* **Durable persistence** — SQLite made durable across deployments via
  Litestream. See `docs/persistence.md`.

## Architecture

```
Browser mic → useAudioRecorder → WebSocket /realtime
                                       ↓
                         RTMiddleTier (ciq/realtime/middle_tier.py)
                                       ↓
                       Azure OpenAI GPT-4o Realtime API (WebSocket)
```

The backend is the `app/backend/ciq/` package (composition root:
`ciq/server.py`; entrypoints `app.py` / `rtmt.py` are thin shims). The frontend
is React + TypeScript (Vite), built into `app/backend/static/` and served by the
aiohttp backend. Full breakdown in `CLAUDE.md` and `docs/refactoring.md`.

**Main technologies:** Python 3.11+ / aiohttp · React + TypeScript + Vite ·
Azure OpenAI (GPT-4o Realtime + chat) · AWS Rekognition · SQLite + Litestream ·
Azure Container Apps via Bicep + `azd`.

## Getting started (local)

```bash
# 1. Python backend
python3 -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate
pip install -r app/backend/requirements.txt

# 2. Create app/backend/.env (see below), then run everything:
./scripts/start.sh                        # installs frontend deps, builds, starts backend on :8765
```

The app is then available at [http://localhost:8765](http://localhost:8765).

For separate dev processes (backend + hot-reloading frontend):

```bash
# Backend
source .venv/bin/activate && python app/backend/app.py
# Frontend dev server (proxies /realtime → ws://localhost:8765)
cd app/frontend && npm run dev
```

Lint / format / build:

```bash
ruff check app/backend                     # Python lint
cd app/frontend && npm run format          # frontend format
cd app/frontend && npm run build           # type check + build
```

## Environment variables

Minimal `app/backend/.env`:

```
AZURE_OPENAI_ENDPOINT=wss://<name>.openai.azure.com
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime-preview
AZURE_OPENAI_REALTIME_VOICE_CHOICE=alloy      # alloy | echo | shimmer
```

Common optional flags: `ENABLE_SURVEY_MODE`, `ENABLE_SENTIMENT_ANALYSIS`,
`ENABLE_BIOMETRIC_GUARDRAIL`; AWS Rekognition (`AWS_REGION`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`); Wellbeing chat (`MITHRA_APP_TOKEN`,
`AZURE_OPENAI_CHAT_DEPLOYMENT`). Omit `*_API_KEY` values to use Entra ID /
Managed Identity. **The full, authoritative list lives in `CLAUDE.md`.**

## Deploying to Azure

Deployed to Azure Container Apps with the Azure Developer CLI:

```bash
azd auth login          # --use-device-code in Codespaces
azd env new
azd up                  # provision + build + deploy
```

The real-time API requires region `eastus2` or `swedencentral`. Post-provision
hooks run `scripts/write_env.sh` and `scripts/setup_intvect.sh`. The app is
pinned to a **single replica** (single writer — required by both the in-memory
session state and Litestream). Run `azd down` to tear down and avoid costs.

> **Manual steps after each `azd up` (infra refresh)** — set in the Container App
> config, sourced from the Azure portal for the provisioned OpenAI resource:
> ```
> ENABLE_SURVEY_MODE=true
> AZURE_OPENAI_ENDPOINT=https://<your-openai-resource>.openai.azure.com/
> AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
> ```

## Documentation

| Doc | Covers |
|---|---|
| `CLAUDE.md` | **Start here** — architecture, commands, env vars, key files |
| `docs/refactoring.md` | The `ciq` package decomposition |
| `docs/manager-dashboard.md` | Dashboard data model & counting rules |
| `docs/manager-chat.md` | Wellbeing Assistant chat architecture + RBAC |
| `docs/persistence.md` | SQLite + Litestream durability |
| `docs/biometrics-inventory.md` | Biometric signals & pipeline |
| `docs/test-plan.md`, `docs/critical-tests-guide.md` | Testing |
| `docs/existing_services.md`, `docs/customizing_deploy.md`, `docs/manual_setup.md` | Deployment options |

## Project history

The app evolved through a series of feature branches (voice sentiment →
biometric integration → report analyzer → UI restructure → agent optimization →
SSOT/Mithra KB integration → test generation). The MVP was frozen on
`feature/simple-product-v1`; investor-demo work then moved to
`release/ciq-alpha-v1`, with features developed on `feature/ciq-alpha-*` and
merged on each success. The current branch is `feature/ciq-alpha-v1`.
