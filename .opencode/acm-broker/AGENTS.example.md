# AGENTS.md

OpenCode-oriented companion example for a repo that uses `acm`.
Keep the real `AGENTS.md` at the repo root so OpenCode can inherit the project contract from the same place as other ACM operators. These companion docs should stay thin and map back to that file.

## Required Task Loop

1. Read this file and the human task.
2. Run `acm context` before opening or editing project files.
3. Follow all hard rules returned in the receipt.
4. Use `acm fetch` only for the plans, tasks, memories, or pointers needed for the current step.
5. When the task spans multiple steps, multiple files, or a likely handoff, create or update `acm work`.
6. If code, config, schema, or other executable behavior changes, run `acm verify` before `acm done`.
7. If `.acm/acm-workflows.yaml` requires review task keys such as `review:cross-llm`, prefer `acm review --run` when the task defines a `run` block; otherwise use manual `review` fields or `work` before `done`.
8. End every task with `acm done`, including every changed file for file-backed work when you know them, or letting ACM derive the task delta from the receipt baseline. When that detected delta is empty, the closeout is effectively no-file.
9. If you learn a reusable decision, gotcha, or preference, record it with `acm memory`.

When the task changes rules, tags, tests, workflows, onboarding, or tool-surface behavior, refresh broker state with:

- `acm sync --mode working_tree --insert-new-candidates`
- `acm health --include-details`

## OpenCode usage notes

- OpenCode is a primary ACM operator, not only a review backend.
- Use native repo search and file reads normally; ACM supplies durable state, rules, review history, and governed closeout.
- This repo's documented OpenCode support is explicit and repo-local: companion docs under `.opencode/acm-broker/` plus normal CLI or MCP access.
- If governed file scope expands beyond the initial receipt, declare the later-discovered files through `work.plan.discovered_paths` before relying on `review` or `done`.
- If you need to resume archived work, use `acm history` and then `acm fetch` the returned `fetch_keys`.
- If a planned task or review gate becomes obsolete, mark it `superseded` instead of leaving it open or `blocked`.

## Working rules

- Prefer small, reviewable changes over broad cleanup.
- Do not silently widen governed file scope.
- Do not invent product requirements, compatibility guarantees, or migration behavior the repo does not define.
- Keep durable work state current when you pause, hand off, or hit a blocker.
