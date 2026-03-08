Run retrieval evaluation through the context broker.

Arguments format:
`<eval-suite-path> [minimum-recall]`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - `eval_suite_path`
   - optional `minimum_recall`
2. Build valid `acm.v1` `eval` JSON using the active `project_id` (or omit it when `ACM_PROJECT_ID` / repo-root inference is already configured).
3. Validate:
   - `acm validate --in <request.json>`
4. Execute:
   - `acm run --in <request.json>`
5. Return the eval result exactly.

Constraints:
- Use `eval` for retrieval-quality checks, not executable code verification.
- Keep suite paths repository-relative.
