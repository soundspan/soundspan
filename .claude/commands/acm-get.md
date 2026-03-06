Use the context broker before any substantive execution.

Task text: $ARGUMENTS

Steps:
1. Create a valid `acm.v1` CLI `get_context` request JSON using task text `$ARGUMENTS`, phase `execute`, and the active `project_id`.
2. Validate request:
   - `acm validate --in <request.json>`
3. Run retrieval:
   - `acm run --in <request.json>`
4. Parse retrieval result:
   - If status is `insufficient_context`, refine task text and repeat retrieval once.
   - If status is `ok`, capture `receipt_id`.
   - Extract the `get_context` rules block (or rule pointers) and restate as hard MUST-follow rules.
   - Extract code/doc/test pointers and label them as advisory suggestions.
5. If plan/work contract artifacts are needed, build a `fetch` request with `receipt_id` shorthand first (add explicit `keys` only when targeting specific artifacts) and run:
   - `acm validate --in <fetch-request.json>`
   - `acm run --in <fetch-request.json>`
6. Return a structured summary with `receipt_id`, hard rules, advisory pointers, and fetched artifacts.

Constraints:
- Do not skip retrieval.
- Do not downgrade hard rules into suggestions.
- Do not present code pointers as hard edit boundaries.
- Include the final `receipt_id` in output.
