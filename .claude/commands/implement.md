# `/implement` Command (`.claude/commands/implement.md`)

Use this command to execute an approved plan or perform a tightly scoped implementation task following CIQ architectural conventions.

## Usage
`/implement <approved plan reference or task description>`

*Examples:*
- `/implement execute the approved recovery window export endpoint plan`
- `/implement fix typo in the survey completion toast message`

## Execution Instructions for Claude
1. **Adopt Implementer Persona**: Act strictly according to `.claude/agents/implementer.md`.
2. **Follow Approved Scope**: Touch only files designated in the approved plan.
3. **Execute Incrementally**:
   - Inspect specific line ranges before editing.
   - Never add business logic to shims (`app/backend/app.py`, `app/backend/rtmt.py`).
   - Use `parse_llm_json` from `ciq.common.json_utils` for LLM outputs.
   - Parameterize all SQL queries (`?`).
4. **Immediate Validation**:
   - For backend files: run `ruff check app/backend`
   - For frontend files: run `cd app/frontend && npm run build`
5. **Next Step**: Prompt the user to run `/test` or `/review`.
