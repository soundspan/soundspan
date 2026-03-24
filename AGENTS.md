# AGENTS.md

Repository contract for soundspan.

## Source Of Truth

- Follow this file first.
- Canonical ACM rules, tags, verification definitions, and workflow gates live in `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, and `.acm/acm-workflows.yaml`.
- `CLAUDE.md` and `.claude/acm-broker/**` are tool-specific companions. If they disagree with this file, this file wins.
- ACM work storage is the source of truth for active and historical plan state. Use `acm work list/search --scope all` when you need archived or completed history.

## Task Loop

For non-trivial work (multi-step, multi-file, or governed changes), follow this loop. Trivial single-file fixes can skip the ACM ceremony.

1. Read this file and the human task.
2. Run `acm context --task-text "<current task>" --phase <plan|execute|review>`.
3. Read the returned hard rules and fetch only the keys needed for the current step.
4. If the task spans multiple steps, multiple files, or likely handoff, create or update ACM work with `acm work ...`.
5. For code, config, schema, or behavior changes, run `acm verify ...` before completion.
6. If `.acm/acm-workflows.yaml` requires a review task such as `review:cross-llm`, satisfy it with `acm review --run --receipt-id <receipt-id>` when the task defines a `run` block; otherwise use manual review fields or `acm work`.
7. Close the task with `acm done ...`. Changed files must stay within the active receipt scope.

See [.acm/acm-work-loop.md](.acm/acm-work-loop.md) for the full ACM command reference (CLI and MCP).

## Working Rules

- **Read before edit.** Read the full relevant source before making changes. Do not guess at file contents or structure.
- **Smallest safe change.** Make the minimum change that solves the problem. Preserve existing style and conventions. Do not refactor adjacent code, add unsolicited features, or "improve" what wasn't asked for.
- **TDD for executable changes.** For code, schema, or behavior changes, write or update a failing test first, then implement until it passes. Deviations require explicit user approval. Non-executable work (docs, config review, planning, workflow governance) is exempt.
- **No silent scope expansion.** Refresh context first if the task spills into adjacent systems. Use `work.plan.discovered_paths` when later-discovered files must be declared for review or done.
- **No invented requirements.** Do not invent product requirements, compatibility guarantees, or migration behavior when the repo does not define them. Surface the decision and wait for direction.
- **Targeted testing only.** Do not run the full test suite — it maxes out available RAM. Run only the test files and suites relevant to the current changes.
- **Keep work state current.** Update work when you pause, hand off, or hit a blocker.
- **Prefer small, reviewable changes** over broad cleanup.

## Repository-Specific Rules

- **API boundary:** Use `frontend/lib/api.ts` as the frontend API boundary. No direct `fetch` calls from components.
- **Backend config:** Read env through `backend/src/config.ts`.
- **Database access:** All DB access through Prisma. No raw SQL.
- **Logging helpers:** Use shared logging helpers in runtime code:
  - frontend: `frontend/lib/logger.ts`
  - backend: `backend/src/utils/logger.ts`
  - python sidecars: `services/common/logging_utils.py`
- **Changelog:** Keep `CHANGELOG.md` updated for user-visible or behavior-changing work.
- **Documentation coverage:** Exported TypeScript symbols, runtime Python modules, and implemented OpenAPI routes should remain fully documented when touched.
- **Cross-LLM review:** For non-trivial implementation work, satisfy the repo review gate before final completion:
  - `acm review --run --project soundspan --receipt-id <receipt-id>`
  - reviewer provider, model, reasoning, and shared `--yolo` settings live in `.acm/acm-workflows.yaml`
- **Storage:** SQLite at `.acm/context.db` by default. Configure `ACM_PG_DSN` for multi-agent coordination.

## Verification Evidence Protocol

- Run the verification command. Read the COMPLETE output. Do not assume success.
- Prefix all evidence claims with `verify:` (e.g., "verify: backend-build exit 0, 0 errors").
- Never use: "should work", "probably fine", "looks correct", "appears to pass".
- Evidence is stale after any subsequent code change. Re-verify after edits.
- If verification fails, fix the issue OR report the failure honestly. Never claim success.

## Debugging Protocol

1. **Investigate**: Read full error output. Reproduce the issue. Trace data flow.
2. **Analyze**: Compare to working code. Identify what changed.
3. **Hypothesize**: Form ONE specific root-cause hypothesis.
4. **Implement**: Apply targeted fix. Verify root cause resolved, not symptoms masked.
5. **Escalate**: If 3 consecutive fix attempts fail, stop. Document what was tried and why each failed. Ask the user before continuing.

## Definition of Done

Before reporting completion, confirm ALL:

- Requested change implemented; behavior explained (what, where, why).
- `acm verify` passed for code/config/schema changes (paste evidence with `verify:` prefix).
- Tests added or updated for behavioral changes.
- Required workflow gates from `.acm/acm-workflows.yaml` satisfied before completion reporting.
- `CHANGELOG.md` updated for behavior-visible changes.
- No scope expansion beyond original request.
- Documentation updated for new/changed exports, routes, or schemas.

## When To Use `work`

Use `acm work` when any of the following are true:

- the task has more than one material step
- more than one file or subsystem is involved
- planning, verification, or handoff matters
- durable task state should survive compaction or session reset

For executable changes, include a `verify:tests` task.

For single review-gate updates, `acm review` is the thinner wrapper around `acm work`; use `acm review --run` for runnable workflow gates and reserve manual `status` / `outcome` / `evidence` fields for non-run mode.

## Feature Plans

- For net-new feature work, create a root ACM plan with `kind=feature` before implementation.
- Root feature plans must include `objective`, `in_scope`, `out_of_scope`, `constraints`, `references`, and stage statuses for `spec_outline`, `refined_spec`, and `implementation_plan`.
- Root feature plans must include top-level `stage:spec-outline`, `stage:refined-spec`, and `stage:implementation-plan` tasks. Put concrete child tasks beneath them with `parent_task_key`.
- If a feature splits into multiple execution streams, create child plans with `kind=feature_stream` and `parent_plan_key=<root plan key>`.
- Feature and feature-stream plans must carry `verify:tests`, and implementation leaf tasks must carry explicit `acceptance_criteria`.
- `acm verify` selects `acm-feature-plan-validate` for feature-relevant work and runs `scripts/acm-feature-plan-validate.py` with the active receipt/plan context.
- See `docs/ACM_FEATURE_PLANS.md` for examples and command shapes.

## Worktrees

- Default SQLite is repo-local, so each worktree gets its own `.acm/context.db`. This is the recommended setup when multiple worktrees may diverge at the same time.
- Treat a new worktree like a fresh ACM runtime surface: run `acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .` before relying on retrieval there, and run `acm health --project soundspan --include-details` if the worktree was created from older repo state.
- If you run ACM commands from outside the worktree root, set `ACM_PROJECT_ROOT` to the active worktree path.
- If you move ACM to shared Postgres for multi-agent coordination, do not point multiple divergent worktrees at the same shared ACM project state. Use distinct project ids or isolated backends per worktree, otherwise retrieval and sync become last-sync-wins across trees.
