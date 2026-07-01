# Manager "Wellbeing Assistant" chat — architecture

A conversational assistant embedded in the manager dashboard
(`manager-chat.tsx`, the widget beside the Monthly Burnout Score chart). A
manager can ask questions about the organisation's burnout picture and get
answers that are **grounded in two authoritative sources and invent nothing**:

- **Operational SSoT** — the live, de-identified SQLite aggregates that already
  power the dashboard cards.
- **Evidential SSoT** — the **Mithra Knowledge Base** RAG over the
  organisation's uploaded burnout research, returned with citations.

The LLM's job is orchestration, synthesis and tone — **not** knowledge. Numbers
come only from the operational tools; "why / what to do" reasoning comes only
from Mithra, with citations. This is the same grounding philosophy already used
by the report pipeline (`call_mithra_kb_chat` → `call_report_llm`), generalised
to an interactive, multi-turn setting.

> Status: **implemented (Phase 1)**. Backend under `app/backend/ciq/chat/`
> (`tools.py`, `guardrails.py`, `orchestrator.py`, `routes.py`), chat tables in
> `db_init.py` + CRUD in `db.py`, routes registered in `ciq/server.py`; the
> `manager-chat.tsx` widget is a live SSE client. Needs `REPORT_OPENAI_*`
> (LLM) and `MITHRA_APP_TOKEN` (research tool) configured at runtime.

## Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | **Hybrid** — operational data **and** research evidence |
| 2 | LLM engine | **Reuse** the existing Azure OpenAI `gpt-4o` deployment (`REPORT_OPENAI_*`) |
| 3 | RAG usage | **Retriever + orchestrator synthesis** — Mithra supplies evidence + citations; our orchestrator fuses it with org numbers |
| 4 | Query power | **On-demand, via a fixed set of PII-safe parametrized tools** (no free-form SQL) |
| 5 | Transport | **SSE streaming** over `POST /manager/chat` |
| 6 | Persistence | **Store chats in SQLite** (`chat_sessions`, `chat_messages`) |

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

Four tools, each a thin wrapper over code that already exists in `db.py` /
`mithra_client.py`. The model chooses which to call; it cannot compose
arbitrary queries.

| Tool | Wraps | Parameters | Returns (all aggregate) |
|---|---|---|---|
| `get_org_overview` | `get_manager_overview()` | — | Totals, participation, risk distribution, per-department aggregates, valid filter values |
| `get_department_breakdown` | `get_manager_analytics()` | `groupBy` (department\|shift\|jobTitle), `department?`, `shift?`, `jobTitle?`, `risk?`, `from?`, `to?` | Grouped counts, risk mix, at-risk % per group |
| `get_score_trend` | `get_manager_score_trend()` | `department?`, `shift?`, `jobTitle?`, `months` (6\|12\|24\|all) | Monthly average burnout score series |
| `search_research` | `call_mithra_kb_chat()` | `query` | Evidence snippets + `citations[]` (paper title, page) |

Design notes:
- **Enumerated parameters only.** Filter values are validated against the
  distinct values returned by `get_org_overview` before hitting the DB, so the
  model can't smuggle a `department` that is actually a name or free text.
- **`search_research` is a retriever here.** Mithra *can* answer on its own, but
  in this design we take its snippets + citations and let the orchestrator
  synthesise a single answer that blends evidence with the org's own numbers
  (decision #3). Mithra's raw prose is not surfaced verbatim.
- Adding a tool = adding one PII-safe wrapper. There is deliberately no
  "run this SQL" escape hatch.

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
- **Authz** — `/manager/*` role gate in `auth_middleware`; guests get 403.
- **Red-flag input filter** — regex/rules that refuse individual-level requests
  ("show me *<person>*'s report/score", requests for transcripts, biometrics,
  or identities) before any LLM call.

**During (structural):**
- Tools return aggregates only — the strongest guardrail, because PII never
  enters the model's context in the first place.
- Enumerated tool parameters validated against real filter values.

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

**Companion REST endpoints** (JSON, under the same `/manager/` gate):
- `GET /manager/chats` — list the manager's chats (id, title, updated_at).
- `GET /manager/chats/{chatId}` — full message history for re-hydration.
- `DELETE /manager/chats/{chatId}` — delete a chat (optional).

These are distinct from the existing `/kb/chats/*` routes, which are raw Mithra
proxies for the admin KB UI. The manager assistant does **not** reuse them —
it needs the org-data grounding and guardrail layer around Mithra.

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

`tool_trace` stores which tools ran with which arguments and a digest of the
result — useful for auditing "where did this number come from?" without keeping
full payloads. It is never sent to the client.

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
| `ENABLE_MANAGER_CHAT` | `true` | Feature flag for the endpoint + widget |
| `MANAGER_CHAT_MAX_TOOL_ITERS` | `3` | Cap on tool-resolution rounds per turn |

## Implementation touch points

| Area | File(s) | Change |
|---|---|---|
| Chat store | `db.py`, `db_init.py` | `chat_sessions` / `chat_messages` tables + CRUD helpers |
| Tools | `ciq/chat/tools.py` (new) | PII-safe wrappers over the aggregate + Mithra functions |
| Orchestrator | `ciq/chat/orchestrator.py` (new) | Tool loop + streaming + prompts |
| Guardrails | `ciq/chat/guardrails.py` (new) | Input red-flags, output citation/provenance/safety |
| Routes | `ciq/chat/routes.py` (new), `ciq/server.py` | `POST /manager/chat` (SSE) + chat REST, registration |
| Frontend | `manager-chat.tsx`, `manager-landing.css` | SSE client, markdown answers, citation chips, tool-status line, latest-chat rehydration, New-chat button |

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
    arg; the widget still sends `{}` (not yet wired to the live dashboard filters).
  - ⬜ Full chat-list / history sidebar (switch between past chats, delete).
- **Phase 3** — ⬜ output guardrail judge, feedback (thumbs), rate limiting,
  answer/result caching for Mithra to cut latency.

## Non-goals / explicit exclusions

- No free-form SQL or arbitrary data access — only the fixed tools.
- No individual-level data, ever — no per-person scores, transcripts,
  biometrics, or identities.
- No diagnosis, treatment or prescription — consistent with the app-wide
  wellness-tool disclaimer.
- Not a replacement for the voice agent or the report pipeline — a separate,
  text-only, manager-facing surface.
