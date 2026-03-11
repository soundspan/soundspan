Record or execute a single review gate through the context broker.

Arguments format:
`<receipt_id-or-plan_key> [review-json]`

Input: $ARGUMENTS

Steps:
1. Parse the first argument into either `--plan-key` or `--receipt-id`.
2. Parse the optional JSON object.
3. If the JSON contains `run=true`, run `acm review --run` with the parsed identifier and any optional `tags_file`.
4. Otherwise map any supplied `key`, `summary`, `status`, `outcome`, `blocked_reason`, and `evidence` values onto the direct `acm review` flags and run the command.
5. Return the broker response exactly.

Constraints:
- `review` is intentionally thin and lowers to a single `work` task update.
- Defaults are `key=review:cross-llm`, `summary="Cross-LLM review"`, and `status=complete`.
- Use `{"run":true}` when the repo workflow defines a runnable review gate.
- Manual `status`, `outcome`, `blocked_reason`, and `evidence` fields are only for non-run mode.
