# Claude Command Pack - acm-broker

This folder provides Claude Code slash-command prompts that mirror the `acm-broker` workflow.

## Commands

- `/acm-get [phase] <task text>`
  - runs context retrieval first, surfaces hard rules, and treats code pointers as advisory.
  - includes a `fetch` step with `receipt_id` shorthand (or explicit keys when needed).
- `/acm-work <receipt_id-or-plan_key> <tasks-json> [plan-json]`
  - publishes plan/task updates through `work`; use `plan-json` when you need named-plan metadata such as `title` or `mode`.
  - if the repo defines a richer feature-plan contract, this is where `plan.stages`, top-level `stage:*` tasks, task hierarchy, and leaf `acceptance_criteria` should be recorded.
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
For runtime and setup diagnostics, use direct CLI `acm status`. It reports active project/backend state, loaded ACM files, integrations, missing setup, and optional retrieval reasoning. `acm doctor` is only an alias.

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

Add `--apply-template claude-hooks` when you also want the optional Claude ACM process guard hooks.
Add `--apply-template git-hooks-precommit` when you also want the staged-file `acm verify` pre-commit hook template.
For repo-local verification scaffolding, pair bootstrap with `--apply-template verify-generic` for the lowest-friction default, or choose `verify-go`, `verify-ts`, `verify-python`, or `verify-rust` for a language-oriented starter.

## Runtime notes

- Slash-command prompts assume installed `acm` and `acm-mcp` binaries are available on `PATH`.
- Default backend: SQLite unless `ACM_PG_DSN` is set.
- `ACM_PROJECT_ID` can provide a default project namespace; otherwise acm infers from the effective repo root and `ACM_PROJECT_ROOT` when set.
- The optional `claude-hooks` template re-injects the ACM loop at session start/compaction, keeps edits blocked until `/acm-get` or an equivalent `get_context` request succeeds, nudges `/acm-work` once edits span files, and blocks stop until edited work is closed with `acm report-completion`. The older `claude-receipt-guard` template id is still accepted as a compatibility alias.
- Scope mode defaults to advisory `warn` when `scope_mode` is omitted.
- Runnable review gates can carry repo-local script arguments in `.acm/acm-workflows.yaml` `run.argv`, which is where model and reasoning choices should live.
- Some repos enforce richer feature-plan schemas through verify-time scripts that inspect `ACM_PLAN_KEY` / `ACM_RECEIPT_ID`; keep that structure in `work`, not in free-form prose.
- Optional logger controls:
  - `ACM_LOG_LEVEL=debug|info|warn|error`
  - `ACM_LOG_SINK=stderr|stdout|discard`
