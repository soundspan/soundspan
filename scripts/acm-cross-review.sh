#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run the repo-local cross-LLM review gate for soundspan.

Usage:
  scripts/acm-cross-review.sh [--provider <codex|claude>] [--model <model>] [--reasoning-effort <level>] [--sandbox <mode>] [--yolo] [--dangerously-skip-permissions]

Notes:
  --yolo is the shared high-trust shortcut. For Codex it passes native --yolo;
  for Claude it enables --dangerously-skip-permissions.

Cheat sheet:
  Codex default sandboxed review:
    scripts/acm-cross-review.sh --provider codex --sandbox read-only
  Codex high-trust review in an already isolated container:
    scripts/acm-cross-review.sh --provider codex --model gpt-5.3-codex --reasoning-effort high --yolo
  Claude default print-mode review:
    scripts/acm-cross-review.sh --provider claude --model sonnet
  Claude high-trust review in an already isolated container:
    scripts/acm-cross-review.sh --provider claude --model sonnet --yolo

Environment:
  ACM_PROJECT_ID
  ACM_PROJECT_ROOT
  ACM_RECEIPT_ID
  ACM_PLAN_KEY
  ACM_REVIEW_KEY
  ACM_REVIEW_SUMMARY
  ACM_WORKFLOW_SOURCE_PATH
  ACM_CROSS_REVIEW_PROVIDER
  ACM_CROSS_REVIEW_MODEL
  ACM_CROSS_REVIEW_REASONING_EFFORT
  ACM_CROSS_REVIEW_SANDBOX
  ACM_CROSS_REVIEW_YOLO
  ACM_CROSS_REVIEW_DANGEROUSLY_SKIP_PERMISSIONS
  ACM_REVIEW_BASELINE_CAPTURED
  ACM_REVIEW_EFFECTIVE_SCOPE_PATHS_JSON
  ACM_REVIEW_CHANGED_PATHS_JSON
  ACM_REVIEW_TASK_DELTA_SOURCE
USAGE
}

die_usage() {
  printf '%s\n\n' "$1" >&2
  usage >&2
  exit 2
}

require_flag_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "${value}" ]]; then
    die_usage "missing value for ${flag}"
  fi
}

normalize_bool() {
  local value="${1:-}"
  case "${value,,}" in
    1|true|yes|on)
      printf 'true\n'
      ;;
    *)
      printf 'false\n'
      ;;
  esac
}

default_provider="codex"
default_codex_model="gpt-5.3-codex"
default_claude_model=""
default_reasoning_effort="xhigh"
default_codex_sandbox="read-only"
reasoning_effort_explicit=false
sandbox_explicit=false
dangerously_skip_permissions_explicit=false
if [[ -n "${ACM_CROSS_REVIEW_REASONING_EFFORT:-}" ]]; then
  reasoning_effort_explicit=true
fi
if [[ -n "${ACM_CROSS_REVIEW_SANDBOX:-}" ]]; then
  sandbox_explicit=true
fi
if [[ "$(normalize_bool "${ACM_CROSS_REVIEW_DANGEROUSLY_SKIP_PERMISSIONS:-false}")" == "true" ]]; then
  dangerously_skip_permissions_explicit=true
fi
review_provider="${ACM_CROSS_REVIEW_PROVIDER:-${default_provider}}"
review_model="${ACM_CROSS_REVIEW_MODEL:-}"
review_reasoning_effort="${ACM_CROSS_REVIEW_REASONING_EFFORT:-${default_reasoning_effort}}"
review_sandbox="${ACM_CROSS_REVIEW_SANDBOX:-${default_codex_sandbox}}"
review_yolo="$(normalize_bool "${ACM_CROSS_REVIEW_YOLO:-false}")"
review_dangerously_skip_permissions="$(normalize_bool "${ACM_CROSS_REVIEW_DANGEROUSLY_SKIP_PERMISSIONS:-false}")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --model)
      require_flag_value "$1" "${2:-}"
      review_model="$2"
      shift 2
      ;;
    --provider)
      require_flag_value "$1" "${2:-}"
      review_provider="$2"
      shift 2
      ;;
    --reasoning|--reasoning-effort)
      require_flag_value "$1" "${2:-}"
      review_reasoning_effort="$2"
      reasoning_effort_explicit=true
      shift 2
      ;;
    --sandbox)
      require_flag_value "$1" "${2:-}"
      review_sandbox="$2"
      sandbox_explicit=true
      shift 2
      ;;
    --yolo)
      review_yolo=true
      shift
      ;;
    --dangerously-skip-permissions)
      review_dangerously_skip_permissions=true
      dangerously_skip_permissions_explicit=true
      shift
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
done

