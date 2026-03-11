Publish work updates through the context broker.

Arguments format:
`<receipt_id-or-plan_key> <tasks-json> [plan-json]`

Input: $ARGUMENTS

Steps:
1. Parse the first argument into either `--plan-key` or `--receipt-id`.
2. Treat the second argument as `--tasks-json`.
3. When a third argument is present, treat it as `--plan-json`.
4. Run `acm work` with the parsed identifiers plus `--tasks-json` and optional `--plan-json`.
5. Return the broker response exactly.

Constraints:
- Use `plan.discovered_paths` when governed file work expands beyond the receipt's initial scope and later `review` or `done` calls need that scope declared explicitly.
- Use `/acm-review` instead when you only need to record a single review-gate outcome.
- Use `verify:tests` as the executable verification task key.
- Add other task keys when `.acm/acm-workflows.yaml` requires them for completion.
- If the repo defines a richer feature-plan contract, populate `plan.stages`, top-level `stage:*` tasks, `parent_task_key`, and leaf-task `acceptance_criteria` here instead of leaving that structure only in prose.
