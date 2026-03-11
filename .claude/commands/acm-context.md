Use the context broker before any substantive execution.

Arguments format:
`[phase] <task text>`

If the first token is `plan`, `execute`, or `review`, use it as the phase. Otherwise default to `execute`.

Input: $ARGUMENTS

Steps:
1. Parse the optional phase plus the remaining `task_text`.
2. Run `acm context --phase <phase> --task-text "<task_text>"`.
3. Read the result, capture `receipt_id`, and restate the returned hard rules as non-optional constraints.
4. Summarize the active plans, durable memories, and any `initial_scope_paths`.
5. If a returned plan, task, memory, or pointer key actually needs to be hydrated, run `acm fetch --receipt-id <receipt_id>` first and add explicit `--key` flags only when you need a narrower fetch.
6. Return a structured summary with `receipt_id`, hard rules, active plans, durable memory, any known initial scope, and fetched artifacts.

Constraints:
- Do not skip the `acm context` call.
- Do not downgrade hard rules into optional guidance.
- Do not fabricate file scope. Use `/acm-work` to declare discovered paths when governed work expands beyond the initial receipt scope.
- Include the final `receipt_id` in output.
