# CLAUDE.md - acm-broker Skill Companion

Use this companion when running `acm-broker` workflow inside Claude Code.

## Required Order

1. Run context retrieval first (`/acm-get ...`).
2. Follow the returned `get_context` rules block (or rule pointers) as hard constraints.
3. Treat code pointers as advisory and run `fetch` with `receipt_id` shorthand (or explicit keys when needed).
4. Execute work; if context is stale/insufficient, retrieve again.
5. If plan tracking is active, post `work` updates using `/acm-work ...` with `receipt_id` (and optional `plan_key`) and use `tasks`. For status checks, send zero tasks.
6. When code changes are involved, run `/acm-verify ...` before completion reporting.
7. On completion, run `/acm-report ...`.
8. If a durable discovery was made, run `/acm-memory ...`.

## Contract Notes

- Keep broker payloads valid against `acm.v1` contract.
- Do not treat code pointer paths as hard edit boundaries.
- Do treat `get_context` rules as mandatory.
- Scope mode defaults to advisory `warn` when omitted.
- `verify:tests` is the built-in executable verification gate; `verify:diff-review` is optional workflow metadata.
- If retrieval is insufficient, refine task text and retrieve again.
