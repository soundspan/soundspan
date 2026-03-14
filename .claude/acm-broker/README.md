# Claude Command Pack - acm-broker

This folder provides Claude Code slash-command prompts that mirror the `acm-broker` workflow.
The intended default story is the modular core loop: `context`, `work`, `verify`, `done`, and `memory`, with `fetch` and `review` as supporting surfaces.

## Commands

- `/acm-context [phase] <task text>`
  - requests `context` first, surfaces hard rules, and returns plans, memories, and any known initial scope.
  - includes a `fetch` step with `receipt_id` shorthand (or explicit keys when needed).
- `/acm-work <receipt_id-or-plan_key> <tasks-json> [plan-json]`
  - publishes plan/task updates through `work`; use `plan-json` when you need named-plan metadata such as `title` or `mode`.
  - use `plan.discovered_paths` when governed work expands beyond the receipt's initial scope and later `review` or `done` must validate those files.
  - if the repo defines a richer feature-plan contract, this is where `plan.stages`, top-level `stage:*` tasks, task hierarchy, and leaf `acceptance_criteria` should be recorded.
- `/acm-review <receipt_id-or-plan_key> [review-json]`
  - records a single review gate through the thin `review` surface, defaulting to `review:cross-llm`; use `{"run":true}` when the repo workflow defines a runnable review gate.
- `/acm-verify <receipt_id-or-plan_key> [comma-separated files] [phase]`
  - runs repo-defined executable verification and updates `verify:tests` when work context is available. Omit the file segment only when the receipt baseline or repo selectors make explicit files unnecessary. In soundspan, backend verify remains receipt-scoped and targeted; the runnable review gate carries the promoted full backend build and coverage pass before completion.
- `/acm-done <receipt_id-or-plan_key> [comma-separated files] -- <outcome summary>`
  - runs completion reporting after verification is satisfied and applies effective-scope plus configured completion-gate semantics. Omit the file segment to rely on the baseline-derived delta; if that detected delta is empty, the closeout is effectively no-file.
- `/acm-memory {"receipt_id":"...","category":"gotcha","subject":"...","content":"...","evidence_paths":["path/to/file.go"],"evidence_keys":["project:path#anchor"]}`
  - proposes durable memory in broker format and requires evidence through `evidence_paths` or `evidence_keys` inside effective scope.

For compact rediscovery of archived plans, receipts, runs, and durable memories, use direct CLI `acm history`, setting `--entity work` when you need work-specific `--scope` or `--kind` filters, then `acm fetch` the returned `fetch_keys`. The default command pack does not add a dedicated `/acm-history` slash command.
For runtime and setup diagnostics, use direct CLI `acm status`. It reports active project/backend state, loaded ACM files, integrations, missing setup, and an optional simple `context` preview.
When you change rules, tags, tests, workflows, onboarding, or tool-surface behavior, run direct CLI `acm sync --mode working_tree --insert-new-candidates` and `acm health --include-details` before `/acm-done`.

## Install into a project

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude
```

Run this from your project root, then restart Claude Code so commands are reloaded.

If you already have this repo checked out locally, the equivalent command is `./scripts/install-skill-pack.sh --claude`.

If the current repo already uses `init`, you can also seed the same files with:

```bash
acm init [--project <id>] [--project-root .] --apply-template claude-command-pack
```

Add `--apply-template claude-hooks` when you also want the optional Claude ACM process guard hooks.
Add `--apply-template git-hooks-precommit` when you also want the staged-file `acm verify` pre-commit hook template.
For repo-local verification scaffolding, pair `init` with `--apply-template verify-generic` for the lowest-friction default, or choose `verify-go`, `verify-ts`, `verify-python`, or `verify-rust` for a language-oriented starter.

## Runtime notes

- Slash-command prompts assume installed `acm` and `acm-mcp` binaries are available on `PATH`.
- Default backend: SQLite unless `ACM_PG_DSN` is set.
- `ACM_PROJECT_ID` can provide a default project namespace; otherwise acm infers from the effective repo root and `ACM_PROJECT_ROOT` when set.
- The optional `claude-hooks` template re-injects the ACM loop at session start or compaction, keeps edits blocked until `/acm-context` succeeds, nudges `/acm-work` once edits span files or governed scope expands, and blocks stop until edited work is closed with `/acm-done`.
- Scope mode defaults to advisory `warn` when `scope_mode` is omitted.
- `/acm-done` can rely on the receipt baseline delta when explicit files are inconvenient. If that detected delta is empty, the closeout is effectively no-file.
- Runnable review gates can carry repo-local script arguments in `.acm/acm-workflows.yaml` `run.argv`, which is where model and reasoning choices should live.
- Some repos enforce richer feature-plan schemas through verify-time scripts that inspect `ACM_PLAN_KEY` / `ACM_RECEIPT_ID`; keep that structure in `work`, not in free-form prose.
- Optional logger controls:
  - `ACM_LOG_LEVEL=debug|info|warn|error`
  - `ACM_LOG_SINK=stderr|stdout|discard`
