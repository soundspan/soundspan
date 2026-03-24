#!/bin/bash
# Stop hook: remind about ACM completion when a receipt-tracked session
# has unreported edits. Only guards sessions that opted into ACM (have a
# receipt). Trivial sessions without a receipt can stop freely.

set -euo pipefail

INPUT=$(cat)
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

if [ "$HOOK_EVENT" != "Stop" ] || [ -z "$SESSION_ID" ] || [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

STATE_DIR="/tmp/.acm-claude-soundspan-${SESSION_ID}"
RECEIPT_MARKER="${STATE_DIR}/receipt"
LEGACY_RECEIPT_MARKER="/tmp/.acm-receipt-soundspan-${SESSION_ID}"
EDITED_MARKER="${STATE_DIR}/edited"
REPORTED_MARKER="${STATE_DIR}/reported"

# Only guard sessions that have an ACM receipt (opted into the ceremony)
has_receipt=false
if [ -f "$RECEIPT_MARKER" ] || [ -f "$LEGACY_RECEIPT_MARKER" ]; then
  has_receipt=true
fi

if [ "$has_receipt" = false ]; then
  exit 0
fi

if [ ! -f "$EDITED_MARKER" ] || [ -f "$REPORTED_MARKER" ]; then
  exit 0
fi

reason="Stop blocked: this receipt-tracked session has file edits that have not been closed with acm done. Run /acm-verify for executable, config, contract, onboarding, or behavior changes, then finish with /acm-done before ending the task."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    decision: "block",
    reason: $reason
  }
}'
exit 0
