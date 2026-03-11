Close a task through the context broker.

Arguments format:
`<receipt_id-or-plan_key> [comma-separated-files] -- <outcome summary>`

If you want ACM to rely entirely on the baseline-derived delta, omit the file segment and keep the `--` separator before the outcome.

Input: $ARGUMENTS

Steps:
1. Split `$ARGUMENTS` on ` -- ` into a selector segment and the required `outcome` summary.
2. Parse the selector segment into `<receipt_id-or-plan_key>` plus an optional comma-separated changed-file list.
3. Determine whether the selector is a `--plan-key` or `--receipt-id`.
4. If file-backed work changed code and executable verification has not been run yet, stop and run `/acm-verify` first.
5. If the repo workflow requires an additional review task and it has not been recorded yet, stop and run `/acm-review` first.
6. Run `acm done` with the parsed identifier and `--outcome "<outcome>"`, adding repeated `--file-changed` flags only when explicit files were provided.
7. Return the broker response exactly.

Constraints:
- Prefer explicit changed files for file-backed work when you know them. If you omit them, ACM will compute the task delta from the receipt baseline.
- When you do supply changed files, ACM cross-checks them against the detected baseline delta instead of trusting them blindly.
- If the detected delta is empty, the closeout is effectively no-file.
- For code changes, do not call `done` before `verify`.
- When file-backed work expanded beyond the receipt's initial scope, declare those paths through `/acm-work` before calling `/acm-done`.
