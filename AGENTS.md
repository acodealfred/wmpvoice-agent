# Instructions for Coding Agents

Instructions for developers and automated coding agents working on **CIQ**. It
covers code layout, environment setup, testing, and conventions.

> **`CLAUDE.md` is the authoritative architecture reference.** This file covers
> practical workflow (setup, run, lint, deploy, checklist); when the two overlap,
> `CLAUDE.md` and `docs/` win.

## Overview

CIQ is a voice-enabled **burnout assessment** application. Users speak to an AI
agent that administers the BAT (Burnout Assessment Tool) survey while the browser
optionally captures facial biometrics (blink rate via MediaPipe, emotion via AWS
Rekognition). A two-stage LLM pipeline then produces a behavioural report and a
spoken consultative response. Managers get a de-identified dashboard and a
grounded "Wellbeing Assistant" chat.

The app originated from the Azure VoiceRAG sample; **RAG (Azure AI Search) is
currently disabled** (preserved in `ragtools.py`).

**Main technologies:**
- **Backend**: Python 3.11+ with aiohttp; organised as the `app/backend/ciq/` package
- **Frontend**: React + TypeScript, built with Vite
- **LLM**: Azure OpenAI (GPT-4o Realtime API + gpt-4o chat)
- **Biometrics**: MediaPipe (browser) + AWS Rekognition
- **Persistence**: SQLite + Litestream (durable across deploys)
- **Infra**: Azure Bicep → Azure Container Apps, via Azure Developer CLI (azd)

**Primary entry points:**
- `app/backend/app.py` — thin shim → `ciq.server.create_app` (gunicorn/aiohttp entry)
- `app/backend/ciq/server.py` — `create_app()`: composition root + route table
- `app/frontend/src/main.tsx` / `App.tsx` — React frontend
- `scripts/start.sh` / `scripts/start.ps1` — dev server startup

## Code layout

- `app/` — application code
  - `app/backend/` — Python backend
    - `app.py`, `rtmt.py` — **thin shims** re-exporting `ciq.server.create_app` /
      `ciq.realtime.middle_tier.RTMiddleTier` (kept for entrypoints + legacy imports)
    - `ciq/` — the decomposed backend package (see `docs/refactoring.md`)
      - `server.py` — composition root + full route table
      - `bootstrap.py`, `config.py`, `survey.py`
      - `realtime/` — `middle_tier.py` (RTMiddleTier WS proxy), session, control routes, tools
      - `reports/` — report prompt builders + `/analyze-report` endpoint & scoring
      - `chat/` — Wellbeing Assistant (`rbac`, `tools`, `prompts`, `guardrails`, `orchestrator`, `routes`)
      - `kb/`, `llm/`, `prompts/`, `common/`, `api/`, `biometrics/`
    - `auth.py`, `db.py`, `db_init.py`, `survey_loader.py`,
      `biometric_interpreter.py`, `demo_data.py` — legacy cohesive modules used by `ciq`
    - `ragtools.py` — RAG/Azure AI Search integration (currently disabled)
    - `litestream.yml`, `entrypoint.sh` — persistence (see `docs/persistence.md`)
    - `surveys/` — survey definitions loaded by `survey_loader.py`
    - `tests/` — pytest suite (`pytest.ini`)
    - `requirements.txt` — Python dependencies
  - `app/frontend/` — React + TypeScript (Vite)
    - `src/components/ui/`, `src/hooks/` — components and hooks
    - `vite.config.ts` — build config (builds into `app/backend/static/`)
  - `app/Dockerfile` — container image
- `infra/` — Bicep IaC (`main.bicep`, `main.parameters.json`, `core/`)
- `scripts/` — dev/deploy helpers (`start`, `write_env`, `setup_intvect`, `load_python_env`)
- `docs/` — architecture & operational docs (see index in `README.md`)
- `azure.yaml` — azd configuration · `pyproject.toml` / `ruff` — lint config

## Running the code

