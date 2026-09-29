# `/explore` Command (`.claude/commands/explore.md`)

Use this command to investigate an architectural area, trace a data flow, or locate relevant code without bloating the context window.

## Usage
`/explore <subsystem, feature, or question>`

*Examples:*
- `/explore how survey responses are scored and saved to the database`
- `/explore how the MediaPipe blink rate connects to RTMiddleTier`
- `/explore recovery window track progression routes`

## Execution Instructions for Claude
1. **Adopt Explorer Persona**: Act strictly according to `.claude/agents/explorer.md`.
2. **Context First**: Check `.claude/context/` (`architecture.md`, `services.md`, `database.md`) to resolve high-level facts without searching.
3. **Targeted Search**:
   - Use ripgrep or pattern search to identify exact files.
   - Prohibited from full reads: `app/frontend/src/App.tsx`, `app/backend/db.py`, `ciq/realtime/middle_tier.py`, `components/ui/admin-panel.tsx`.
   - Read only targeted line slices (50-100 lines max).
4. **Synthesize**:
   - Provide a concise summary of relevant files, key symbols, and the execution path.
   - Highlight any CIQ architectural constraints (e.g. single-replica, SQLite WAL, RBAC).
5. **Next Step**: Prompt the user to run `/plan` if implementation work is desired.
