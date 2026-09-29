# `/debug` Command (`.claude/commands/debug.md`)

Use this command to systematically diagnose and resolve runtime errors, failed tests, or unexpected application behavior without broad repo scans.

## Usage
`/debug <error message, stack trace snippet, or description of failure>`

*Examples:*
- `/debug KeyError: 'auth_session' when hitting /admin/users`
- `/debug test_effective_score failing on bat-full item 4`
- `/debug JSONDecodeError in report_consultative_summary`

## Execution Instructions for Claude
1. **Adopt Debugger Persona**: Act strictly according to `.claude/agents/debugger.md`.
2. **Isolate Error**:
   - Extract the failing file, line number, and exception type.
   - Do NOT scan the whole repository. Inspect only the failing function slice.
3. **Trace Execution Path**:
   - Trace backwards through immediate caller functions using line slices.
4. **Identify Root Cause**:
   - Formulate a hypothesis matching CIQ failure patterns (unparsed markdown fences, SQLite lock/missing column, unauthenticated context, reverse score logic).
5. **Implement & Prove Fix**:
   - Apply the minimal fix.
   - Run the targeted pytest or vitest command to prove the issue is resolved.
