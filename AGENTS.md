# AGENTS.md

Repository contract for `soundspan` after ACM onboarding.

## Source Of Truth

- Follow this file first.
- Canonical ACM rules, tags, and verification definitions live in `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, and `.acm/acm-tests.yaml`.
- `CLAUDE.md` and `.claude/acm-broker/**` are tool-specific companions only. If they disagree with this file, this file wins.
- ACM work storage is the source of truth for active and historical plan state. Use `acm work list/search --scope all` when you need archived or completed history.

## Required Task Loop

1. Read `AGENTS.md` and the human task.
2. Run `acm get-context --project soundspan --task-text "<current task>" --phase <plan|execute|review>`.
3. Read the returned hard rules and fetch only the keys needed for the current step.
4. If the task spans multiple steps, multiple files, or likely handoff, create or update ACM work with `acm work --project soundspan ...`.
5. For code, config, onboarding, schema, or behavior changes, run `acm verify --project soundspan ...` before completion.
6. Close the task with `acm report-completion --project soundspan ...`. Changed files must stay within the active receipt scope.
7. Record reusable decisions and pitfalls with `acm propose-memory --project soundspan ...`. Evidence keys must come from the active receipt scope.

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
- For non-trivial implementation work, run a read-only xhigh Codex review before final completion:
  - `codex exec -c model="gpt-5.4" -c model_reasoning_effort="xhigh" --sandbox read-only --ephemeral "<context here>"`
- If concurrent multi-agent plan storage is needed, configure `ACM_PG_DSN`. SQLite defaults to `.acm/context.db` and is repo-local.
- Legacy `.agents/**` artifacts are migration input only. Active planning and resumable work now live in ACM.

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

## ACM Maintenance

Bootstrap this repo with:

- `acm bootstrap --project soundspan --project-root .`

Do not prepend `acm sync` to every workflow. Start with `acm get-context`; use `sync` or `health-fix` when context looks stale, when newly created files are missing from retrieval, after editing `.acm/**` or repo-local agent-steering assets, or when entering a fresh worktree that has not been synced yet.

After editing `.acm/**`, root agent contracts, or repo-local Claude ACM assets:

1. `acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .`
2. `acm health --project soundspan --include-details`

Useful maintenance commands:

- `acm health-fix --project soundspan --apply` when ACM-managed state needs repair without a broader manual sync flow
- `acm coverage --project soundspan --project-root .` to measure indexing coverage and spot retrieval gaps

## Worktrees

- Default SQLite is repo-local, so each worktree gets its own `.acm/context.db`. This is the recommended setup when multiple worktrees may diverge at the same time.
- Treat a new worktree like a fresh ACM runtime surface: run `acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .` before relying on retrieval there, and run `acm health --project soundspan --include-details` if the worktree was created from older repo state.
- If you run ACM commands from outside the worktree root, set `ACM_PROJECT_ROOT` to the active worktree path.
- If you move ACM to shared Postgres for multi-agent coordination, do not point multiple divergent worktrees at the same shared ACM project state. Use distinct project ids or isolated backends per worktree, otherwise retrieval and sync become last-sync-wins across trees.
