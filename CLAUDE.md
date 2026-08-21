# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first: `main` is not the product

The git root is `wmpvoice-agent/` (the folder above it is not a repo). The branch you land on determines what codebase you are looking at, and the difference is drastic:

| Branch | What it actually contains |
|---|---|
| `main`, `ux-redesign` | The upstream Azure `aisearch-openai-rag-audio` sample with RAG commented out. ~1,700 lines. A plain voice assistant. **No CIQ product code at all.** |
| `origin/release/ciq-alpha-v2` | **The real CIQ application — 129 commits ahead of `main`, 0 behind** (verified 2026-08-20). Auth and roles, biometrics, survey engine, reports, admin and manager dashboards, and a working test suite. |

Do not describe the app, plan a feature, or estimate work from `main`. Check the branch first, and read `origin/release/ciq-alpha-v2` when the question is about how CIQ behaves. `APP.md` on that branch is the product description (what CIQ measures, what it stores, its disclaimers).

Two dozen other branches exist. By last-commit date the most recent are `feature/infrastructure-readiness` (2026-08-03) and then `release/ciq-alpha-v2` / `feature/ciq-alpha-v2` (both 2026-07-21, same commit). Confirm which line is current before building on any of them.

## What this workspace is for

Defining the **UI and UX of CIQ** — a private wellbeing self-reflection tool. Most work here is design direction, copy, screen flow, and frontend implementation. The Python backend and Azure infra are inherited scaffolding: understand them enough not to break the voice path, but they are rarely the thing being changed.

### The open UX problem

CIQ runs one instrument across very different populations — petroleum shift crews, eldercare staff, the people they care for. The recurring complaint is that **every use case changes the UI**. The diagnosed cause, on `ciq-alpha-v2`:

