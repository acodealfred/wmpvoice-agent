# `/plan` Command (`.claude/commands/plan.md`)

Use this command to create a phased, low-risk implementation blueprint for a feature, refactoring, or bug fix before changing any code.

## Usage
`/plan <feature, change description, or goal>`

*Examples:*
- `/plan add a new export endpoint for recovery window session reflections`
- `/plan implement custom voice tone adjustment based on pupil dilation`
- `/plan add a unit test for CBI reverse scoring edge cases`

## Execution Instructions for Claude
1. **Adopt Planner Persona**: Act strictly according to `.claude/agents/planner.md`.
2. **Review Architecture & Scope**:
   - Check `.claude/context/architecture.md` and `conventions.md`.
   - Identify affected modules across backend (`ciq/`), frontend (`src/`), and database schema (`db_init.py`).
3. **Formulate Blueprint**:
   - **Architectural Scope**: Modules affected and boundary considerations.
   - **File Impact List**: Exact file paths with functions/classes to modify.
   - **Step-by-Step Implementation Sequence**: Phased ordering (DB migration → Backend route → Frontend hook/UI).
   - **Targeted Test Commands**: Specific pytest/vitest commands to validate each step.
   - **Safety & Rollback Guardrails**: Failure modes and data integrity considerations.
4. **Hold Execution**: Present the plan to the user and wait for approval before running `/implement`.
