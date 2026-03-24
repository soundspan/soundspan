# ACM Agent Workflow — soundspan

This extends [AGENTS.md](../AGENTS.md) with the ACM-managed workflow for agents that have `acm` available. All invariants and working rules from AGENTS.md still apply.

See [acm-work-loop.md](acm-work-loop.md) for the full command reference.

## Source Of Truth

- Canonical rules: `.acm/acm-rules.yaml`
- Canonical tags: `.acm/acm-tags.yaml`
- Canonical verification: `.acm/acm-tests.yaml`
- Canonical workflow gates: `.acm/acm-workflows.yaml`
- ACM work storage is the source of truth for active and historical plan state. Use `acm work list/search --scope all` when you need archived or completed history.

## Task Loop

For non-trivial work (multi-step, multi-file, or governed changes), follow this loop. Trivial single-file fixes can skip the ACM ceremony.

1. Read `AGENTS.md` and any tool-specific companion (e.g. `CLAUDE.md`) and the human task.
2. Run `acm context --task-text "<current task>" --phase <plan|execute|review>`.
3. Read the returned hard rules and fetch only the keys needed for the current step.
4. If the task spans multiple steps, multiple files, or likely handoff, create or update ACM work with `acm work ...`.
5. For code, config, schema, or behavior changes, run `acm verify ...` before completion.
6. If `.acm/acm-workflows.yaml` requires a review task such as `review:cross-llm`, satisfy it with `acm review --run --receipt-id <receipt-id>` when the task defines a `run` block; otherwise use manual review fields or `acm work`.
7. Close the task with `acm done ...`. Changed files must stay within the active receipt scope.

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

## ACM-Specific Working Norms

- Do not silently expand governed file scope. Refresh context first. Use `work.plan.discovered_paths` when later-discovered files must be declared for review or done.
- Keep work state current when you pause, hand off, or hit a blocker.
- Cross-LLM review: for non-trivial implementation work, satisfy the repo review gate before final completion:
  - `acm review --run --project soundspan --receipt-id <receipt-id>`
  - reviewer provider, model, reasoning, and shared `--yolo` settings live in `.acm/acm-workflows.yaml`

## Ruleset Maintenance

When `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, or `.acm/acm-workflows.yaml` changes:

```bash
acm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .
acm health --project soundspan --include-details
```

## Skill Aliases

Tools with the ACM skill pack installed expose these shorthand commands:

| ACM CLI | Skill alias |
|---|---|
| `acm context` | `/acm-context [phase] <task>` |
| `acm work` | `/acm-work` |
| `acm verify` | `/acm-verify` |
| `acm review --run` | `/acm-review <id> {"run":true}` |
| `acm done` | `/acm-done` |

Direct CLI (`acm sync`, `acm health`, `acm history`, `acm status`) has no skill aliases — call those directly.
