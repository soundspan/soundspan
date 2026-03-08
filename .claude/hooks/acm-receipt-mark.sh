#!/bin/bash
# PostToolUse hook: detect ACM task-loop commands and update session
# markers so the other Claude hooks can enforce the repo workflow.
#
# Fires after successful Bash tool calls. Tracks task-bearing
# `acm get-context`, `acm work`, `acm verify`, and `acm report-completion`
# invocations across direct CLI, `acm run --in <request.json>`, and
# `acm-mcp invoke --tool ...` forms.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -z "$SESSION_ID" ] || [ "$HOOK_EVENT" != "PostToolUse" ] || [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STATE_DIR="/tmp/.acm-claude-{{project_id}}-${SESSION_ID}"
RECEIPT_MARKER="${STATE_DIR}/receipt"
LEGACY_RECEIPT_MARKER="/tmp/.acm-receipt-{{project_id}}-${SESSION_ID}"

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

is_task_get_context_command() {
  local command="$1"
  echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+get-context([[:space:]]|$)' || return 1
  echo "$command" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)' && return 1
  echo "$command" | grep -qE '(^|[[:space:]])--task-(text|file)(=|[[:space:]])'
}

is_direct_work_command() {
  local command="$1"
  echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+work([[:space:]]|$)' || return 1
  ! echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+work[[:space:]]+(list|search)([[:space:]]|$)'
}

is_direct_verify_command() {
  local command="$1"
  echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+verify([[:space:]]|$)'
}

is_direct_report_command() {
  local command="$1"
  echo "$command" | grep -qE '(^|[[:space:]])acm[[:space:]]+report-completion([[:space:]]|$)'
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

request_declares_command() {
  local input_path="$1"
  local command_name="$2"
  [ -n "$input_path" ] || return 1
  [ -f "$input_path" ] || return 1
  grep -qE "\"command\"[[:space:]]*:[[:space:]]*\"${command_name}\"" "$input_path"
}

is_mcp_tool_command() {
  local command="$1"
  local tool_name="$2"
  echo "$command" | grep -qE '(^|[[:space:]])acm-mcp[[:space:]]+invoke([[:space:]]|$)' || return 1
  echo "$command" | grep -qE "(^|[[:space:]])--tool(=|[[:space:]])${tool_name}([[:space:]]|$)"
}

mark_receipt() {
  ensure_state_dir
  touch "$RECEIPT_MARKER" "$LEGACY_RECEIPT_MARKER"
  rm -f "${STATE_DIR}/work" "${STATE_DIR}/verified" "${STATE_DIR}/reported"
}

mark_work() {
  ensure_state_dir
  touch "${STATE_DIR}/work"
}

mark_verified() {
  ensure_state_dir
  touch "${STATE_DIR}/verified"
}

mark_reported() {
  ensure_state_dir
  touch "${STATE_DIR}/reported"
  rm -f "${STATE_DIR}/edited" "${STATE_DIR}/verified" "${STATE_DIR}/work" "${STATE_DIR}/files.txt"
}

should_mark_receipt=false
should_mark_work=false
should_mark_verified=false
should_mark_reported=false

if is_task_get_context_command "$COMMAND"; then
  should_mark_receipt=true
elif echo "$COMMAND" | grep -qE '(^|[[:space:]])acm[[:space:]]+run([[:space:]]|$)'; then
  INPUT_PATH=$(extract_acm_input_path "$COMMAND")
  request_declares_command "$INPUT_PATH" "get_context" && should_mark_receipt=true
  request_declares_command "$INPUT_PATH" "work" && should_mark_work=true
  request_declares_command "$INPUT_PATH" "verify" && should_mark_verified=true
  request_declares_command "$INPUT_PATH" "report_completion" && should_mark_reported=true
fi

is_mcp_tool_command "$COMMAND" "get_context" && should_mark_receipt=true
is_mcp_tool_command "$COMMAND" "work" && should_mark_work=true
is_mcp_tool_command "$COMMAND" "verify" && should_mark_verified=true
is_mcp_tool_command "$COMMAND" "report_completion" && should_mark_reported=true

is_direct_work_command "$COMMAND" && should_mark_work=true
is_direct_verify_command "$COMMAND" && should_mark_verified=true
is_direct_report_command "$COMMAND" && should_mark_reported=true

[ "$should_mark_receipt" = true ] && mark_receipt
[ "$should_mark_work" = true ] && mark_work
[ "$should_mark_verified" = true ] && mark_verified
[ "$should_mark_reported" = true ] && mark_reported

exit 0
