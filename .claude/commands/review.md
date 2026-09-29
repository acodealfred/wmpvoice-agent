# `/review` Command (`.claude/commands/review.md`)

Use this command to conduct a thorough pull-request-grade code review on your active working changes or a specific commit.

## Usage
`/review [optional git diff or commit ref]`

*Examples:*
- `/review` (reviews current unstaged/staged working changes)
- `/review HEAD~1` (reviews the last commit)

## Execution Instructions for Claude
1. **Adopt Reviewer Persona**: Act strictly according to `.claude/agents/reviewer.md`.
2. **Examine Git Diff**:
   - Run `git status` and `git diff` to view exact changes.
   - Do NOT reload unaffected files into context.
3. **Verify Against Review Gates**:
   - **Architectural Compliance**: Shims preserved, modularity intact.
   - **Security & RBAC**: Admin/Manager/Employee role boundaries respected.
   - **Database & Litestream**: Parameterized queries, idempotent migrations, single-replica safe.
   - **Cleanliness**: No stray `print()`, `console.log()`, or secrets.
   - **Tests & Linters**: Ruff and targeted test results verified.
4. **Deliver Structured Verdict**:
   - Status: `APPROVED` or `REVISIONS REQUIRED`
   - Detailed findings with file and line numbers
   - Actionable instructions for any fixes needed
