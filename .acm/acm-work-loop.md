# ACM Work Loop

Every command has a CLI and MCP form — use whichever your runtime provides.

## The Loop

**1. Context** — tell ACM what you're doing. Obey every hard rule in the receipt. Save the `receipt_id`.

    acm context --task-text "..." --phase <plan|execute|review>
    acm-mcp invoke --tool context --in '{"task_text":"...","phase":"execute"}'

**2. Work** (when multi-step, multi-file, or needs durable state) — create or update a plan with tasks.

    acm work --receipt-id <id> --plan-title "..." --tasks-json '[...]'
    acm-mcp invoke --tool work --in '{"receipt_id":"...","plan_title":"...","tasks":[...]}'

**3. Verify** — run before closing any code, config, or behavior change.

    acm verify --receipt-id <id>
    acm-mcp invoke --tool verify --in '{"receipt_id":"..."}'

**4. Review** (when `.acm/acm-workflows.yaml` requires it) — satisfy review gates.

    acm review --receipt-id <id> --run
    acm-mcp invoke --tool review --in '{"receipt_id":"...","run":true}'

**5. Done** — close the task. ACM computes file delta from the receipt baseline.

    acm done --receipt-id <id> --outcome "what was accomplished"
    acm-mcp invoke --tool done --in '{"receipt_id":"...","outcome":"..."}'

## Utilities

| Purpose | CLI | MCP |
|---|---|---|
| Fetch keys from receipt | `acm fetch --receipt-id <id> --key <key>` | `fetch` |
| Debug setup | `acm status` | `status` |
| Browse archived work | `acm history --entity work` | `history` |
| Refresh after config edits | `acm sync --mode working_tree --insert-new-candidates` | `sync` |
| Check repo health | `acm health --include-details` | `health` |

## Feature Plans

For net-new features or large capability expansions, use the staged plan contract: root plan with `kind=feature`, `stage:*` tasks, and leaf tasks with `acceptance_criteria`. Use thinner plans for bugfixes and narrow maintenance. See [docs/feature-plans.md](docs/feature-plans.md) for the full contract.

## Ruleset Maintenance

When `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, or `.acm/acm-workflows.yaml` changes, refresh broker state with `acm sync` or `acm health --apply`, then run `acm health`.