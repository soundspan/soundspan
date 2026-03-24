#!/bin/bash
# PreToolUse hook: nudge ACM context for multi-file work and require
# /acm-work once the session has expanded into multi-file changes.
#
# Single-file edits are allowed without a receipt (trivial fixes).
# Multi-file edits without a receipt are blocked.
#
# Receipt markers are created automatically by the PostToolUse Bash hook
# (acm-receipt-mark.sh) when a successful acm context call is detected.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TARGET_FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

STATE_DIR="/tmp/.acm-claude-soundspan-${SESSION_ID}"
RECEIPT_MARKER="${STATE_DIR}/receipt"
LEGACY_RECEIPT_MARKER="/tmp/.acm-receipt-soundspan-${SESSION_ID}"
WORK_MARKER="${STATE_DIR}/work"
FILES_TRACKER="${STATE_DIR}/files.txt"

deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

has_receipt=false
if [ -f "$RECEIPT_MARKER" ] || [ -f "$LEGACY_RECEIPT_MARKER" ]; then
  has_receipt=true
fi

# If we have a receipt and work marker, allow everything
if [ "$has_receipt" = true ] && [ -f "$WORK_MARKER" ]; then
  exit 0
fi

# If no receipt: allow single-file edits, block multi-file
if [ "$has_receipt" = false ] && [ -f "$FILES_TRACKER" ] && [ -n "$TARGET_FILE" ]; then
  while IFS= read -r existing_file; do
    [ -n "$existing_file" ] || continue
    if [ "$existing_file" != "$TARGET_FILE" ]; then
      deny "Edit blocked: multi-file work needs an ACM receipt. Run /acm-context [phase] <task> first."
    fi
  done < "$FILES_TRACKER"
fi

# If we have a receipt but no work marker, check for multi-file expansion
if [ "$has_receipt" = true ] && [ ! -f "$WORK_MARKER" ] && [ -f "$FILES_TRACKER" ] && [ -n "$TARGET_FILE" ]; then
  while IFS= read -r existing_file; do
    [ -n "$existing_file" ] || continue
    if [ "$existing_file" != "$TARGET_FILE" ]; then
      deny "Edit blocked: this session is now multi-file. Run /acm-work <receipt_id-or-plan_key> <tasks-json> before continuing broad edits."
    fi
  done < "$FILES_TRACKER"
fi

exit 0
