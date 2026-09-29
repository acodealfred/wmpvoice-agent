# `/test` Command (`.claude/commands/test.md`)

Use this command to execute targeted or comprehensive tests for backend (pytest) or frontend (vitest) with minimal context window noise.

## Usage
`/test [backend | frontend | all | <file-or-function-pattern>]`

*Examples:*
- `/test backend` (runs `cd app/backend && pytest -q`)
- `/test frontend` (runs `cd app/frontend && npm test`)
- `/test test_survey_loader.py` (runs specific backend unit suite)
- `/test -k test_effective_score` (runs specific test pattern)
- `/test src/lib/bands.test.ts` (runs specific vitest file)

## Execution Instructions for Claude
1. **Adopt Tester Persona**: Act strictly according to `.claude/agents/tester.md`.
2. **Determine Target Suite**:
   - Inspect query to decide whether Python pytest or frontend vitest is required.
3. **Execute Quietly**:
   - Run tests with `-q` or focused flags to prevent massive terminal output from consuming the context window.
4. **Report Results**:
   - Total passed/failed counts.
   - For any failure: extract the exact failing assertion, expected vs actual values, and root cause diagnosis.
