Publish work updates through the context broker.

Arguments format:
`<receipt_id> <tasks-json> [plan-json]`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - `receipt_id`
   - `tasks` JSON array
   - optional `plan` JSON object
2. Build valid `acm.v1` `work` JSON using the active `project_id`.
3. Validate:
   - `acm validate --in <request.json>`
4. Execute:
   - `acm run --in <request.json>`
5. Return broker response exactly.

Constraints:
- Use `tasks`.
- Use `verify:tests` as the executable verification task key.
- `verify:diff-review` is optional if the repo tracks a separate manual diff review step.