### Prerequisites
- [Azure Developer CLI](https://aka.ms/azure-dev/install), [Node.js](https://nodejs.org/),
  [Python 3.11+](https://www.python.org/downloads/), [Git](https://git-scm.com/downloads)
- Windows: Python + pip in PATH; [PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell)

### Local development setup

```bash
# 1. Python venv
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r app/backend/requirements.txt

# 2. Frontend deps
cd app/frontend && npm install && cd ../..

# 3. Configure app/backend/.env (see Environment variables below)

# 4. Run (installs frontend deps, builds, starts backend on :8765)
./scripts/start.sh                   # Windows: pwsh .\scripts\start.ps1
```

Open [http://localhost:8765](http://localhost:8765). For a hot-reloading
frontend, run `python app/backend/app.py` and `cd app/frontend && npm run dev`
in separate terminals (the dev server proxies `/realtime` → `ws://localhost:8765`).

### Deploying to Azure

```bash
azd auth login                       # --use-device-code in Codespaces
azd env new                          # names the resource group
azd up                               # provision + build + deploy
```

`azd up` incurs Azure costs; run `azd down` to clean up. Post-provision hooks run
`scripts/write_env.sh` and `scripts/setup_intvect.sh`. Real-time API regions:
`eastus2` or `swedencentral`. The app is pinned to a **single replica**.

## Running the tests

This repo has a pytest suite under `app/backend/tests/` (`pytest.ini`,
`docs/test-plan.md`, `docs/critical-tests-guide.md`).

```bash
source .venv/bin/activate
cd app/backend && pytest -q                      # run tests
pytest --cov=. --cov-report=term-missing         # with coverage
```

Frontend tests, when present, run via `cd app/frontend && npm test`.

## Environment variables

**Required:**
- `AZURE_OPENAI_ENDPOINT` — Azure OpenAI resource (e.g. `wss://<name>.openai.azure.com`)
- `AZURE_OPENAI_REALTIME_DEPLOYMENT` — e.g. `gpt-4o-realtime-preview`
- `AZURE_OPENAI_REALTIME_VOICE_CHOICE` — `alloy` | `echo` | `shimmer`

**Optional feature flags:**
- `ENABLE_SURVEY_MODE` — burnout-specialist persona + survey tools
- `ENABLE_SENTIMENT_ANALYSIS` — voice sentiment tool
- `ENABLE_BIOMETRIC_GUARDRAIL` — descriptive-only biometric guardrail (admin-togglable)

**Other integrations:**
- AWS Rekognition: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Wellbeing chat / KB: `AZURE_OPENAI_CHAT_DEPLOYMENT`, `MITHRA_APP_TOKEN`, `MITHRA_API_BASE_URL`
- Persistence (set by infra): `LITESTREAM_REPLICA_URL`
- `RUNNING_IN_PRODUCTION` — disables `.env` loading

Omit `*_API_KEY` values to use Entra ID / Managed Identity
(`AzureDeveloperCliCredential` locally with azd; `DefaultAzureCredential`
otherwise). **The authoritative env-var list is in `CLAUDE.md`.**
Azure AI Search vars are **not required** (RAG is disabled).

## Conventions & gotchas

### Code style
- **Python**: Ruff (config in `pyproject.toml`) — `ruff check app/backend`
- **Frontend**: TypeScript (strict) + Prettier — `cd app/frontend && npm run format`

### Common pitfalls
1. **Python 3.11+** required (`python --version`).
2. Always activate `.venv` before pip/python.
3. Run `npm install` in `app/frontend/` before building.
4. Frontend builds into `app/backend/static/`; the backend serves it at `/`.
5. Backend runs on port **8765**; dev server proxies `/realtime` there.
6. **Don't put logic in `app.py` / `rtmt.py`** — they are shims. Real code lives
   in the `ciq/` package (`ciq/server.py` for routes).
7. Real-time API only in `eastus2` / `swedencentral`.
8. Single-replica constraint: don't introduce cross-request in-memory state
   assuming multiple replicas — and Litestream needs a single writer.
9. Azure costs accrue immediately after `azd up`; `azd down` to clean up.

### File paths
- Backend loads `.env` from `app/backend/.env`
- SQLite DB at `app/backend/data/ciq.db` (WAL; replicated by Litestream)
- WebSocket endpoint at `/realtime`

## Validation checklist

Before opening a pull request:

- [ ] `.venv` activated; deps installed (`pip install -r app/backend/requirements.txt`)
- [ ] Frontend deps installed (`cd app/frontend && npm install`)
- [ ] Python lints: `ruff check app/backend`
- [ ] Frontend formatted: `cd app/frontend && npm run format`
- [ ] Frontend builds: `cd app/frontend && npm run build`
- [ ] Backend starts: `python app/backend/app.py`
- [ ] Tests pass: `cd app/backend && pytest -q`
- [ ] No secrets or `.env` files committed; no stray debug prints / console.logs
- [ ] Docs updated if behaviour changed (`CLAUDE.md`, `docs/`, `AGENTS.md`)
- [ ] Env vars documented if added (`CLAUDE.md` + here)
- [ ] Infra changes reflected in `infra/main.bicep` if applicable
- [ ] Manual testing done (voice interaction if audio changed; dashboard/chat if those changed)

## When to search

Trust this file and `CLAUDE.md` first for setup, deployment, testing, and
structure. Perform source-wide searches (`grep`/`rg`) when this file is unclear
or possibly outdated, when locating a specific implementation or all usages of an
API, or when debugging code flow.
