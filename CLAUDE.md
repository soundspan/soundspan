# CLAUDE.md

Claude companion for soundspan. The primary contract is `AGENTS.md` — if this file conflicts, `AGENTS.md` wins.

## ACM Workflow

See [.acm/acm-work-loop.md](.acm/acm-work-loop.md) for the full command reference. Claude slash-command equivalents:

| AGENTS.md step | Claude command |
|---|---|
| `acm context` | `/acm-context [phase] <task>` |
| `acm work` | `/acm-work` |
| `acm verify` | `/acm-verify` |
| `acm review --run` | `/acm-review <id> {"run":true}` |
| `acm done` | `/acm-done` |

Direct CLI (`acm sync`, `acm health`, `acm history`, `acm status`) has no slash-command wrappers — call those directly.

## Memory (AMM)

AMM is available via MCP tools in this session. Query it early and often — see `AGENTS.md` § Memory for the full contract.

- **At session start**, run `amm recall|amm_recall` with mode `ambient` to load relevant prior context.
- **Before decisions or when uncertain**, query `amm recall|amm_recall` — don't guess when AMM might already know.
- **After stable decisions or lessons learned**, commit them with `amm remember|amm_remember`.
- Use `amm expand|amm_expand` to expand thin recall items when you need more detail.

## Claude-Specific Notes

- Keep prompts specific so `context` loads the right rules and plans.
- If the receipt looks stale or narrow, re-run `/acm-context` with better task text instead of guessing.
- If governed work expands beyond initial scope, declare new files through `/acm-work` before `/acm-review` or `/acm-done`.
- Do not claim success when `/acm-verify` failed or was skipped for code changes.
- `/acm-review` is thin: use `{"run":true}` for runnable gates, manual fields for non-run mode.
- If `/acm-review {"run":true}` reports zero scoped review files, the receipt scope is too narrow — re-run `/acm-context` or update `/acm-work`.
- Reviewer provider and high-trust flag settings stay in `.acm/acm-workflows.yaml`; this repo uses the shared `--yolo` shortcut, which maps to native Codex yolo mode or Claude dangerous-permissions mode.
- When changing rules, tags, tests, or workflows, run `acm sync --mode working_tree --insert-new-candidates` and `acm health --include-details` before `/acm-done`.
- For historical discovery after compaction, use `acm history` then `acm fetch` the returned keys.
- For runtime diagnostics, use `acm status`.
- If the repo defines a richer feature-plan contract, populate `plan.stages`, `stage:*` tasks, `parent_task_key`, and leaf `acceptance_criteria` through `/acm-work` before implementation.

## Source Of Truth

- `AGENTS.md` is the full repo contract.
- ACM config: `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, `.acm/acm-workflows.yaml`
- Claude assets: `.claude/commands/`, `.claude/acm-broker/`
- Reinstall command pack: `bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude`
