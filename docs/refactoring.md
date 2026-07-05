# Backend Refactoring — `app.py` / `rtmt.py` → the `ciq` package

## Why

The backend already followed a "one module per concern" convention (`auth.py`,
`db.py`, `survey_loader.py`, `biometric_interpreter.py`). Two files never received
that treatment and had grown into god-files:

| File | Before | Responsibilities bundled together |
|---|---|---|
| `app/backend/rtmt.py` | ~1,663 lines | WS relay proxy · session state · prompt assembly · tool schemas + dispatch · a separate chat-completions LLM path · biometric history |
| `app/backend/app.py` | ~1,600 lines | app bootstrap · report prompt-builders · report endpoints · Mithra KB HTTP client · admin/KB endpoints · auth wiring · AWS Rekognition · biometric/stress REST · baseline/history |

The low cohesion was already producing concrete defects:

1. **`update_stress_state` was defined twice** in `app.py`; the second silently
   shadowed the first, and only the second was actually routed.
2. **`_blink_band` / `_pupil_band` were duplicated** — `rtmt.py` imported them from
   `survey_loader` (the declared "single source of truth") while `app.py` kept its
   own private copies.
3. **`RTMiddleTier` mixed transport with prompt engineering, session storage and a
   second LLM client**, so almost nothing in it could be unit-tested without a WebSocket.

The refactor finishes the existing module-per-concern pattern. **Behavior is
preserved** — same routes, same wire protocol, same prompts.

## What changed at a glance

- New `app/backend/ciq/` package holds the decomposed modules.
- `app/backend/app.py` is now a thin shim re-exporting `create_app` (preserves the
  `app:create_app` gunicorn entrypoint and `python app/backend/app.py`).
- `app/backend/rtmt.py` is now a thin shim re-exporting `RTMiddleTier` (and helper
  types) so `ragtools.py` and any `from rtmt import ...` keep working.
- The already-cohesive legacy modules (`auth.py`, `db.py`, `db_init.py`,
  `survey_loader.py`, `biometric_interpreter.py`, `ragtools.py`) were **left in place**
  and are imported by the package. (See "Deliberate deviations" below.)

## New structure

```
app/backend/
├── app.py                    # shim → ciq.server.create_app  (entrypoint preserved)
├── rtmt.py                   # shim → ciq.realtime.middle_tier.RTMiddleTier
├── auth.py, db.py, db_init.py, survey_loader.py,
│   biometric_interpreter.py, ragtools.py        # unchanged legacy modules
└── ciq/
    ├── server.py             # create_app(): composition root + route table
    ├── bootstrap.py          # build & wire RTMiddleTier from env (persona/survey/guardrail)
    ├── config.py             # APP_VERSION, survey types, env_flag()
    ├── survey.py             # get_question_domain() shared helper
    ├── common/
    │   └── json_utils.py     # parse_llm_json, strip_llm_error, safe_json   (pure)
    ├── prompts/
    │   ├── personas.py       # SURVEY/BASIC system messages + META_INTENT
    │   └── builder.py        # the 6 instruction builders + assembly        (pure)
    ├── realtime/
    │   ├── middle_tier.py    # RTMiddleTier transport: WS relay + tool dispatch
    │   ├── session.py        # SessionState (owns its mutations) + SessionStore + ctxvar
    │   ├── routes.py         # control-plane REST (stress/conversation/biometrics/session/...)
    │   └── tools/
    │       ├── base.py       # Tool, ToolResult, ToolResultDirection, RTToolCall
    │       ├── schemas.py    # the 3 function-call JSON schemas
    │       └── handlers.py   # survey / sentiment / query_survey tool implementations
    ├── llm/
    │   └── azure_chat.py     # AzureChatClient (report-generation chat-completions path)
    ├── reports/
    │   ├── prompts.py        # build_*_prompt / build_report_context        (pure)
    │   └── routes.py         # /analyze-report, /report/*, /ssot-report
    ├── kb/
    │   ├── mithra_client.py  # Mithra KB + report-LLM HTTP client
    │   ├── storage.py        # kb_documents.json persistence
    │   └── routes.py         # /admin/kb/*, /kb/*
    ├── biometrics/
    │   ├── rekognition.py    # AWS Rekognition face detection
    │   └── routes.py         # /analyze (face emotion)
    └── api/
        ├── meta_routes.py    # /config, /version
        ├── history_routes.py # /api/history, /admin/users
        └── baseline_routes.py# /baseline (GET/POST/DELETE)
```

### Dependency direction

`routes` → `services`/domain → `clients`. Concretely: route modules depend on
`reports.prompts` / `prompts.builder` (pure), `kb.mithra_client` / `llm.azure_chat`
(I/O clients), and `survey_loader`/`db` (legacy). Pure modules depend on nothing
external. `realtime.middle_tier` composes `SessionStore`, the tool registry, the
prompt builder and `AzureChatClient` rather than being all of them.

## Symbol mapping (where things moved)

