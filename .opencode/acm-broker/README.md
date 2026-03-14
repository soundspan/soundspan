# OpenCode Companion - acm-broker

This folder provides OpenCode-first companion docs for repos that use ACM.
The supported OpenCode path in this repo is repo-local companion docs plus normal `acm` CLI or MCP access; it does not assume a hidden global skill-pack location or Claude-style process hooks.

## Recommended setup

1. Install the repo-local OpenCode companion docs from your project root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --opencode
```

If you already have this repo checked out locally, the equivalent command is `./scripts/install-skill-pack.sh --opencode`.
Use `--opencode` when you want to add the OpenCode companion docs to an existing repo immediately.

2. Keep the repo-root `AGENTS.md` as the source of truth for the project workflow.

3. If the repo already uses `init`, you can seed the same files through:

```bash
acm init --apply-template opencode-pack
```

Use `opencode-pack` when you are bootstrapping a repo with `acm init` and want the OpenCode companion docs created alongside the rest of the starter ACM assets.

The installer and template both seed:

- `.opencode/acm-broker/README.md`
- `.opencode/acm-broker/AGENTS.example.md`

These files are documentation only. They do not add hidden hooks or claim special OpenCode-only runtime behavior.

## Recommended OpenCode loop

OpenCode can drive the same ACM workflow directly:

1. `acm context`
2. `acm fetch` only when you need to hydrate specific plan, task, memory, or pointer content
3. `acm work` for multi-step tasks or when governed file scope expands through `plan.discovered_paths`
4. `acm verify` for deterministic repo-defined checks
5. `acm review` when a workflow gate needs one review record or runnable signoff gate
6. `acm done`
7. `acm memory`

Quick walkthrough:

1. Install the companion docs with `--opencode`, or seed them during `acm init` with `opencode-pack`.
2. Keep `AGENTS.md` authoritative and use `.opencode/acm-broker/README.md` as the thin OpenCode companion.
3. Start real work with `acm context --project <id> --task-text "..." --phase plan|execute|review`.
4. For multi-step work, persist plan/task state with `acm work` and declare `plan.discovered_paths` when governed scope expands.
5. Before closing, run `acm verify`, then `acm review --run` when the workflow requires it, then `acm done`.
6. Save durable decisions or recurring pitfalls with `acm memory`.

Keep the command boundary explicit:

- `verify` answers "which repo-defined checks apply to this task and current diff?"
- `review` answers "has this one named workflow gate been satisfied?"

When a task specifically needs rendered ACM artifacts instead of normal envelopes, use the backend-only `export` surface through `acm run --in assets/requests/export.json` or `acm-mcp invoke --tool export --in assets/requests/mcp_export.json`. For quick human-facing CLI output, `context`, `fetch`, `history`, and `status` also support `--format json|markdown` with optional `--out-file` / `--force`; those flags lower to the same backend export path.

Use the same maintenance loop as any other primary ACM operator when rules, tags, tests, workflows, onboarding, or tool-surface behavior change:

- `acm sync --mode working_tree --insert-new-candidates`
- `acm health --include-details`

## Scope and closeout notes

- `context` is task framing, not a substitute for OpenCode reading the repo itself.
- Use OpenCode's native repo search and file-edit tools normally; ACM adds durable state, rules, verification, review history, and governed closeout.
- If governed work discovers later-relevant files, declare them with `work.plan.discovered_paths` before expecting `review` or `done` to pass.
- `done` can omit `files_changed` and rely on the receipt baseline delta when that is more convenient.
- `done` and runnable `review` already treat built-in governance files such as repo-root `AGENTS.md`, `CLAUDE.md`, and canonical `.acm/**` contract files as managed scope.
- Use `verify` for repo checks and `review` for named workflow gates; `review` is not a second generic test runner.
- For already isolated/containerized hosts, prefer workflow `run.argv` that uses `scripts/acm-cross-review.sh --yolo`; the shared high-trust shortcut avoids nested sandbox conflicts while relying on the outer container boundary.
- ACM does not currently ship an OpenCode hook pack because this repo has not documented a verified native OpenCode hook mechanism yet.

## AGENTS companion

Use [AGENTS.example.md](AGENTS.example.md) as the OpenCode-oriented companion example for repo-root `AGENTS.md` contracts.
It is intentionally thin: the repo-root `AGENTS.md` stays authoritative, and these companion docs should map back to that file rather than inventing a second workflow.