case "${review_provider}" in
  codex)
    if [[ -z "${review_model}" ]]; then
      review_model="${default_codex_model}"
    fi
    if [[ "${dangerously_skip_permissions_explicit}" == "true" ]]; then
      die_usage "--dangerously-skip-permissions is only supported with --provider claude"
    fi
    ;;
  claude)
    if [[ -z "${review_model}" ]]; then
      review_model="${default_claude_model}"
    fi
    if [[ "${sandbox_explicit}" == "true" ]]; then
      die_usage "--sandbox is only supported with --provider codex"
    fi
    if [[ "${reasoning_effort_explicit}" == "true" ]]; then
      die_usage "--reasoning-effort is only supported with --provider codex"
    fi
    ;;
  *)
    die_usage "unsupported provider: ${review_provider}"
    ;;
esac

reviewer_cli="${review_provider}"
if ! command -v "${reviewer_cli}" >/dev/null 2>&1; then
  echo "${reviewer_cli} CLI is required for scripts/acm-cross-review.sh" >&2
  exit 127
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required for scripts/acm-cross-review.sh" >&2
  exit 127
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for scripts/acm-cross-review.sh" >&2
  exit 127
fi
if ! command -v acm >/dev/null 2>&1; then
  echo "acm CLI is required for scripts/acm-cross-review.sh" >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
REPO_ROOT="${ACM_PROJECT_ROOT:-}"
if [[ -z "${REPO_ROOT}" ]]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

schema_path="${tmp_dir}/review-schema.json"
output_path="${tmp_dir}/review-result.json"
prompt_path="${tmp_dir}/review-prompt.txt"
changed_files_path="${tmp_dir}/changed-files.txt"
diff_summary_path="${tmp_dir}/diff-summary.txt"
review_diff_path="${tmp_dir}/review-diff.txt"
diff_prompt_path="${tmp_dir}/review-diff-prompt.txt"
reviewer_stdout_path="${tmp_dir}/reviewer-stdout.txt"
reviewer_stderr_path="${tmp_dir}/reviewer-stderr.txt"
receipt_fetch_path="${tmp_dir}/receipt-fetch.json"
plan_fetch_path="${tmp_dir}/plan-fetch.json"
effective_scope_paths_path="${tmp_dir}/effective-scope-paths.txt"
tracked_scope_path="${tmp_dir}/tracked-scope-paths.txt"
untracked_scope_path="${tmp_dir}/untracked-scope-paths.txt"
provided_changed_paths_json="${ACM_REVIEW_CHANGED_PATHS_JSON:-}"
provided_effective_scope_json="${ACM_REVIEW_EFFECTIVE_SCOPE_PATHS_JSON:-}"
repo_changed_count=0
scoped_changed_count=0

cat >"${schema_path}" <<'JSON'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "summary", "findings"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["pass", "fail"]
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1600
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1600
      },
      "maxItems": 20
    }
  }
}
JSON

receipt_id="${ACM_RECEIPT_ID:-}"
if [[ -z "${receipt_id}" && "${ACM_PLAN_KEY:-}" == plan:* ]]; then
  receipt_id="${ACM_PLAN_KEY#plan:}"
fi
active_plan_key="${ACM_PLAN_KEY:-}"
if [[ -z "${active_plan_key}" && -n "${receipt_id}" ]]; then
  active_plan_key="plan:${receipt_id}"
fi

if [[ -z "${ACM_PROJECT_ID:-}" || -z "${receipt_id}" ]]; then
  echo "ACM_PROJECT_ID and ACM_RECEIPT_ID (or plan:<receipt_id>) are required for receipt-scoped review" >&2
  exit 2
fi

if git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  untracked_changed="$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard 2>/dev/null || true)"
  if [[ -n "${provided_effective_scope_json}" ]]; then
    python3 - "${provided_effective_scope_json}" "${effective_scope_paths_path}" <<'PY'
import json
import sys

raw_scope, output_path = sys.argv[1], sys.argv[2]

try:
    decoded = json.loads(raw_scope)
except json.JSONDecodeError:
    decoded = []
if not isinstance(decoded, list):
    decoded = []

paths = []
for path in decoded:
    if isinstance(path, str):
        normalized = path.strip()
        if normalized:
            paths.append(normalized)

with open(output_path, "w", encoding="utf-8") as handle:
    for path in sorted(dict.fromkeys(paths)):
        handle.write(path + "\n")
