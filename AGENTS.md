# AGENTS.md

Repository contract for `soundspan` after ACM onboarding.

## Source Of Truth

- Follow this file first.
- Canonical ACM rules, tags, verification definitions, and workflow-gate definitions live in `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, and `.acm/acm-workflows.yaml`.
- `CLAUDE.md` and `.claude/acm-broker/**` are tool-specific companions only. If they disagree with this file, this file wins.
- ACM work storage is the source of truth for active and historical plan state. Use `acm work list/search --scope all` when you need archived or completed history.

## Required Task Loop

1. Read `AGENTS.md` and the human task.
2. Run `acm get-context --project soundspan --task-text "<current task>" --phase <plan|execute|review>`.
3. Read the returned hard rules and fetch only the keys needed for the current step.
4. If the task spans multiple steps, multiple files, or likely handoff, create or update ACM work with `acm work --project soundspan ...`.
5. For code, config, onboarding, schema, or behavior changes, run `acm verify --project soundspan ...` before completion.
6. If `.acm/acm-workflows.yaml` requires a review task such as `review:cross-llm`, satisfy it with `acm review --run --project soundspan --receipt-id <receipt-id>` when the task defines a `run` block; otherwise use manual review fields or `acm work`.
7. Close the task with `acm report-completion --project soundspan ...`. Changed files must stay within the active receipt scope.
8. Record reusable decisions and pitfalls with `acm propose-memory --project soundspan ...`. Evidence keys must come from the active receipt scope.

## Working Rules

- Do not silently expand scope. Refresh context first if the task spills into adjacent systems.
- Prefer small, reviewable changes over broad cleanup.
- Do not invent product requirements, compatibility guarantees, or migration behavior when the repo does not define them.
- If verification fails, either fix the issue or report the failure clearly. Do not claim the task is complete as if checks passed.
- Keep work state current when you pause, hand off, or hit a blocker.

## Repository-Specific Rules

- Use `frontend/lib/api.ts` as the frontend API boundary. Do not introduce direct component `fetch` calls.
- Use shared logging helpers in runtime code:
  - frontend: `frontend/lib/logger.ts`
  - backend: `backend/src/utils/logger.ts`
  - python sidecars: `services/common/logging_utils.py`
- Keep `CHANGELOG.md` updated for user-visible or behavior-changing work.
- Documentation coverage expectations remain strict:
  - exported TypeScript symbols should stay fully documented,
  - runtime Python modules should stay fully docstring-covered,
  - implemented OpenAPI routes should stay documented.
- For non-trivial implementation work, satisfy the repo-standard xhigh cross-LLM review gate before final completion:
  - `acm review --run --project soundspan --receipt-id <receipt-id>`
  - model and reasoning settings live in `.acm/acm-workflows.yaml`
- If concurrent multi-agent plan storage is needed, configure `ACM_PG_DSN`. SQLite defaults to `.acm/context.db` and is repo-local.
- Legacy `.agents/**` artifacts are migration input only. Active planning and resumable work now live in ACM.

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
- Required workflow gates from `.acm/acm-workflows.yaml` satisfied before completion reporting.
- `CHANGELOG.md` updated for behavior-visible changes.
- No scope expansion beyond original request.
- Documentation updated for new/changed exports, routes, or schemas.

## Historical Work Lookup

- Use `acm work search --project soundspan --scope all --query "<topic>"` to find archived, completed, deferred, or current work by topic.
- Use `acm work list --project soundspan --scope all` when you need a broader inventory view.
- Fetch the returned plan or receipt keys for details.
- If you need receipts, runs, or durable memories in addition to plans, use `acm history search --project soundspan --entity all ...` or `acm history search --project soundspan --entity memory ...`, then fetch the returned `fetch_keys`.

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
- The validator enforces the schema for `kind=feature` and `kind=feature_stream` plans and exits cleanly for other plan kinds.
- See `docs/ACM_FEATURE_PLANS.md` for examples and command shapes.

## ACM Maintenance

Bootstrap this repo with:

- `acm bootstrap --project soundspan --project-root .`

Do not prepend `acm sync` to every workflow. Start with `acm get-context`; use `sync`, `health --apply`, or targeted `health --fix <name> --apply` when context looks stale, when newly created files are missing from retrieval, after editing `.acm/**` or repo-local agent-steering assets, or when entering a fresh worktree that has not been synced yet.

After editing `.acm/**`, root agent contracts, or repo-local Claude ACM assets:

1. `acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .`
2. `acm health --project soundspan --include-details`

Useful maintenance commands:

- `acm health --project soundspan --apply` when ACM-managed state needs repair without a broader manual sync flow
- `acm health --project soundspan --fix sync_ruleset --apply` when you only need to refresh canonical rules
- `acm coverage --project soundspan --project-root .` to measure indexing coverage and spot retrieval gaps

## Worktrees

- Default SQLite is repo-local, so each worktree gets its own `.acm/context.db`. This is the recommended setup when multiple worktrees may diverge at the same time.
- Treat a new worktree like a fresh ACM runtime surface: run `acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .` before relying on retrieval there, and run `acm health --project soundspan --include-details` if the worktree was created from older repo state.
- If you run ACM commands from outside the worktree root, set `ACM_PROJECT_ROOT` to the active worktree path.
- If you move ACM to shared Postgres for multi-agent coordination, do not point multiple divergent worktrees at the same shared ACM project state. Use distinct project ids or isolated backends per worktree, otherwise retrieval and sync become last-sync-wins across trees.
