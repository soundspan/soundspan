# CLAUDE.md - acm-broker Skill Companion

Use this companion when running `acm-broker` workflow inside Claude Code.

## Required Order

1. Run context retrieval first (`/acm-get [phase] ...`).
2. Follow the returned `get_context` rules block (or rule pointers) as hard constraints.
3. Treat code pointers as advisory and run `fetch` with `receipt_id` shorthand (or explicit keys when needed).
4. Execute work; if context is stale/insufficient, retrieve again.
5. If plan tracking is active, post `work` updates using `/acm-work ...` with `receipt_id` or `plan_key`, plus optional `plan` metadata such as `title` when needed, and use `tasks`. For status checks, send zero tasks.
6. When code changes are involved, run `/acm-verify ...` before completion reporting.
7. Use `/acm-review ...` when a workflow gate needs a single review outcome such as `review:cross-llm`; prefer `{"run":true}` when the repo workflow defines a runnable review gate.
8. On completion, run `/acm-report ...`.
9. If a durable discovery was made, run `/acm-memory ...`.

## Contract Notes

- Keep broker payloads valid against `acm.v1` contract.
- Do not treat code pointer paths as hard edit boundaries.
- Do treat `get_context` rules as mandatory.
- Scope mode defaults to advisory `warn` when omitted.
- `/acm-review` is a thin wrapper over one `work` task update; defaults are `review:cross-llm`, `Cross-LLM review`, and `complete`. Use `{"run":true}` for runnable workflow gates and reserve manual `status`, `outcome`, `blocked_reason`, and `evidence` fields for non-run mode.
- `verify:tests` is the built-in executable verification gate; `verify:diff-review` is optional workflow metadata.
- `.acm/acm-workflows.yaml` may require additional task keys before `report_completion` should pass.
- If retrieval is insufficient, refine task text and retrieve again.
- For runtime or setup debugging, prefer direct CLI `acm status`; `acm doctor` is only an alias.
