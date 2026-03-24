# CLAUDE.md

Claude companion for soundspan. The primary contract is `AGENTS.md` — if this file conflicts, `AGENTS.md` wins.

If ACM is available in your session, also follow [.acm/AGENTS-ACM.md](.acm/AGENTS-ACM.md).  If you are unaware or unsure of what ACM is, do not read the file.

## ACM Workflow (when available)

See [.acm/acm-work-loop.md](.acm/acm-work-loop.md) for the full command reference. Claude slash-command equivalents:

| AGENTS-ACM.md step | Claude command |
|---|---|
| `acm context` | `/acm-context [phase] <task>` |
| `acm work` | `/acm-work` |
| `acm verify` | `/acm-verify` |
| `acm review --run` | `/acm-review <id> {"run":true}` |
| `acm done` | `/acm-done` |

Direct CLI (`acm sync`, `acm health`, `acm history`, `acm status`) has no slash-command wrappers — call those directly.

## Claude-Specific Notes

- Keep prompts specific so `context` loads the right rules and plans.
- If using ACM and the receipt looks stale or narrow, re-run `/acm-context` with better task text instead of guessing.
- If governed work expands beyond initial scope, declare new files through `/acm-work` before `/acm-review` or `/acm-done`.
- Do not claim success when verification failed or was skipped for code changes.
- When changing rules, tags, tests, or workflows, run `acm sync --mode working_tree --insert-new-candidates` and `acm health --include-details` before `/acm-done`.
- For historical discovery after compaction, use `acm history` then `acm fetch` the returned keys.
- If the repo defines a richer feature-plan contract, populate `plan.stages`, `stage:*` tasks, `parent_task_key`, and leaf `acceptance_criteria` through `/acm-work` before implementation.

## Source Of Truth

- `AGENTS.md` is the full repo contract.
- Claude assets: `.claude/commands/`, `.claude/acm-broker/`
- Reinstall command pack: `bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude`
