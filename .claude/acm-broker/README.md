# Claude Command Pack - acm-broker

This folder provides Claude Code slash-command prompts that mirror the `acm-broker` workflow.

## Commands

- `/acm-get <task text>`
  - runs context retrieval first, surfaces hard rules, and treats code pointers as advisory.
  - includes a `fetch` step with `receipt_id` shorthand (or explicit keys when needed).
- `/acm-work <receipt_id> <tasks-json> [plan-json]`
  - publishes plan/task updates through `work`.
- `/acm-verify <receipt_id-or-plan_key> <comma-separated files> [phase]`
  - runs repo-defined executable verification and updates `verify:tests` when work context is available.
- `/acm-report <receipt_id> <comma-separated files> <outcome summary>`
  - runs completion reporting after verification is satisfied and applies scope-gate semantics.
- `/acm-memory <receipt_id> <category> <subject> <content>`
  - proposes durable memory in broker format.
- `/acm-eval <eval-suite-path> [minimum-recall]`
  - runs retrieval evaluation against an explicit eval suite.

## Install into a project

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude .
```

Then restart Claude Code so commands are reloaded.

If you already have this repo checked out locally, the equivalent command is `./scripts/install-skill-pack.sh --claude .`.

## Runtime notes

- Slash-command prompts assume installed `acm` and `acm-mcp` binaries are available on `PATH`.
- Default backend: SQLite unless `ACM_PG_DSN` is set.
- Scope mode defaults to advisory `warn` when `scope_mode` is omitted.
- Optional logger controls:
  - `ACM_LOG_LEVEL=debug|info|warn|error`
  - `ACM_LOG_SINK=stderr|stdout|discard`