- The survey catalogue is rendered *as interface* — `TEST / BATFULL / CBTFULL` buttons sit in the camera panel header of `App.tsx`, and `types.ts` types them as `activeSurveyType: "TEST" | "BATFULL" | "PILOT" | "CBTFULL"`.
- Report layout is driven by the scoring model (independent `scoringSections` for PILOT's BAT-4/CBI-WRB3 vs. one combined gauge otherwise), so a new instrument means a new layout.
- The consent modal is gated on `activeSurveyType === "PILOT"` — trust is a per-configuration toggle rather than structural.
- Six role-gated tabs (Home, Dashboard, Assessment, Admin, Test Generator, History) put the personal ritual, the manager product, and the admin console in one shell.

**The conclusion that survived several design rounds: assessment configuration must not live inside the interface.** Where the variation goes instead is unsettled — see the design history below.

## Design sources of truth

- **`docs/CIQ-product-ux-overhaul.md`** — the agreed product and UX direction: privacy model, consent flow, the check-in journey, employer-aggregate boundaries, and an explicit list of current UI issues to avoid.
- **`docs/user-first-voice-assistant-mockup.html`** — an interactive dark-theme prototype of that journey.
- **The pitch deck** (`~/Desktop/Pitch decks/v5/CIQ_Pitch_Deck_v5.pdf`, 27pp) is the strongest available design brief. Load-bearing claims: a 90-second reading at handover on a shared tablet; *"the participant sees a result, not a readout"* and *"direction of travel, not a verdict"* (p.6); each person scored against **their own baseline**, never a population average; trust as the primary barrier and the whole Conscience Engagement Framework (p.7); *"the instrument does not change between industries — only the operating variables"* (p.16).

### Non-negotiable copy rules

Safety and trust requirements, not tone preferences:

- **Never** use diagnostic or clearance framing: no "fit", "pre-tour readiness", "clearance", "passed/failed", and no `Low / Moderate / High Risk` presented as a verdict.
- **Prefer** "private check-in", "today's snapshot", "reflection", "recovery", "next step".
- State the boundary plainly: "Only you can see this individual result" / "Your employer sees anonymous, combined trends only."
- Explain consent **before** any browser camera/microphone prompt — and consent must precede any reading, not merely accompany it.
- Lead results with a supportive non-diagnostic reflection compared against the person's **own** baseline; end with one curated next step.
- Never surface live biometric values during a check-in, and never leak profile codes (`TEST`, `BATFULL`, `PILOT`, `CBTFULL`) into end-user UI.
- One primary action per screen; detail behind progressive disclosure.
- Accessibility is spec: contrast, visible focus states, readable type, reduced-motion support.

### Design history — 2026-08-20/21 (all rejected)

Four directions were explored and **none approved**; the user closed with "let me get back to you". Do not treat any as settled:

1. `docs/ciq-one-ritual.html` — six-step fixed ritual with a content switcher. Rejected.
2. `docs/ciq-handover-checkin.html` — a collapsing setup wizard. Rejected as **too close to Visa Ready** (`app.bevisaready.com`, another product of the user's, built on similar tech). Its spine — wizard → confirm → baseline → session → report — is that product's, and reskinning it is not acceptable.
3. `docs/ciq-check-in-journal.html` — one continuous column that writes itself while you talk; history is the same scroll. Rejected.
4. The conversational agent surface itself was the one part explicitly praised ("the chatbot is super").

Visa Ready is a reference the user knows well. **Do not reproduce its workflow.** Its shape suits one-shot interview prep; CIQ is a recurring ritual, which is why its spine transplants badly.

## Working on `main` / `ux-redesign`

```bash
cd app/frontend && npm install
npm run dev      # Vite :5173, proxies /realtime → ws://localhost:8765
npm run build    # tsc -b && vite build → outputs into app/backend/static
npm run format   # prettier: 4-space tabs, 160 cols, arrowParens avoid, no trailing commas

./scripts/load_python_env.sh          # creates .venv at the REPO ROOT, despite what it echoes
./.venv/bin/python app/backend/app.py # serves on :8765
ruff check app/backend
```

**There is genuinely no test harness on this branch** — verified 2026-08-20: no test files, no pytest config, no test script in `package.json`. Changes here can only be validated by running the app; say that plainly rather than implying tests cover it. (A harness *does* exist on `ciq-alpha-v2` — see below. Don't build one from scratch without looking there first.)

Architecture: `app/backend/rtmt.py` is a bidirectional protocol rewriter, not a passthrough proxy. It intercepts the client's `session.update` and overwrites `instructions`, `voice`, `temperature`, `max_response_output_tokens`, `tools`, and `tool_choice`, and blanks instructions/tools out of `session.created`. **So the assistant's persona and voice cannot be changed from the frontend** — the system message is hardcoded in `app.py`, the voice comes from `AZURE_OPENAI_REALTIME_VOICE_CHOICE`. A UX decision about assistant tone is a backend edit.

RAG is disabled, not deleted: `app.py`, `App.tsx`, `azure.yaml`, `infra/main.bicep` and `requirements.txt` keep the paths as commented blocks, and `ragtools.py` is a no-op stub over the preserved original. Don't delete them and don't re-enable them as a side effect.

`AGENTS.md` is the upstream onboarding doc and is **partly stale**: it describes RAG as live and references a `data/` directory that no longer exists. Env vars actually read: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_REALTIME_DEPLOYMENT`, `AZURE_OPENAI_REALTIME_VOICE_CHOICE`, plus optional `AZURE_OPENAI_API_KEY` / `AZURE_TENANT_ID` / `RUNNING_IN_PRODUCTION`.

## Working on `release/ciq-alpha-v2`

Surveyed, not exhaustively read. What's there:

- **Backend**: a `ciq/` package — `api/` (baseline, consent, history, meta routes), `biometrics/` (incl. AWS Rekognition), `chat/` (orchestrator, prompts, guardrails, rbac), plus `auth.py` and `biometric_interpreter.py`. SQLite persistence made durable via Litestream.
- **Frontend**: `App.tsx` is ~1,470 lines holding nearly all state — roles (`admin` / `manager` / `employee`), six tabs, three themes (light/dark/ocean), survey state, biometrics, consent. Components include login/signup, guest and manager landings, admin panel, detailed report, video panel, cyber avatar, test generator.
- **Tests exist here.** `app/backend/pytest.ini` (`asyncio_mode = auto`, `testpaths = tests`) with `tests/unit/test_survey_loader.py` and `tests/integration/{test_auth,test_analyze_report}.py`; `app/frontend/vitest.config.ts` with `npm test` → `vitest run` and `bands.test.ts`. **Not run in this session** — no claim is made about whether they pass.

## Gotchas

- **`app/backend/requirements.txt` is UTF-16 LE with CRLF.** `cat`/`sed`/naive appends corrupt it; verify with `file` after editing.
- **The frontend build output *is* `app/backend/static/`** (`vite.config.ts`: `outDir: "../backend/static"`, `emptyOutDir: true`). Gitignored and regenerated — never hand-edit or commit files there.
- Three places pin the realtime model and **they disagree**: `rtmt.py` hardcodes `api_version = "2024-10-01-preview"`, `infra/main.parameters.json` defaults the deployment version to `2025-08-28`, `azure.yaml` sets `2024-07-18`. Version bumps have broken this app repeatedly — reconcile all three.
- Local backend binds `localhost:8765`; the container runs gunicorn on `0.0.0.0:8000`.
- Path alias `@/` → `app/frontend/src/`; shadcn conventions (`components.json`, Tailwind, `cn()`).
- Four locales are bundled (`en`, `es`, `fr`, `ja`). New user-facing strings go through `t()` and need entries in all four.
- On `main` only: `grounding-file*.tsx` and `history-panel.tsx` are leftover RAG UI, unreferenced. `history-panel.tsx` is **not** a CIQ history screen.
