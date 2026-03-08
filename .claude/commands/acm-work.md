Publish work updates through the context broker.

Arguments format:
`<receipt_id-or-plan_key> <tasks-json> [plan-json]`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - `plan_key` when the first argument starts with `plan:`
   - otherwise `receipt_id`
   - `tasks` JSON array
   - optional `plan` JSON object
2. Build valid `acm.v1` `work` JSON using the active `project_id` (or omit it when `ACM_PROJECT_ID` / repo-root inference is already configured).
3. Validate:
   - `acm validate --in <request.json>`
4. Execute:
   - `acm run --in <request.json>`
5. Return broker response exactly.

Constraints:
- Use `tasks`.
- Use `plan` when you need plan metadata such as `title`, `mode`, `objective`, `kind`, `parent_plan_key`, or `external_refs`.
- Use `/acm-review` instead when you only need to record a single review-gate outcome.
- Use `verify:tests` as the executable verification task key.
- `verify:diff-review` is optional if the repo tracks a separate manual diff review step.
- Add other task keys when `.acm/acm-workflows.yaml` requires them for completion.
- If the repo defines a richer feature-plan contract, populate `plan.stages`, top-level `stage:*` tasks, `parent_task_key`, and leaf-task `acceptance_criteria` here instead of leaving that structure only in prose.
