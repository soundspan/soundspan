Propose durable memory through the context broker.

Arguments format:
JSON object:
`{"receipt_id":"...","category":"gotcha","subject":"...","content":"...","evidence_paths":["path/to/file.go"],"evidence_keys":["project:path#anchor"],"related_paths":["path/to/related.go"],"related_keys":["project:path"],"memory_tags":["backend"],"confidence":3,"auto_promote":true}`

Input: $ARGUMENTS

Steps:
1. Parse `$ARGUMENTS` as JSON with required `receipt_id`, `category`, `subject`, `content`, and at least one of `evidence_paths` or `evidence_keys`, plus optional `related_paths`, `related_keys`, `memory_tags`, `confidence`, and `auto_promote`.
2. Run `acm memory --receipt-id <receipt_id> --category <category> --subject <subject> --content <content>`, adding one `--evidence-path` per `evidence_paths` entry, one `--evidence-key` per `evidence_keys` entry, one `--related-path` per `related_paths` entry, one `--related-key` per `related_keys` entry, one `--memory-tag` per tag, `--confidence <n>` when provided, and `--auto-promote` when `auto_promote` is omitted or true.
3. Return the status (`pending|promoted|rejected`) and ids.

Constraints:
- Evidence must come from real governed files, indexed pointer keys, or exact fetched keys; do not invent evidence outside effective scope.
- Keep content concise and concrete.
