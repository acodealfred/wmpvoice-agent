# CIQ Operational Workflows & Commands

## 1. Local Development Workflows

### Initial Setup
```bash
# 1. Python virtual environment (Python 3.11+)
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r app/backend/requirements.txt

# 2. Frontend dependencies
cd app/frontend && npm install && cd ../..

# 3. Environment configuration
cp app/backend/.env.sample app/backend/.env # or populate app/backend/.env
```

### Running Locally
- **One-Command Startup**:
  - Unix/macOS: `./scripts/start.sh`
  - Windows: `pwsh .\scripts\start.ps1`
  *(Installs frontend deps, builds frontend to `app/backend/static/`, and runs backend on `:8765`)*
- **Dual-Process Hot Reloading**:
  - Terminal 1 (Backend): `python app/backend/app.py` (serves `:8765`)
  - Terminal 2 (Frontend): `cd app/frontend && npm run dev` (serves `:5173`, proxies `/realtime` to `ws://localhost:8765`)

---

## 2. Testing Workflows

### Backend (Pytest)
```bash
# Run all tests quietly
cd app/backend && pytest -q

# Run with coverage report
cd app/backend && pytest --cov=. --cov-report=term-missing

# Run a specific unit test file
cd app/backend && pytest tests/unit/test_survey_loader.py -v

# Run a specific test function by name pattern
cd app/backend && pytest tests/unit/test_survey_loader.py -k "test_effective_score" -v

# Run integration tests
cd app/backend && pytest tests/integration/test_analyze_report.py -v
```

### Frontend (Vitest)
```bash
# Run all vitest suites
cd app/frontend && npm test

# Run vitest in watch mode
cd app/frontend && npm run test:watch

# Run a specific test file
cd app/frontend && npx vitest run src/lib/bands.test.ts
```

---

## 3. Linting, Formatting & Type Checking

```bash
# Python linting
ruff check app/backend

# Frontend formatting
cd app/frontend && npm run format

# Frontend TypeScript check + production bundle build
cd app/frontend && npm run build
```

---

## 4. Pre-PR Validation Checklist

Run these steps in order before opening a pull request or submitting code:

1. [ ] **Backend Lint**: `ruff check app/backend` (zero warnings/errors)
2. [ ] **Frontend Format**: `cd app/frontend && npm run format`
3. [ ] **Frontend Build**: `cd app/frontend && npm run build` (tsc clean)
4. [ ] **Backend Tests**: `cd app/backend && pytest -q` (all pass)
5. [ ] **Frontend Tests**: `cd app/frontend && npm test` (all pass)
6. [ ] **Git Cleanliness**: `git diff` shows only intended changes; no debug print statements or stray `.env` secrets.
7. [ ] **Single Replica Check**: Verify no cross-process in-memory state was introduced that breaks Litestream.

---

## 5. Deployment Workflow (Azure Container Apps)

```bash
azd auth login      # authenticate with Azure CLI
azd env new         # initialize environment name
azd up              # provisions infra, builds Docker container, deploys
```

- Infrastructure definition: `infra/main.bicep`
- Post-provision scripts: `scripts/write_env.sh` (or `write_env.ps1`) writes deployed endpoints to `app/backend/.env`.
- Database storage: Container bootstraps Litestream to replicate `app/backend/data/ciq.db` to Azure Blob storage.
