# CIQ — Claude Code Operating Instructions (`.claude/CLAUDE.md`)

This file guides Claude Code when working in the CIQ repository. It enforces **context-window efficiency**, **architectural integrity**, and **safe workflows**.

---

## 1. Quick Repository Identity

**CIQ** is a voice-enabled burnout assessment system.
- **Backend**: Python 3.11+ / aiohttp (`ciq/` package). Shims: `app/backend/app.py`, `app/backend/rtmt.py`.
- **Frontend**: React 18 / TypeScript / Vite / TailwindCSS (`app/frontend/src/`).
- **Core Pipeline**: Microphone → WebSocket (`/realtime`) → `RTMiddleTier` → Azure OpenAI Realtime API.
- **Biometrics**: MediaPipe (browser eye/pupil tracking) + AWS Rekognition (facial emotion).
- **Reports**: Two-stage LLM pipeline via `POST /analyze-report` (strict JSON behavioral analysis + consultative spoken summary).
- **Database & Persistence**: SQLite in WAL mode (`app/backend/data/ciq.db`) replicated via Litestream to Azure Blob. **Single-replica constraint**.

---

## 2. Context Budgeting & Efficiency Rules

### Rule 1: Progressive Disclosure
Never scan or load broad swathes of the repository into context.
1. **Check Persistent Context**: Check `.claude/context/` (`architecture.md`, `services.md`, `database.md`, `conventions.md`, `workflows.md`) before grepping.
2. **Locate Target Files**: Use targeted grep for specific symbols or route paths.
3. **Read Only Line Slices**: Use `view_file` with explicit `StartLine` and `EndLine` (50–100 lines max).
4. **Never Read Entire Large Files**:
   - `app/frontend/src/App.tsx` (112KB) — Read only target handler or hook.
   - `app/backend/db.py` (58KB) — Read only target query function.
   - `app/backend/ciq/realtime/middle_tier.py` (55KB) — Read only target event or tool handler.
   - `app/frontend/src/components/ui/admin-panel.tsx` (73KB) — Read only target tab/section.
   - `app/frontend/src/components/ui/manager-landing.tsx` (43KB) — Read only target chart/panel.

### Rule 2: Strictly Prohibited Paths
Never read or grep inside:
- `app/frontend/node_modules/`
- `app/backend/static/assets/` (built bundle blobs)
- `.venv/`
- `__pycache__/`, `*.pyc`
- `.pytest_cache/`, `.ruff_cache/`
- `app/backend/data/*.db*` (binary SQLite files)
- `app/frontend/package-lock.json` (233KB)
- `CIQ-Signal-Thresholds-Reference.pdf` (binary)
- `*.tsbuildinfo`, `.azure/`, `.git/`

---

## 3. Task Classification Flowchart

Before taking action, classify the task and follow the minimal required workflow:

| Classification | Definition | Minimal Workflow |
|---|---|---|
| **Question** | "Where is X?", "How does Y work?" | Consult `.claude/context/` → targeted search if needed → answer concisely. |
| **Exploration** | Deep inquiry into subsystem flow | Run `/explore` → produce structured summary → stop. |
| **Bug Fix** | Resolving runtime error or test failure | Run `/debug` → pinpoint error line → slice inspect → root-cause fix → targeted test. |
| **Small Change** | Localized text, style, or isolated tweak | Locate file → inspect slice → implement → run linter/test. |
| **Feature** | New endpoint, UI screen, or workflow | `/explore` → `/plan` → await approval → `/implement` → `/test` → `/review`. |
| **Refactor** | Reorganizing existing code structure | Verify tests pass → `/plan` → implement incrementally → verify tests pass. |
| **Architecture** | Schema change, new service integration | Deep exploration → `/plan` with risk matrix → phased implementation → full validation. |
| **Testing** | Adding or running test suites | Run `/test` with targeted suite first → expand if needed. |
| **Documentation** | Updating architecture, docs, or guides | Read existing doc → update with factual accuracy → no code touched. |

---

## 4. Specialized Agents & Slash Commands

Use specialized commands located in `.claude/commands/`:
- `/explore <query>` (`commands/explore.md` / `agents/explorer.md`): Discovers symbols & flows read-only.
- `/plan <task>` (`commands/plan.md` / `agents/planner.md`): Creates implementation blueprint without code edits.
- `/implement <task>` (`commands/implement.md` / `agents/implementer.md`): Executes approved plan with strict safety.
- `/review [diff]` (`commands/review.md` / `agents/reviewer.md`): PR-grade inspection against 6 review gates.
- `/test [scope]` (`commands/test.md` / `agents/tester.md`): Runs targeted pytest or vitest suites quietly.
- `/debug <error>` (`commands/debug.md` / `agents/debugger.md`): Forensic tracing from stacktrace to root cause.

---

## 5. Architectural Guardrails (Must Never Violate)

1. **Keep Shims Thin**: `app/backend/app.py` and `app/backend/rtmt.py` are strictly shims. Put all route handlers in `ciq/server.py` and backend logic in `app/backend/ciq/<domain>/`.
2. **Single-Replica Constraint**: Litestream supports a single writer. Never introduce multi-replica shared memory state.
3. **Idempotent SQLite Migrations**: Schema alterations must be added via `ALTER TABLE ... ADD COLUMN` inside `try...except aiosqlite.OperationalError` blocks in `app/backend/db_init.py`.
4. **Parameterized SQL**: Always use `?` placeholders with `aiosqlite`. Never string-format SQL queries.
5. **Safe LLM JSON Parsing**: Always parse LLM markdown strings using `ciq.common.json_utils.parse_llm_json`.
6. **RBAC Boundaries**:
   - `admin`: Full access to `/admin/*`, system toggles, database export.
   - `manager`: Access to `/manager/*` (de-identified, active employees only) and manager chat. Blocked from `/admin/*`.
   - `employee`: Access to personal assessment, baseline, consent, recovery, and `/me/*`. Blocked from `/admin/*` and `/manager/*`.

---

## 6. Verification & Validation Commands

Run these exact commands to validate work:
- **Backend Lint**: `ruff check app/backend`
- **Backend Unit Tests**: `cd app/backend && pytest tests/unit/ -v`
- **Backend Integration Tests**: `cd app/backend && pytest tests/integration/ -v`
- **Frontend Format**: `cd app/frontend && npm run format`
- **Frontend Build & Typecheck**: `cd app/frontend && npm run build`
- **Frontend Tests**: `cd app/frontend && npm test`
