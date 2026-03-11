# CLAUDE.md

Claude companion for soundspan. The primary contract is `AGENTS.md` — if this file conflicts, `AGENTS.md` wins.

## Workflow

1. Run `/acm-context [phase] <task text>` before touching files.
2. Follow returned hard rules as non-optional constraints.
3. Use `/acm-work` when the task spans multiple steps or files.
4. Run `/acm-verify` before `/acm-done` for code, config, schema, or behavior changes.
5. Use `/acm-review <receipt_id-or-plan_key> {"run":true}` when `.acm/acm-workflows.yaml` requires a runnable review gate; otherwise use manual review JSON or `/acm-work`.
6. Close with `/acm-done`; include changed files or let ACM derive the delta.
7. Capture durable decisions with `/acm-memory`.

## Claude-Specific Notes

- Keep prompts specific so `context` loads the right rules, plans, and memories.
- If the receipt looks stale or narrow, re-run `/acm-context` with better task text instead of guessing.
- If governed work expands beyond initial scope, declare new files through `/acm-work` before `/acm-review` or `/acm-done`.
- Do not claim success when `/acm-verify` failed or was skipped for code changes.
- `/acm-review` is thin: use `{"run":true}` for runnable gates, manual fields for non-run mode.
- If `/acm-review {"run":true}` reports zero scoped review files, the receipt scope is too narrow — re-run `/acm-context` or update `/acm-work`.
- When changing rules, tags, tests, or workflows, run `acm sync --mode working_tree --insert-new-candidates` and `acm health --include-details` before `/acm-done`.
- For historical discovery after compaction, use `acm history` then `acm fetch` the returned keys.
- For runtime diagnostics, use `acm status`.
- If the repo defines a richer feature-plan contract, populate `plan.stages`, `stage:*` tasks, `parent_task_key`, and leaf `acceptance_criteria` through `/acm-work` before implementation.

## Source Of Truth

- `AGENTS.md` is the full repo contract.
- ACM config: `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, `.acm/acm-workflows.yaml`
- Claude assets: `.claude/commands/`, `.claude/acm-broker/`
- Reinstall command pack: `bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude`