### From `rtmt.py`
| Original | New home |
|---|---|
| `SessionState`, session getters/setters, eviction, biometric-history methods, `_active_session` | `ciq/realtime/session.py` (methods now live on `SessionState`; `SessionStore` owns lifetime) |
| `_tool_*_schema` | `ciq/realtime/tools/schemas.py` |
| `Tool`, `ToolResult`, `ToolResultDirection`, `RTToolCall` | `ciq/realtime/tools/base.py` |
| `_survey_tool`, `_sentiment_tool`, `_query_survey_tool` | `ciq/realtime/tools/handlers.py` (take `session`/`config` explicitly) |
| `_get_question_domain` | `ciq/survey.py` |
| 6× `_get_*_instructions` + survey script + `session.update` assembly | `ciq/prompts/builder.py` (pure) |
| `analyze_with_prompt` | `ciq/llm/azure_chat.py` (`AzureChatClient`) |
| `_detect_and_handle_report_delivery`, message relay, WS handler | `ciq/realtime/middle_tier.py` |

### From `app.py`
| Original | New home |
|---|---|
| `_blink_band` / `_pupil_band` | **deleted** — now sourced from `survey_loader` |
| `_build_*_prompt`, `_build_report_context` | `ciq/reports/prompts.py` |
| `_parse_llm_json`, `_strip_llm_error`, `_safe_json` | `ciq/common/json_utils.py` |
| report endpoints + `generate_ssot_report` | `ciq/reports/routes.py` |
| `_mithra_*`, `_call_mithra_kb_chat`, `_call_report_llm` | `ciq/kb/mithra_client.py` |
| `_load_kb_docs` / `_save_kb_docs` | `ciq/kb/storage.py` |
| `admin_kb_*`, `kb_*`, debug endpoints | `ciq/kb/routes.py` |
| `analyze_face` | `ciq/biometrics/rekognition.py` + `ciq/biometrics/routes.py` |
| `get_config`, `get_version` | `ciq/api/meta_routes.py` |
| `admin_list_users`, `user_sessions_history` | `ciq/api/history_routes.py` |
| `get_baseline`/`save_baseline`/`clear_baseline` | `ciq/api/baseline_routes.py` |
| stress/conversation/biometrics/session/survey-type/guardrail handlers | `ciq/realtime/routes.py` |
| `create_app` + persona/meta-intent setup | `ciq/server.py` + `ciq/bootstrap.py` + `ciq/prompts/personas.py` |

## Defects fixed as part of the move

- **De-duplicated `update_stress_state`** — only the live (session-based) handler
  survives, in `ciq/realtime/routes.py`.
- **Single-sourced the biometric bands** — `app.py`'s private copies were deleted;
  all callers now use `survey_loader.blink_band` / `pupil_band` (verified
  logically identical to the deleted copies before removal).
- **Collapsed the duplicated `set_*` / `set_*_for_session` setter pairs** onto
  `SessionState` methods.

## Deliberate deviations from the original written plan

These were judgment calls to reduce risk/churn; each is safe and reversible:

1. **Legacy modules kept flat** (not relocated into `ciq/`). They were already
   cohesive; moving them would churn their cross-imports and the Docker copy for no
   cohesion gain. The package imports them top-level (backend root is on `sys.path`).
2. **Bands stay in `survey_loader`** (the existing single source) rather than a new
   `biometrics/bands.py`. The real defect was `app.py`'s duplicate copies; deleting
   those and pointing at `survey_loader` makes "single source of truth" true with the
   least movement.
3. **Report handlers kept in `reports/routes.py`** rather than split into a separate
   `service.py`. The three handlers are thin; a service layer is the natural next step
   only if they grow.
4. **`clear_stress_state` preserved as an unregistered handler.** The original never
   routed it (no `/clear-stress` registration); that behavior is kept exactly.

## Testing

The extraction makes the core logic unit-testable without a WebSocket or network.
There is no `tests/` tree yet; these are the natural first targets (mirror `ciq/`):

- **Pure, no mocks:** `ciq/prompts/builder.py` (assert survey script appears only when
  `state == "active"`, guardrail block only when enabled, reconnect block when
  `connection_count > 1`), `ciq/reports/prompts.py`, `ciq/common/json_utils.py`,
  plus `survey_loader` scoring/bands.
- **Mock the client/session:** `ciq/llm/azure_chat.py`, `ciq/kb/mithra_client.py`,
  `ciq/biometrics/rekognition.py` (inject a fake `aiohttp`/`boto3` session).
- **Direct:** `ciq/realtime/session.py` (`SessionStore` TTL eviction, reconnect
  counter, `reset_for_new_survey`), `ciq/realtime/tools/handlers.py` (reverse-aware
  totals, the duplicate-record guard).

Suggested: add `pytest` + `pytest-asyncio` to `app/backend/requirements.txt`.

## How this refactor was verified (no test suite yet)

- `python -m compileall ciq app.py rtmt.py` — clean.
- Full import-graph resolution: every `ciq.*` module plus `app`, `rtmt`, `ragtools`
  imports successfully (third-party deps stubbed) — confirms no broken intra-project imports.
- Functional sanity: instruction assembly (active vs report-delivered), guardrail
  toggling, and the tool handlers' reverse-aware scoring + duplicate guard all
  produce the expected results.
- Static asset path (`ciq/server.py` → `backend/static`) resolves correctly.

Still recommended before merge: `ruff check app/backend`, `cd app/frontend &&
npm run build`, and a manual smoke run (`python app/backend/app.py`) of one full
survey → report → follow-up Q&A.
