# AWM Work Loop

Every command has a CLI and MCP form — use whichever your runtime provides.

## The Loop

**1. Context** — tell AWM what you're doing. Obey every hard rule in the receipt. Save the `receipt_id`.

    awm context --task-text "..." --phase <plan|execute|review>
    awm-mcp invoke --tool context --in '{"task_text":"...","phase":"execute"}'

**2. Work** (when multi-step, multi-file, or needs durable state) — create or update a plan with tasks.

    awm work --receipt-id <id> --plan-title "..." --tasks-json '[...]'
    awm-mcp invoke --tool work --in '{"receipt_id":"...","plan_title":"...","tasks":[...]}'

**3. Verify** — run before closing any code, config, or behavior change.

    awm verify --receipt-id <id>
    awm-mcp invoke --tool verify --in '{"receipt_id":"..."}'

**4. Review** (when `.awm/awm-workflows.yaml` requires it) — satisfy review gates.

    awm review --receipt-id <id> --run
    awm-mcp invoke --tool review --in '{"receipt_id":"...","run":true}'

**5. Done** — close the task. AWM computes file delta from the receipt baseline.

    awm done --receipt-id <id> --outcome "what was accomplished"
    awm-mcp invoke --tool done --in '{"receipt_id":"...","outcome":"..."}'

## Utilities

| Purpose | CLI | MCP |
|---|---|---|
| Fetch keys from receipt | `awm fetch --receipt-id <id> --key <key>` | `fetch` |
| Debug setup | `awm status` | `status` |
| Browse archived work | `awm history --entity work` | `history` |
| Refresh after config edits | `awm sync --mode working_tree --insert-new-candidates` | `sync` |
| Check repo health | `awm health --include-details` | `health` |

## Feature Plans

For net-new features or large capability expansions, use the staged plan contract: root plan with `kind=feature`, `stage:*` tasks, and leaf tasks with `acceptance_criteria`. Use thinner plans for bugfixes and narrow maintenance. See [docs/AWM_FEATURE_PLANS.md](docs/AWM_FEATURE_PLANS.md) for the full contract.

## Historical Work Lookup

- Use `awm work search --scope all --query "<topic>"` to find archived, completed, deferred, or current work by topic.
- Use `awm work list --scope all` when you need a broader inventory view.
- Fetch the returned plan or receipt keys for details.
- If you need receipts or runs in addition to plans, use `awm history search --entity all ...`, then fetch the returned `fetch_keys`.

## Ruleset Maintenance

When `.awm/awm-rules.yaml`, `.awm/awm-tags.yaml`, `.awm/awm-tests.yaml`, or `.awm/awm-workflows.yaml` changes, refresh broker state with `awm sync` or `awm health --apply`, then run `awm health`.
