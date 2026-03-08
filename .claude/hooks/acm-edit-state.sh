#!/bin/bash
# PostToolUse hook: record edited files so other hooks can enforce work/report flow.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -z "$SESSION_ID" ] || [ "$HOOK_EVENT" != "PostToolUse" ]; then
  exit 0
fi

case "$TOOL_NAME" in
  Edit|MultiEdit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

STATE_DIR="/tmp/.acm-claude-{{project_id}}-${SESSION_ID}"
FILES_TRACKER="${STATE_DIR}/files.txt"
TARGET_FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

mkdir -p "$STATE_DIR"
touch "${STATE_DIR}/edited"
rm -f "${STATE_DIR}/verified" "${STATE_DIR}/reported"

if [ -n "$TARGET_FILE" ]; then
  touch "$FILES_TRACKER"
  if ! grep -Fxq "$TARGET_FILE" "$FILES_TRACKER"; then
    printf '%s\n' "$TARGET_FILE" >> "$FILES_TRACKER"
  fi
fi

exit 0
