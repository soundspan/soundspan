Record a single review gate through the context broker.

Arguments format:
`<receipt_id-or-plan_key> [review-json]`

`review-json` may include:
`{"run":true}`

For non-run mode, `review-json` may instead include:
`{"key":"review:cross-llm","summary":"Cross-LLM review","status":"complete","outcome":"...","blocked_reason":"...","evidence":["..."]}`

Input: $ARGUMENTS

Steps:
1. Parse the first argument into either:
   - `plan_key` when it starts with `plan:`
   - otherwise `receipt_id`
2. Parse the optional `review` JSON object. If it is omitted, use an empty object so broker defaults apply.
3. Build valid `acm.v1` `review` JSON using the active `project_id` (or omit it when `ACM_PROJECT_ID` / repo-root inference is already configured).
4. Validate:
   - `acm validate --in <request.json>`
5. Execute:
   - `acm run --in <request.json>`
6. Return broker response exactly.

Constraints:
- `review` is intentionally thin and lowers to a single `work` task update.
- Defaults are `key=review:cross-llm`, `summary="Cross-LLM review"`, and `status=complete`.
- Use `{"run":true}` when the repo workflow defines a runnable review gate.
- Runnable review gates are terminal checks. ACM may skip the call when the current scoped fingerprint was already reviewed or when an explicitly configured `max_attempts` budget is exhausted.
- Use `status=blocked` plus `blocked_reason` when a review gate is waiting or failed.
- Use `evidence` as a JSON string array when you need supporting notes.
- Manual `status`, `outcome`, `blocked_reason`, and `evidence` fields are only for non-run mode.
