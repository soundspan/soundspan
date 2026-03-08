# CLAUDE.md

## RULES (enforce every session, no exceptions)

1. FIRST ACTION: Read `AGENTS.md`, then run `/acm-get [phase] <task text>` BEFORE reading or editing additional project files.
2. VERIFY BEFORE DONE: Run `/acm-verify` BEFORE `/acm-report`. NEVER skip verification for code, config, schema, or behavior changes.
3. REVIEW GATES: If `.acm/acm-workflows.yaml` requires a review task such as `review:cross-llm`, run `/acm-review <receipt_id-or-plan_key> {"run":true}` when that workflow task defines a `run` block; otherwise use manual review JSON or `/acm-work` before `/acm-report`.
4. NO SCOPE CREEP: If work spills into adjacent systems, STOP and re-run `/acm-get` with the broader task.
5. TDD FOR EXECUTABLE WORK: For code, schema, or behavior changes, write or update a failing test FIRST when practical, then implement until it passes. Do not force TDD for review-only, docs-only, or workflow-governance tasks.
6. 3-STRIKE RULE: After 3 failed fix attempts on the same issue, STOP. State what you tried. Ask the user.
7. CHANGELOG: Update `CHANGELOG.md` for any user-visible or behavior-changing work.
8. EVIDENCE: When claiming verification passed, show actual command output. NEVER say "should work", "probably fine", or "looks correct".
9. MULTI-STEP WORK: Use `/acm-work` for tasks spanning multiple files or steps. Include `verify:tests` for executable changes.
10. BOUNDARIES: API calls through `frontend/lib/api.ts`. Logging through shared helpers. DB access through Prisma. No exceptions.
11. FEATURE PLANS: For net-new feature work, create a root ACM plan with `kind=feature`, explicit scope metadata, top-level `stage:*` tasks, and child tasks linked with `parent_task_key`. Use `kind=feature_stream` plus `parent_plan_key` for split execution streams, and let `acm verify` run `acm-feature-plan-validate` against the active receipt/plan when relevant work changes.

## Workflow

`AGENTS.md` → `/acm-get [phase] <task text>` → read returned hard rules → `/acm-work` when multi-step → TDD when implementing executable behavior → `/acm-verify` → `/acm-review <receipt_id-or-plan_key> {"run":true}` when a required review task defines `run`, otherwise manual review JSON or `/acm-work` → `/acm-report`

## Source Of Truth

- `AGENTS.md` is the full repo contract. If it conflicts with this file, `AGENTS.md` wins.
- ACM rules/tags/tests/workflows: `.acm/acm-rules.yaml`, `.acm/acm-tags.yaml`, `.acm/acm-tests.yaml`, `.acm/acm-workflows.yaml`
- Claude command assets: `.claude/commands/`, `.claude/acm-broker/`
- If command assets are missing, reinstall the command pack with `bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-context-manager/main/scripts/install-skill-pack.sh) --claude`
- Do not start every task with `acm sync`. Use `sync`, `health --apply`, or targeted `health --fix <name> --apply` only when context is stale or after editing `.acm/**` or agent-steering files.
