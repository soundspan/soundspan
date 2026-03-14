Run repo-defined executable verification through the context broker.

Arguments format:
`<receipt_id-or-plan_key> [comma-separated-files] [phase]`

Input: $ARGUMENTS

Steps:
1. Parse the first argument into either `--plan-key` or `--receipt-id`.
2. If the second argument is present and is one of `plan`, `execute`, or `review`, treat it as `--phase` and omit explicit changed files.
3. Otherwise split the second argument into repeated `--file-changed` flags when it is present.
4. If a third argument is present, treat it as `--phase`; otherwise let ACM default the phase.
5. Run `acm verify` with the parsed identifiers and any explicit changed files.
6. Return the verify result exactly, including selected tests and statuses.

Constraints:
- Use `verify` before `done` for code changes.
- Do not invent `files_changed` paths or receipt context.
- When receipt baseline detection is unavailable and changed-path selectors matter, pass files explicitly instead of assuming ACM can infer them.
- In soundspan, backend verify is receipt-scoped and targeted; use `/acm-review` to trigger the promoted full backend `build` + `test:coverage` gate before `/acm-done`.
- If selection is unexpectedly empty, inspect the repo's `.acm/acm-tests.yaml` selectors before forcing completion.
