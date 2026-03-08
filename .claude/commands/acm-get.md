Use the context broker before any substantive execution.

Arguments format:
`[phase] <task text>`

If the first token is `plan`, `execute`, or `review`, use it as the phase. Otherwise default to `execute`.

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - optional `phase` (`plan|execute|review`, default `execute`)
   - `task_text`
2. Create a valid `acm.v1` CLI `get_context` request JSON using the parsed task text and phase, plus the active `project_id` (or omit it when `ACM_PROJECT_ID` / repo-root inference is already configured).
3. Validate request:
   - `acm validate --in <request.json>`
4. Run retrieval:
   - `acm run --in <request.json>`
5. Parse retrieval result:
   - If status is `insufficient_context`, refine task text and repeat retrieval once.
   - If status is `ok`, capture `receipt_id`.
   - Extract the `get_context` rules block (or rule pointers) and restate as hard MUST-follow rules.
   - Extract code/doc/test pointers and label them as advisory suggestions.
6. If plan/work contract artifacts are needed, build a `fetch` request with `receipt_id` shorthand first (add explicit `keys` only when targeting specific artifacts) and run:
   - `acm validate --in <fetch-request.json>`
   - `acm run --in <fetch-request.json>`
7. Return a structured summary with `receipt_id`, hard rules, advisory pointers, and fetched artifacts.

Constraints:
- Do not skip retrieval.
- Do not downgrade hard rules into suggestions.
- Do not present code pointers as hard edit boundaries.
- Include the final `receipt_id` in output.
