# "Wellbeing Assistant" chat — architecture

A conversational assistant with **two surfaces** that share one engine:

- **Manager (org) surface** — `manager-chat.tsx` on the manager dashboard.
  Grounded in **de-identified org aggregates** + research.
- **Personal (guest) surface** — `guest-chat.tsx` on the returning-guest landing.
  Grounded in the signed-in user's **own assessments only** + research.

Both are **grounded and invent nothing**:

- **Operational SSoT** — live SQLite data (org aggregates for managers; the
  user's own records for guests).
- **Evidential SSoT** — the **Mithra Knowledge Base** RAG over the
  organisation's uploaded burnout research, returned with citations.

The LLM's job is orchestration, synthesis and tone — **not** knowledge. Numbers
come only from the data tools; "why / what to do" reasoning comes only from
Mithra, with citations. Same philosophy as the report pipeline
(`call_mithra_kb_chat` → the consultative-summary LLM), generalised to an
interactive, multi-turn, two-surface setting.

> Status: **implemented**. Backend under `app/backend/ciq/chat/`
> (`rbac.py`, `tools.py`, `prompts.py`, `guardrails.py`, `orchestrator.py`,
> `routes.py`), chat tables in `db_init.py` + CRUD in `db.py`, routes in
> `ciq/server.py`. Frontend: shared `useChatStream` hook +
> `manager-chat.tsx` / `guest-chat.tsx` / `guest-score-trend.tsx`. Uses the
> **consultative-summary gpt-4o path** (`AZURE_OPENAI_*`) and `MITHRA_APP_TOKEN`.

## Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | **Hybrid** — operational data **and** research evidence |
| 2 | LLM engine | **Reuse** the consultative-summary Azure OpenAI `gpt-4o` path (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_CHAT_DEPLOYMENT` + the realtime credential) |
| 3 | RAG usage | **Retriever + orchestrator synthesis** — Mithra supplies evidence + citations; our orchestrator fuses it with the data |
| 4 | Query power | **On-demand, via a fixed set of PII-safe parametrized tools** (no free-form SQL) |
| 5 | Transport | **SSE streaming** over `POST /manager/chat` and `POST /me/chat` |
| 6 | Persistence | **Store chats in SQLite** (`chat_sessions`, `chat_messages`), separated by `scope` |
| 7 | Surfaces | **Two** — manager (org) and personal (guest), sharing one RBAC-gated engine |
| 8 | Authorization | **RBAC on every tool call**, checked against the trusted server-side context — org data is prompt-injection-proof from the guest surface |

## Component view

See `docs/diagrams/manager-chat-component.puml` for the rendered diagram. In
brief:

```
Manager ─▶ manager-chat.tsx ─▶ auth_middleware (/manager/* role gate)
                                     │
                                     ▼
                         POST /manager/chat  (SSE handler)
                                     │
                        ┌────────────┴────────────┐
                        ▼                          ▼
                 Input guard              Chat Orchestrator ──▶ Azure OpenAI gpt-4o
              (scope + red-flags)          (tool loop +          (REPORT_OPENAI_*)
                                            synthesis)
                                                │  tool calls
                        ┌───────────────────────┼───────────────────────┐
                        ▼                       ▼                        ▼
                 get_org_overview      get_department_breakdown    search_research
                 get_score_trend               │                        │
                        │                       │                        ▼
                        ▼                       ▼               Mithra KB RAG (citations)
                 ───────── SQLite (aggregates only) ─────────
                                     │
                                     ▼
                       Output guard (citation + provenance + safety)
                                     │
                        SSE: tokens · citations · done   ──▶  widget
                                     │
                        persist user + assistant message ──▶ SQLite (chat_*)
```

**Key invariant:** every grounding tool returns **aggregates only**. No
`user_id`, `name`, transcript, biometric sample or individual `survey_records`
row can leave the DB layer. The de-identification guarantee is *structural* (the
tools physically cannot return PII), not merely a prompt instruction.

## The grounding tools (fixed, PII-safe)

Two toolkits (`ciq/chat/tools.py`), each a thin wrapper over existing code. The
model chooses which to call within its surface; it cannot compose arbitrary
queries.

**Manager (org) toolkit** — `MANAGER_TOOL_SCHEMAS`, aggregates only:

| Tool | Wraps | Returns |
|---|---|---|
| `get_org_overview` | `get_manager_overview()` + `get_filter_options()` | Totals, participation, risk distribution, per-department aggregates, valid filter values |
| `get_department_breakdown` | `get_manager_analytics()` | Grouped counts, risk mix, at-risk % per group |
| `get_score_trend` | `get_manager_score_trend()` | Monthly average burnout score series |
| `search_research` | `call_mithra_kb_chat()` | Evidence snippets + `citations[]` |

**Personal (guest) toolkit** — `GUEST_TOOL_SCHEMAS`, the caller's own data only
(bound to `auth.user_id`, never a model-supplied id):

| Tool | Wraps | Returns |
|---|---|---|
| `get_my_assessments` | `get_user_survey_records(user_id)` | Their scores, risk, dates, domains (most recent first) |
| `get_my_score_trend` | same | Their score over time — one point per assessment |
| `get_my_latest_report` | same | Their latest score/risk/interpretation + behavioural analysis / consultative summary text |
| `search_research` | `call_mithra_kb_chat()` | Evidence snippets + `citations[]` |

Design notes:
- **Enumerated parameters only.** Manager filter values are validated against the
  real distinct values before hitting the DB, so the model can't smuggle a
  `department` that is actually a name or free text.
- **Personal tools are user-scoped structurally** — they read `auth.user_id`
  and ignore any `user_id` in the model's arguments, so "fetch *user X's* data"
  is impossible.
- **`search_research` is a retriever.** We take its snippets + citations and let
  the orchestrator synthesise; Mithra's raw prose is not surfaced verbatim.
- Adding a tool = adding one PII-safe wrapper + a `TOOL_ACCESS` entry (below).
  There is deliberately no "run this SQL" escape hatch.

## RBAC on the assistant tools (injection-proof)

Every tool call passes through `dispatch_tool(name, args, auth)`, which enforces
`rbac.TOOL_ACCESS` **before touching data**, using a `ChatAuth(user_id, role,
scope)` derived from the auth session — never anything the prompt controls.

| Tool group | Allowed `scope` | Allowed `role` |
|---|---|---|
| org tools (`get_org_overview`, `get_department_breakdown`, `get_score_trend`) | `manager` | manager, admin |
| personal tools (`get_my_*`) | `personal` | employee, manager, admin |
| `search_research` | both | all |

> The assessed-staff role is **`employee`** (renamed from the former `guest`).
> Component/file names like `guest-chat.tsx` are kept for continuity.

Four independent layers, any one of which blocks org-data leakage from the guest
surface:
1. **Route auth** — `/manager/*` is role-gated (guest → 403); `/me/*` is any
   authenticated user.
2. **Toolkit isolation** — the guest orchestrator only *advertises* personal tool
   schemas; the model never sees org tools.
3. **RBAC dispatch gate** — even if an org tool name were emitted (injection,
   future refactor), execution is refused based on the trusted `scope`/`role`,
   and the attempt is logged (`[Chat] RBAC denied … possible prompt injection`).
4. **User-id binding** — personal tools use `auth.user_id` only.

A denied call returns `{"error": "not authorized …"}` as the tool result, which
the model must explain around — it never gets the data.

## Orchestration loop

A standard tool-calling loop against Azure OpenAI chat completions, split into a
**tool-resolution phase (non-streamed)** and a **final answer phase
(streamed)** so SSE stays simple:

1. **Assemble context** — system prompt (persona + guardrails) + prior turns
   loaded from `chat_messages` + the new user message + the manager's currently
   applied dashboard filters (so "which shift is worst *here*?" is answerable).
2. **Resolve tools** — call `chat/completions` with the tool schemas and
   `stream=false`. If the model returns `tool_call`s, dispatch them, append the
   results, and loop. Bounded by `MAX_TOOL_ITERS` (e.g. 3) to cap latency/cost.
3. **Stream the answer** — once the model stops requesting tools, issue a final
   `stream=true` completion and forward token deltas to the client as SSE.
4. **Guard + persist** — run the output guard, emit citations, and write both
   the user and assistant messages to the DB.

Streaming *through* tool-call deltas is avoided on purpose — accumulating
partial tool-call JSON over SSE is error-prone. "Resolve, then stream" is the
robust MVP.

See `docs/diagrams/manager-chat-sequence.puml` for the full turn.

## Guardrails (hybrid: deterministic + LLM)

Layered, mirroring and extending the app's existing posture (de-identified only;
"a wellness tool — it does not diagnose, treat or prescribe"; biometric
descriptive-only).

**Pre-request (deterministic):**
- **Authz** — route gate in `auth_middleware` + **RBAC per tool** (see above).
- **Scope-aware red-flag input filter** (`check_input(message, scope)`):
  - *manager* scope refuses **individual-level** requests ("show me *<person>*'s
    report", transcripts, biometrics, identities).
  - *personal* scope refuses **other-people / org-wide** requests ("the team's
    average", "compare me to colleagues"), redirecting to the manager dashboard.

**During (structural):**
- Manager tools return aggregates only; personal tools return only the caller's
  own data. Either way, out-of-scope data never enters the model's context.
- Enumerated tool parameters validated against real filter values; personal
  tools bound to `auth.user_id`.

**Post-response (deterministic + LLM):**
- **Citation enforcement** — if the answer makes an evidence/claim statement,
  it must carry Mithra citations; unsourced research claims are softened or
  flagged. If `search_research` returned nothing, the assistant says "no
  supporting evidence in the knowledge base" rather than inventing.
- **Number provenance** — figures in the answer should trace to a tool result;
  the system prompt forbids fabricating statistics.
- **Safety / scope** — system-prompt constraints keep it to org-wellbeing;
  no diagnosis/treatment/prescription; an optional lightweight LLM judge or
  moderation pass can gate the final text.
- **Disclaimer footer** — appended to answers that stray toward advice.

"Hybrid" = deterministic rules (authz, PII scoping, red-flag regex, citation
checks) **+** LLM-side guardrails (scoped system prompt, optional judge).

## Transport protocol (SSE)

`POST /manager/chat` returns `Content-Type: text/event-stream`. Because the
`EventSource` browser API is GET-only, the frontend consumes the stream via
`fetch()` + a `ReadableStream` reader.

**Request body**
```json
{ "chatId": "…optional; omit to start a new chat…",
  "message": "Which department needs attention and why?",
  "filters": { "department": "", "shift": "Night", "months": "12" } }
```

**Event stream**
| `event:` | `data:` payload | Meaning |
|---|---|---|
| `tool` | `{ "name": "get_score_trend", "status": "done" }` | Progress ping (optional, for a "thinking…" UI) |
| `token` | `{ "delta": "Surgery is…" }` | A chunk of the answer |
| `citations` | `{ "citations": [ { "paperTitle": "...", "paperPage": 4 } ] }` | Sources for the answer |
| `done` | `{ "chatId": "…", "messageId": "…" }` | Turn complete; client persists ids |
| `error` | `{ "message": "…" }` | Fatal error; stream ends |

The **personal surface is identical** with `POST /me/chat` — same request body
(minus `filters`) and same event stream.

**Companion REST endpoints** (JSON), one set per surface:
- Manager (`/manager/` gate): `GET /manager/chats`, `GET /manager/chats/{id}`,
  `DELETE /manager/chats/{id}`.
- Personal (any authenticated user): `GET /me/chats`, `GET /me/chats/{id}`,
  `DELETE /me/chats/{id}`.

Each list/get/delete verifies **ownership *and* scope**, so a manager chat can't
be read through `/me/*` and vice-versa. These are distinct from `/kb/chats/*`
(raw Mithra proxies for the admin KB UI).

## Persistence (SQLite)

Two new tables, following the existing `db_init.py` conventions (TEXT ids, ISO
timestamps, `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE` migrations,
WAL). They are covered by Litestream replication automatically — no infra
change (see `persistence.md`).

```sql
CREATE TABLE IF NOT EXISTS chat_sessions (
    chat_id     TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    title       TEXT,                     -- derived from first question
    scope       TEXT NOT NULL DEFAULT 'manager',  -- 'manager' | 'personal'
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    message_id  TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chat_sessions(chat_id),
    role        TEXT NOT NULL,            -- 'user' | 'assistant'
    content     TEXT NOT NULL,
    citations   TEXT,                     -- JSON array, assistant turns
    tool_trace  TEXT,                     -- JSON, optional (audit/debug)
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
    ON chat_messages(chat_id, created_at);
```

`tool_trace` stores which tools ran with which arguments — useful for auditing
"where did this come from?". It is never sent to the client. `scope` separates a
user's two chat lists (`/manager/chats` vs `/me/chats`); the additive migration
defaults existing rows to `'manager'`.

## Configuration

Reuses existing env — **no new credentials required**. The orchestrator uses the
exact same gpt-4o path as the post-assessment **consultative summary**
(`AzureChatClient`): the realtime resource endpoint + the `gpt-4o` chat
deployment + the live realtime credential (borrowed from the running
`RTMiddleTier`, so it works with either api-key or Entra-token auth). It does
**not** use `REPORT_OPENAI_*` (whose endpoint is unset in this deployment).

| Var | Reused from | Purpose |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | realtime / report path | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | report path | chat deployment (default `gpt-4o`) |
| `AZURE_OPENAI_API_KEY` *or* `AZURE_TENANT_ID` | realtime credential | api-key, else Entra bearer token |
| `MITHRA_APP_TOKEN` | KB | auth for `search_research` |
| `MITHRA_API_BASE_URL` | KB | Mithra base URL |

Proposed new (optional) flags:

| Var | Default | Purpose |
|---|---|---|
| `MANAGER_CHAT_MAX_TOOL_ITERS` | `3` | Cap on tool-resolution rounds per turn (both surfaces) |

## Implementation touch points

| Area | File(s) | Change |
|---|---|---|
| Chat store | `db.py`, `db_init.py` | `chat_sessions` (+`scope`) / `chat_messages` tables + scope-aware CRUD |
| RBAC | `ciq/chat/rbac.py` | `ChatAuth` + `TOOL_ACCESS` capability map + `is_authorized` |
| Tools | `ciq/chat/tools.py` | Manager + guest toolkits, RBAC-gated `dispatch_tool(name, args, auth)` |
| Prompts | `ciq/chat/prompts.py` | `MANAGER_SYSTEM_PROMPT`, `GUEST_SYSTEM_PROMPT` |
| Orchestrator | `ciq/chat/orchestrator.py` | Generic tool loop + streaming (takes `auth`, prompt, schemas) |
| Guardrails | `ciq/chat/guardrails.py` | Scope-aware red-flags + footer |
| Routes | `ciq/chat/routes.py`, `ciq/server.py` | Shared SSE handler; `/manager/chat*` + `/me/chat*` |
| Frontend (shared) | `hooks/useChatStream.ts` | Headless SSE/typewriter/rehydrate/new-chat controller |
| Frontend (manager) | `manager-chat.tsx` | Manager skin (`ml` theme) |
| Frontend (guest) | `guest-chat.tsx` + `guest-chat.css`, `guest-score-trend.tsx`, `guest-landing.tsx` | Guest skin (`gl` theme), per-assessment chart, "Your journey" section (returning guests only) |

## Phasing

- **Phase 1 (MVP)** — ✅ **done**. `POST /manager/chat` (SSE), the four tools,
  bounded tool loop, system-prompt + red-flag guardrails, DB persistence, live
  SSE widget. Reuses the consultative-summary gpt-4o path (no new creds).
- **Phase 2** — _partially done_.
  - ✅ Citation chips under answers (`ml-chat-cite`).
  - ✅ "Thinking…" tool-progress indicator (per-tool status line via SSE `tool` events).
  - ✅ Persistence rehydration: the widget reloads the latest chat on mount
    (`GET /manager/chats` → `GET /manager/chats/{id}`), so conversations survive
    logout/login, refresh and tab navigation.
  - ✅ **New chat** control — resets the widget and starts a fresh server-side
    chat on the next message (previous chat stays persisted).
  - ⬜ Filter-context awareness — the orchestrator already accepts a `filters`
    arg; the manager widget still sends `{}` (not yet wired to the live filters).
  - ⬜ Full chat-list / history sidebar (switch between past chats, delete).
- **Guest surface** — ✅ **done**. Personal (guest) toolkit bound to `user_id`,
  `GUEST_SYSTEM_PROMPT`, scope-aware guardrails, `/me/chat*` routes, `scope`
  column, RBAC gate, `guest-chat.tsx` + `guest-score-trend.tsx` on the
  returning-guest landing (shown only when `records.length > 0`).
- **RBAC** — ✅ **done**. Every tool call gated by `TOOL_ACCESS` against the
  trusted `ChatAuth`; org data is prompt-injection-proof from the guest surface.
- **Phase 3** — ⬜ output guardrail judge, feedback (thumbs), rate limiting,
  answer/result caching for Mithra to cut latency.

## Non-goals / explicit exclusions

- No free-form SQL or arbitrary data access — only the fixed, RBAC-gated tools.
- No cross-boundary data: managers never see individual-level data; guests never
  see anyone else's data or org aggregates. Enforced structurally + by RBAC.
- No diagnosis, treatment or prescription — consistent with the app-wide
  wellness-tool disclaimer.
- Not a replacement for the voice agent or the report pipeline — a separate,
  text-only chat surface.
