#!/bin/bash
# SessionStart/UserPromptSubmit hook: keep the ACM task loop visible in Claude.

set -euo pipefail

INPUT=$(cat)
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$HOOK_EVENT" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

STATE_DIR="/tmp/.acm-claude-soundspan-${SESSION_ID}"
RECEIPT_MARKER="${STATE_DIR}/receipt"
LEGACY_RECEIPT_MARKER="/tmp/.acm-receipt-soundspan-${SESSION_ID}"
WORK_MARKER="${STATE_DIR}/work"
EDITED_MARKER="${STATE_DIR}/edited"
REPORTED_MARKER="${STATE_DIR}/reported"
FILES_TRACKER="${STATE_DIR}/files.txt"

append_line() {
  local line="$1"
  if [ -z "${MESSAGE:-}" ]; then
    MESSAGE="$line"
  else
    MESSAGE="${MESSAGE}
$line"
  fi
}

has_receipt=false
if [ -f "$RECEIPT_MARKER" ] || [ -f "$LEGACY_RECEIPT_MARKER" ]; then
  has_receipt=true
fi

needs_work=false
if [ ! -f "$WORK_MARKER" ] && [ -f "$FILES_TRACKER" ]; then
  line_count=$(grep -c '.' "$FILES_TRACKER" || true)
  if [ "${line_count}" -gt 1 ]; then
    needs_work=true
  fi
fi

MESSAGE=""

if [ "$HOOK_EVENT" = "SessionStart" ]; then
  append_line "Repo contract reminder: read AGENTS.md first. CLAUDE.md only maps Claude onto that contract."
  append_line "For non-trivial work (multi-step, multi-file, or governed), start with /acm-context [phase] <task>. Trivial single-file fixes can skip the ACM ceremony."
  append_line "Once work becomes multi-step or multi-file, create or update /acm-work. Use /acm-review {\"run\":true} when the workflow gate defines a runnable review task."
  append_line "Before ending executable, config, contract, onboarding, or behavior changes, run /acm-verify, then close the task with /acm-done."
fi

if [ "$has_receipt" = false ]; then
  append_line "No ACM receipt for this session. For non-trivial work, run /acm-context [phase] <task> first."
fi

if [ "$needs_work" = true ]; then
  append_line "This session has already touched multiple files without /acm-work tracking. Create or update /acm-work before continuing broad edits."
fi

if [ -f "$EDITED_MARKER" ] && [ ! -f "$REPORTED_MARKER" ]; then
  append_line "This session has unreported edits. Run /acm-verify when the change is verify-sensitive, then finish with /acm-done before stopping."
fi

if [ -z "$MESSAGE" ]; then
  exit 0
fi

jq -n --arg event "$HOOK_EVENT" --arg context "$MESSAGE" '{
  hookSpecificOutput: {
    hookEventName: $event,
    additionalContext: $context
  }
}'
exit 0
