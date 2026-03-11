#!/bin/bash
# Stop hook: prevent Claude from ending the session while tracked edits
# are still missing ACM completion reporting.

set -euo pipefail

INPUT=$(cat)
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

if [ "$HOOK_EVENT" != "Stop" ] || [ -z "$SESSION_ID" ] || [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

STATE_DIR="/tmp/.acm-claude-soundspan-${SESSION_ID}"
EDITED_MARKER="${STATE_DIR}/edited"
REPORTED_MARKER="${STATE_DIR}/reported"
WORK_MARKER="${STATE_DIR}/work"
FILES_TRACKER="${STATE_DIR}/files.txt"

if [ ! -f "$EDITED_MARKER" ] || [ -f "$REPORTED_MARKER" ]; then
  exit 0
fi

reason="Stop blocked: this session has file edits that have not been closed with acm done."
if [ ! -f "$WORK_MARKER" ] && [ -f "$FILES_TRACKER" ]; then
  line_count=$(grep -c '.' "$FILES_TRACKER" || true)
  if [ "${line_count}" -gt 1 ]; then
    reason="${reason} Create or update /acm-work before continuing multi-file work."
  fi
fi
reason="${reason} Run /acm-verify for executable, config, contract, onboarding, or behavior changes, then finish with /acm-done before ending the task."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    decision: "block",
    reason: $reason
  }
}'
exit 0
