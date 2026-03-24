# CLAUDE.md - acm-broker Skill Companion

Use this companion when running `acm-broker` workflow inside Claude Code.

## Required Order

1. Run `/acm-context [phase] ...` first to request `context`.
2. Follow the returned `context` rules block (or rule pointers) as hard constraints.
3. Use `fetch` with `receipt_id` shorthand (or explicit keys) only when a returned plan, task, or pointer key actually needs to be hydrated.
4. Execute work; if the receipt is stale, too narrow, or the task changed materially, request `context` again with better task text.
5. If plan tracking is active, post `work` updates using `/acm-work ...` with `receipt_id` or `plan_key`, plus optional `plan` metadata such as `title` when needed, and use `tasks`. For status checks, send zero tasks.
6. When code changes are involved, run `/acm-verify ...` before completion reporting.
7. Use `/acm-review ...` when a workflow gate needs a single review outcome such as `review:cross-llm`; prefer `{"run":true}` when the repo workflow defines a runnable review gate.
8. On completion, run `/acm-done ...`. Include changed files for file-backed work when you know them; otherwise let ACM derive the delta from the receipt baseline. When that detected delta is empty, the closeout is effectively no-file.

## Contract Notes

- Keep broker payloads valid against `acm.v1` contract.
- Do not treat initial scope or fetched pointer paths as a substitute for native repo search.
- Do treat `context` rules as mandatory.
- Scope mode defaults to advisory `warn` when omitted.
- `/acm-review` is a thin wrapper over one `work` task update; defaults are `review:cross-llm`, `Cross-LLM review`, and `complete`. Use `{"run":true}` for runnable workflow gates because manual complete notes do not satisfy runnable gates, and reserve manual `status`, `outcome`, `blocked_reason`, and `evidence` fields for non-run mode.
- Runnable review uses effective scope. If the repo has changes but the runner reports zero scoped review files, rerun `/acm-context` or declare the missing files through `/acm-work` before retrying `/acm-review {"run":true}`.
- `verify:tests` is the built-in executable verification gate; `verify:diff-review` is optional workflow metadata.
- `.acm/acm-workflows.yaml` may require additional task keys before `done` should pass. No-file completion is valid when the task produced no file-backed changes.
- If the repo defines a richer feature-plan contract, use `/acm-work` to populate `plan.stages`, top-level `stage:*` tasks, `parent_task_key`, and leaf-task `acceptance_criteria` before implementation; `verify` may enforce that schema.
- If governed file work expands beyond the initial receipt scope, declare the new files through `/acm-work` using `plan.discovered_paths`.
- When rules, tags, tests, workflows, onboarding, or tool-surface behavior change, run direct CLI `acm sync --mode working_tree --insert-new-candidates` and `acm health --include-details` before `/acm-done`.
- For runtime or setup debugging, prefer direct CLI `acm status`.
