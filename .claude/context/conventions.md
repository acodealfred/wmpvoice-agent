# CIQ Coding & Architecture Conventions

## 1. Backend (Python 3.11+ / aiohttp)

### Linting & Formatting
- **Linter**: Ruff configured via `pyproject.toml` (`select = ["E", "F", "I", "UP"]`, `ignore = ["E501", "E701"]`).
- **Command**: `ruff check app/backend`
- Format style: 4 spaces, standard PEP 8, clean imports (isort-compatible rules enforced by Ruff).

### Module Organization & Routing
- **Layered Structure**: All new domain code belongs inside `app/backend/ciq/<submodule>/`.
- **Shims**: `app/backend/app.py` and `app/backend/rtmt.py` are strictly shims. Do not add route handlers, state, or helpers there.
- **Route Registration**: Add routes in `ciq/server.py` inside `create_app()`. Group routes logically under domain section comments.
- **Handler Signature**:
  ```python
  from aiohttp import web

  async def my_endpoint(request: web.Request) -> web.Response:
      auth_session = request.get("auth_session")  # populated by auth_middleware
      if not auth_session:
          return web.json_response({"error": "Unauthorized"}, status=401)
      # ...
      return web.json_response({"status": "ok"})
  ```
- **Error Handling**: Return clean JSON responses with explicit HTTP status codes (`web.json_response({"error": ...}, status=...)`). Never let unhandled exceptions leak stack traces to clients.
- **Logging**: Use the unified logger: `logger = logging.getLogger("voicerag")`.

### LLM Output Handling
- Never use raw `json.loads()` on LLM outputs directly.
- Always use `parse_llm_json()` from `ciq.common.json_utils` to safely strip markdown code fences (` ```json ... ``` `) and handle trailing commas or truncated buffers.

### Database Interaction
- Always use `aiosqlite` with parameterized queries (`?`). Never format strings into SQL.
- Fetch rows using `row_factory = aiosqlite.Row` when dict-like access is needed.
- Ensure transactions are committed (`await db.commit()`).
- Add new columns via idempotent migration statements in `app/backend/db_init.py` (see `database.md`).

---

## 2. Frontend (React 18 / TypeScript / Vite)

### Tooling & Commands
- **Formatting**: Prettier (`cd app/frontend && npm run format`).
- **Type Checking & Build**: `cd app/frontend && npm run build` (`tsc -b && vite build`).
- **Testing**: Vitest (`cd app/frontend && npm test`).

### TypeScript Standards
- TypeScript is set to strict mode.
- Explicit typing for all component props, hooks, API payloads, and WebSocket events.
- Central shared types live in `app/frontend/src/types.ts`.
- When adding new WebSocket messages, define the union variant in `types.ts` and handle it in `useRealtime.tsx`.

### State Management
- `App.tsx` is the central coordinator for assessment state, survey results, user session, and active view switching.
- Specialized screens (`admin-panel.tsx`, `manager-landing.tsx`, `recovery-window-screen.tsx`, `detailed-report.tsx`) receive props/callbacks from `App.tsx`.
- Because `App.tsx` is over 2500 lines, **never read it whole**. Use targeted inspection on specific state hooks or handler functions.

### Styling
- TailwindCSS 3 with `@radix-ui` headless primitives and `lucide-react` icons.
- CSS companion files (`guest-landing.css`, `manager-landing.css`, `guest-chat.css`) are used for complex animated surfaces and cyber visual accents. Maintain styling consistency with the cyber-clinical palette.

---

## 3. Testing Conventions

- **Backend Unit Tests** (`tests/unit/`): Focus on pure, deterministic functions (`survey_loader.py`, `spoken_report.py`, scoring calculations).
- **Backend Integration Tests** (`tests/integration/`): Use `aiohttp.test_utils.TestClient` with mocked Azure/boto3 clients.
- **Frontend Tests** (`src/**/*.test.ts`): Use Vitest to verify decoders, band math (`bands.test.ts`), session stability, and Muse protocol handlers.
- **Mocking**: Mock external network calls (Azure OpenAI, AWS Rekognition, Mithra API) in automated suites.

---

## 4. Security & Safety Checklist

- **RBAC Enforcement**:
  - `admin`: Full access to `/admin/*`, system toggles, database export.
  - `manager`: Access to `/manager/*` and manager chat. Blocked from `/admin/*`. Only accesses aggregated, de-identified employee metrics.
  - `employee`: Access to personal assessment, baseline, consent, recovery, and `/me/*`. Blocked from `/admin/*` and `/manager/*`.
- **Secrets Management**: Never commit API keys or connection strings. Use environment variables. In Azure, rely on Managed Identity (`DefaultAzureCredential`).
- **Biometric Guardrails**: When `ENABLE_BIOMETRIC_GUARDRAIL` is active, the agent must decline predictive or prescriptive biometric interpretations.
