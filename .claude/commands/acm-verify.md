Run repo-defined executable verification through the context broker.

Arguments format:
`<receipt_id-or-plan_key> <comma-separated-files> [phase]`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - receipt or plan context
   - `files_changed[]`
   - optional `phase`
2. Build valid `acm.v1` `verify` JSON using the active `project_id`.
3. Include `receipt_id` or `plan_key` when available so `verify` can update `verify:tests`.
4. Validate:
   - `acm validate --in <request.json>`
5. Execute:
   - `acm run --in <request.json>`
6. Return the verify result exactly, including selected tests and statuses.

Constraints:
- Use `verify` before `report_completion` for code changes.
- Do not invent `files_changed` paths or receipt context.
- If selection is unexpectedly empty, inspect the repo’s `.acm/acm-tests.yaml` selectors before forcing completion.
