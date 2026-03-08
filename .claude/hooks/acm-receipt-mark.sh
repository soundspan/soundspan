#!/bin/bash
# PostToolUse hook: detect successful ACM context retrieval and create
# a session-scoped marker file so the PreToolUse guard allows edits.
#
# Fires after successful Bash tool calls. Creates the marker when the
# command is a task-bearing `acm get-context` invocation or
# `acm run --in <request.json>` for a `get_context` request.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -z "$SESSION_ID" ] || [ "$HOOK_EVENT" != "PostToolUse" ] || [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

is_task_get_context_command() {
  local command="$1"
  echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+get-context([[:space:]]|$)' || return 1
  echo "$command" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)' && return 1
  echo "$command" | grep -qE '(^|[[:space:]])--task-(text|file)(=|[[:space:]])'
}

extract_acm_input_path() {
  local command="$1"
  local candidate=""

  if [[ "$command" =~ --in=([^[:space:]]+) ]]; then
    candidate="${BASH_REMATCH[1]}"
  elif [[ "$command" =~ --in[[:space:]]+([^[:space:]]+) ]]; then
    candidate="${BASH_REMATCH[1]}"
  fi

  candidate="${candidate%\"}"
  candidate="${candidate#\"}"
  candidate="${candidate%\'}"
  candidate="${candidate#\'}"
  printf '%s\n' "$candidate"
}

request_declares_get_context() {
  local input_path="$1"
  [ -n "$input_path" ] || return 1
  [ -f "$input_path" ] || return 1
  grep -qE '"command"[[:space:]]*:[[:space:]]*"get_context"' "$input_path"
}

should_mark=false
if is_task_get_context_command "$COMMAND"; then
  should_mark=true
elif echo "$COMMAND" | grep -qE '(^|[[:space:]])acm[[:space:]]+run([[:space:]]|$)'; then
  INPUT_PATH=$(extract_acm_input_path "$COMMAND")
  if request_declares_get_context "$INPUT_PATH"; then
    should_mark=true
  fi
fi

if [ "$should_mark" = true ]; then
  MARKER="/tmp/.acm-receipt-soundspan-${SESSION_ID}"
  touch "$MARKER"
fi

exit 0
