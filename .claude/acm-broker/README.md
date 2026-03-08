# Claude Command Pack - acm-broker

This folder provides Claude Code slash-command prompts that mirror the `acm-broker` workflow.

## Commands

- `/acm-get [phase] <task text>`
  - runs context retrieval first, surfaces hard rules, and treats code pointers as advisory.
  - includes a `fetch` step with `receipt_id` shorthand (or explicit keys when needed).
- `/acm-work <receipt_id-or-plan_key> <tasks-json> [plan-json]`
  - publishes plan/task updates through `work`; use `plan-json` when you need named-plan metadata such as `title` or `mode`.
- `/acm-review <receipt_id-or-plan_key> [review-json]`
  - records a single review gate through the thin `review` surface, defaulting to `review:cross-llm`; use `{"run":true}` when the repo workflow defines a runnable review gate.
- `/acm-verify <receipt_id-or-plan_key> <comma-separated files> [phase]`
  - runs repo-defined executable verification and updates `verify:tests` when work context is available.
- `/acm-report <receipt_id> <comma-separated files> <outcome summary>`
  - runs completion reporting after verification is satisfied and applies scope plus configured completion-gate semantics.
- `/acm-memory <receipt_id> <category> <subject> <content>`
  - proposes durable memory in broker format.
- `/acm-eval <eval-suite-path> [minimum-recall]`
  - runs retrieval evaluation against an explicit eval suite.

For compact rediscovery of archived plans, receipts, runs, and durable memories, use direct CLI `acm work search --scope all ...` for plan-only lookup or `acm history search --entity all ...`, `acm history search --entity memory ...`, or MCP `history_search`, then `fetch` the returned `fetch_keys`. The default command pack does not add a dedicated `/acm-history` slash command.

## Install into a project

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude
```

Run this from your project root, then restart Claude Code so commands are reloaded.

If you already have this repo checked out locally, the equivalent command is `./scripts/install-skill-pack.sh --claude`.

If the current repo already uses bootstrap, you can also seed the same files with:

```bash
acm bootstrap [--project <id>] [--project-root .] --apply-template claude-command-pack
```

Add `--apply-template claude-receipt-guard` when you also want the optional Claude receipt guard hooks.
Add `--apply-template git-hooks-precommit` when you also want the staged-file `acm verify` pre-commit hook template.

## Runtime notes

- Slash-command prompts assume installed `acm` and `acm-mcp` binaries are available on `PATH`.
- Default backend: SQLite unless `ACM_PG_DSN` is set.
- `ACM_PROJECT_ID` can provide a default project namespace; otherwise acm infers from the effective repo root and `ACM_PROJECT_ROOT` when set.
- The optional `claude-receipt-guard` template keeps edits blocked until `/acm-get` or an equivalent `get_context` request succeeds in the current session.
- Scope mode defaults to advisory `warn` when `scope_mode` is omitted.
- Runnable review gates can carry repo-local script arguments in `.acm/acm-workflows.yaml` `run.argv`, which is where model and reasoning choices should live.
- Optional logger controls:
  - `ACM_LOG_LEVEL=debug|info|warn|error`
  - `ACM_LOG_SINK=stderr|stdout|discard`