PY
  else
    ACM_LOG_SINK=discard acm fetch \
      --project "${ACM_PROJECT_ID}" \
      --key "receipt:${receipt_id}" >"${receipt_fetch_path}"
    : >"${plan_fetch_path}"
    if [[ -n "${active_plan_key}" ]]; then
      if ! ACM_LOG_SINK=discard acm fetch \
        --project "${ACM_PROJECT_ID}" \
        --key "${active_plan_key}" >"${plan_fetch_path}" 2>/dev/null; then
        : >"${plan_fetch_path}"
      fi
    fi

    python3 - "${receipt_fetch_path}" "${plan_fetch_path}" "${effective_scope_paths_path}" <<'PY'
import json
import sys

receipt_fetch_path, plan_fetch_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]


def fetch_items(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read().strip()
    if not raw:
        return []
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return envelope.get("result", {}).get("items", [])


def decode_content(item):
    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        return {}
    try:
        decoded = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


receipt_scope = []
for item in fetch_items(receipt_fetch_path):
    receipt = decode_content(item)
    initial_scope = receipt.get("initial_scope_paths", [])
    if isinstance(initial_scope, list):
        receipt_scope = [path.strip() for path in initial_scope if isinstance(path, str) and path.strip()]
    if receipt_scope:
        break

effective_scope = list(receipt_scope)
for item in fetch_items(plan_fetch_path):
    plan = decode_content(item)
    discovered_paths = plan.get("discovered_paths", [])
    if not isinstance(discovered_paths, list):
        continue
    for path in discovered_paths:
        if isinstance(path, str) and path.strip():
            effective_scope.append(path.strip())

with open(output_path, "w", encoding="utf-8") as handle:
    for path in sorted(dict.fromkeys(effective_scope)):
        handle.write(path + "\n")
PY
  fi

  if [[ -n "${provided_changed_paths_json}" ]]; then
    python3 - "${provided_changed_paths_json}" "${changed_files_path}" <<'PY'
import json
import sys

raw_changed, output_path = sys.argv[1], sys.argv[2]

try:
    decoded = json.loads(raw_changed)
except json.JSONDecodeError:
    decoded = []
if not isinstance(decoded, list):
    decoded = []

paths = []
for path in decoded:
    if isinstance(path, str):
        normalized = path.strip()
        if normalized:
            paths.append(normalized)

with open(output_path, "w", encoding="utf-8") as handle:
    for path in sorted(dict.fromkeys(paths)):
        handle.write(path + "\n")
PY
  else
    tracked_changed="$(git -C "${REPO_ROOT}" diff --name-only --diff-filter=ACDMRTUXB HEAD -- 2>/dev/null || true)"
    {
      printf '%s\n' "${tracked_changed}"
      printf '%s\n' "${untracked_changed}"
    } | awk 'NF && !seen[$0]++' >"${changed_files_path}"
  fi
  repo_changed_count="$(grep -c '.' "${changed_files_path}" || true)"

  python3 - "${changed_files_path}" "${effective_scope_paths_path}" <<'PY' >"${tmp_dir}/changed-files-scoped.txt"
import sys

changed_path, scope_path = sys.argv[1], sys.argv[2]
completion_managed_paths = {
    ".acm/acm-rules.yaml",
    ".acm/acm-tags.yaml",
    ".acm/acm-tests.yaml",
    ".acm/acm-workflows.yaml",
    ".acm/init_candidates.json",
    ".env.example",
    ".gitignore",
    "acm-rules.yaml",
    "acm-tests.yaml",
    "acm-workflows.yaml",
}


def normalize(path):
    return path.strip().rstrip("/")


with open(scope_path, "r", encoding="utf-8") as handle:
    scope = [normalized for line in handle if (normalized := normalize(line))]


def within_scope(path):
    normalized_path = normalize(path)
    if not normalized_path:
        return False
    if normalized_path in completion_managed_paths:
        return True
    for scope_entry in scope:
        if normalized_path == scope_entry or normalized_path.startswith(scope_entry + "/"):
            return True
    return False


with open(changed_path, "r", encoding="utf-8") as handle:
    for line in handle:
        path = normalize(line)
        if within_scope(path):
            print(path)
PY
  mv "${tmp_dir}/changed-files-scoped.txt" "${changed_files_path}"
  scoped_changed_count="$(grep -c '.' "${changed_files_path}" || true)"

  unscoped_changed_count=$(( repo_changed_count - scoped_changed_count ))

  if (( repo_changed_count > 0 && scoped_changed_count == 0 )); then
    printf 'FAIL: Review gate blocked before model execution: %s changed file(s), %s scoped change(s). Rerun acm context with broader known scope or declare missing files through acm work before rerunning acm review.\n' "${repo_changed_count}" "${scoped_changed_count}"
    exit 1
  fi
  if (( unscoped_changed_count > 0 )); then
    printf 'FAIL: Review gate blocked before model execution: %s changed file(s), %s scoped change(s), %s unscoped change(s). Declare the missing files through acm work or start a broader context before rerunning acm review.\n' "${repo_changed_count}" "${scoped_changed_count}" "${unscoped_changed_count}"
    exit 1
  fi

  : >"${tracked_scope_path}"
  : >"${untracked_scope_path}"
  if [[ -s "${changed_files_path}" ]]; then
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      if grep -Fqx "${file_path}" <<<"${untracked_changed}"; then
        printf '%s\n' "${file_path}" >>"${untracked_scope_path}"
      else
        printf '%s\n' "${file_path}" >>"${tracked_scope_path}"
      fi
    done <"${changed_files_path}"
  fi

  : >"${diff_summary_path}"
  : >"${review_diff_path}"
  if [[ -s "${tracked_scope_path}" ]]; then
    mapfile -t tracked_scope_paths <"${tracked_scope_path}"
    git -C "${REPO_ROOT}" diff --stat --no-ext-diff --find-renames HEAD -- "${tracked_scope_paths[@]}" >"${diff_summary_path}" 2>/dev/null || true
    git -C "${REPO_ROOT}" diff --no-ext-diff --no-color --unified=3 --find-renames HEAD -- "${tracked_scope_paths[@]}" >"${review_diff_path}" 2>/dev/null || true
  fi
  if [[ -s "${untracked_scope_path}" ]]; then
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      printf ' %s | new file\n' "${file_path}" >>"${diff_summary_path}"
      git -C "${REPO_ROOT}" diff --no-index --no-color --unified=3 -- /dev/null "${REPO_ROOT}/${file_path}" >>"${review_diff_path}" 2>/dev/null || true
    done <"${untracked_scope_path}"
  fi
else
  : >"${changed_files_path}"
  : >"${diff_summary_path}"
  : >"${review_diff_path}"
fi

diff_char_limit=160000
if [[ -s "${review_diff_path}" ]] && (( $(wc -c <"${review_diff_path}") > diff_char_limit )); then
  {
    echo "[truncated unified diff]"
    head -c "${diff_char_limit}" "${review_diff_path}"
    echo
  } >"${diff_prompt_path}"
else
  cp "${review_diff_path}" "${diff_prompt_path}"
fi

cat >"${prompt_path}" <<EOF
Review the current task-scoped uncommitted changes in the repository at ${REPO_ROOT}.

You are the cross-LLM review gate for ACM. This review is read-only, must not modify files by any means, and blocks completion if there are real issues.

Changed files:
$(if [[ -s "${changed_files_path}" ]]; then cat "${changed_files_path}"; else echo "(no changed files detected)"; fi)

Diff summary:
$(if [[ -s "${diff_summary_path}" ]]; then cat "${diff_summary_path}"; else echo "(no diff summary available)"; fi)

Scope counts:
- changed_detected: ${repo_changed_count}
- scoped_changed: ${scoped_changed_count}

Instructions:
- Start by reading AGENTS.md and .acm/acm-workflows.yaml when present.
- Do not modify, create, delete, rename, stage, or overwrite files, and do not use any command, tool, or redirection that writes to the filesystem; if an action would change files by any means, do not do it.
- Treat the review scope as the active effective scope: receipt 'initial_scope_paths', any 'plan.discovered_paths', plus ACM-managed governance files already allowed by completion reporting.
- Review only the changed files listed above. Open a changed file or run local diff commands for those paths only when the diff summary suggests a plausible blocking risk, and do not roam through unrelated files.
- Keep the investigation tight: after the initial AGENTS/workflow reads, use at most 8 additional read-only commands before deciding pass/fail.
- Focus on blocking issues only: correctness bugs, regressions, broken command semantics, contract/schema drift, CLI/MCP parity gaps, workflow-gate mistakes, missing verification coverage, or docs/examples/skills drift that would mislead users.
- Ignore nits, style preferences, and speculative concerns.
- If there are no blocking issues, set status to "pass" and return an empty findings array.
- If there is any blocking issue, set status to "fail" and list only blocking findings.
- Include file references in findings when possible.
- Return JSON only that matches the provided schema.

Context:
- project_id: ${ACM_PROJECT_ID:-}
- receipt_id: ${receipt_id}
- plan_key: ${active_plan_key}
- review_key: ${ACM_REVIEW_KEY:-review:cross-llm}
- review_summary: ${ACM_REVIEW_SUMMARY:-Cross-LLM review}
- workflow_source_path: ${ACM_WORKFLOW_SOURCE_PATH:-.acm/acm-workflows.yaml}
EOF

reviewer_args=()
if [[ "${review_provider}" == "codex" ]]; then
  reviewer_args=(
    exec
  )
  if [[ -n "${review_model}" ]]; then
    reviewer_args+=(--model "${review_model}")
  fi
  reviewer_args+=(
    -c "model_reasoning_effort=\"${review_reasoning_effort}\""
  )
  if [[ "${review_yolo}" == "true" ]]; then
    reviewer_args+=(--yolo)
  else
    reviewer_args+=(--sandbox "${review_sandbox}")
  fi
  reviewer_args+=(
    --ephemeral
    -C "${REPO_ROOT}"
    --output-schema "${schema_path}"
    --output-last-message "${output_path}"
    -
  )
else
  reviewer_args=(
    -p
  )
  if [[ -n "${review_model}" ]]; then
    reviewer_args+=(--model "${review_model}")
  fi
  if [[ "${review_yolo}" == "true" || "${review_dangerously_skip_permissions}" == "true" ]]; then
    reviewer_args+=(--dangerously-skip-permissions)
  fi
  reviewer_args+=(
    --output-format json
    --json-schema "$(tr -d '\n' <"${schema_path}")"
  )
fi

reviewer_exit_code=0
if [[ "${review_provider}" == "codex" ]]; then
  mkdir -p "${tmp_dir}/codex-cache"
  # Preserve the user's Codex home so auth/config remain available, but isolate cache/tmp writes.
  XDG_CACHE_HOME="${tmp_dir}/codex-cache" \
  TMPDIR="${tmp_dir}" \
  "${reviewer_cli}" "${reviewer_args[@]}" >"${reviewer_stdout_path}" 2>"${reviewer_stderr_path}" <"${prompt_path}" || reviewer_exit_code=$?
else
  TMPDIR="${tmp_dir}" \
  "${reviewer_cli}" "${reviewer_args[@]}" <"${prompt_path}" >"${reviewer_stdout_path}" 2>"${reviewer_stderr_path}" || reviewer_exit_code=$?
fi

if [[ ! -s "${output_path}" ]]; then
  if python3 - "${reviewer_stdout_path}" "${reviewer_stderr_path}" "${output_path}" <<'PY'
import json
import sys

stdout_path, stderr_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

def load_candidates(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read().strip()
    if not raw:
        return []
    candidates = [raw]
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            candidates.append(line)
    return candidates

for candidate_path in (stdout_path, stderr_path):
    for candidate in load_candidates(candidate_path):
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
        raise SystemExit(0)

raise SystemExit(1)
PY
  then
    :
  fi
fi

if [[ ! -s "${output_path}" ]]; then
  if [[ -s "${reviewer_stdout_path}" ]]; then
    tail -n 80 "${reviewer_stdout_path}" >&2 || cat "${reviewer_stdout_path}" >&2
  fi
  if [[ -s "${reviewer_stderr_path}" ]]; then
    tail -n 80 "${reviewer_stderr_path}" >&2 || cat "${reviewer_stderr_path}" >&2
  fi
  if (( reviewer_exit_code != 0 )); then
    printf 'FAIL: %s review did not produce structured output (exit %s).\n' "${review_provider}" "${reviewer_exit_code}" >&2
    exit "${reviewer_exit_code}"
  fi
  printf 'FAIL: %s review produced no structured output.\n' "${review_provider}" >&2
  exit 1
fi

python3 - "${output_path}" "${repo_changed_count}" "${scoped_changed_count}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

status = payload["status"]
summary = payload["summary"].strip()
findings = [item.strip() for item in payload.get("findings", []) if item.strip()]

if status == "pass":
    print(f"PASS: {summary} (scoped {sys.argv[3]}/{sys.argv[2]} changed files)")
    sys.exit(0)

print(f"FAIL: {summary} (scoped {sys.argv[3]}/{sys.argv[2]} changed files)")
for index, finding in enumerate(findings, start=1):
    print(f"{index}. {finding}")
sys.exit(1)
PY
