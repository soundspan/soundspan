Propose durable memory through the context broker after the get_context/fetch/work/report loop.

Arguments format:
`<receipt_id> <category> <subject> <content>`

Input: $ARGUMENTS

Steps:
1. Parse arguments into:
   - `receipt_id`
   - `category` (decision|gotcha|pattern|preference)
   - `subject`
   - `content`
2. Build valid `acm.v1` `propose_memory` JSON with:
   - reasonable tags
   - confidence (default 3 if unknown)
   - evidence pointer keys from the active receipt scope
   - `auto_promote=true`
3. Validate:
   - `acm validate --in <request.json>`
4. Execute:
   - `acm run --in <request.json>`
5. Return status (`pending|promoted|rejected`) and ids.

Constraints:
- Do not invent evidence pointers outside receipt scope.
- Keep content concise and concrete.
