Report completion through the context broker.

Arguments format:
`<receipt_id> <comma-separated-files> <outcome summary>`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - `receipt_id`
   - `files_changed[]`
   - `outcome`
2. If code changed and executable verification has not been run yet, stop and run `/acm-verify` first. `report_completion` should come after `verify`, not before it.
3. If the repo workflow requires an additional review task such as `review:cross-llm` and it has not been recorded yet, stop and run `/acm-review <receipt_id-or-plan_key> {"run":true}` when the task defines a runnable review gate; otherwise publish a manual `/acm-review` or `/acm-work` update first.
4. Build valid `acm.v1` `report_completion` JSON.
5. Validate:
   - `acm validate --in <request.json>`
6. Execute:
   - `acm run --in <request.json>`
7. If plan tracking context is available (for example from prior `fetch` results), build a `work` request with:
   - the active `project_id` (or omit it when `ACM_PROJECT_ID` / repo-root inference is already configured)
   - `receipt_id`
   - optional `plan_key` (only if you need to override inference)
   - zero or more updated work tasks (`status` + `outcome` when sending updates)
   - when sending verification-related updates, use `verify:tests`
   - `verify:diff-review` is optional if the repo tracks a separate manual diff review step
8. Validate and execute the `work` request:
   - `acm validate --in <work-request.json>`
   - `acm run --in <work-request.json>`
9. Return broker response(s) exactly.

Constraints:
- Never omit any changed file.
- `scope_mode` defaults to advisory `warn`; set `strict` or `auto_index` only when explicitly required.
- For code changes, do not call `report_completion` before `verify`.
- When work tasks are present, `strict` enforces configured completion tasks from `.acm/acm-workflows.yaml` (defaulting to `verify:tests` when no workflow gates are configured), and `warn` surfaces warnings.
