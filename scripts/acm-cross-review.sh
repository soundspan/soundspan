#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run the repo-local cross-LLM review gate for ACM.

Usage:
  scripts/acm-cross-review.sh [--model <codex-model>] [--reasoning-effort <level>]

Environment:
  ACM_PROJECT_ID
  ACM_PROJECT_ROOT
  ACM_RECEIPT_ID
  ACM_PLAN_KEY
  ACM_REVIEW_KEY
  ACM_REVIEW_SUMMARY
  ACM_WORKFLOW_SOURCE_PATH
  ACM_CROSS_REVIEW_MODEL
  ACM_CROSS_REVIEW_REASONING_EFFORT
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

default_codex_model="gpt-5.3-codex"
default_reasoning_effort="xhigh"
codex_model="${ACM_CROSS_REVIEW_MODEL:-${default_codex_model}}"
codex_reasoning_effort="${ACM_CROSS_REVIEW_REASONING_EFFORT:-${default_reasoning_effort}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --model)
      require_flag_value "$1" "${2:-}"
      codex_model="$2"
      shift 2
      ;;
    --reasoning|--reasoning-effort)
      require_flag_value "$1" "${2:-}"
      codex_reasoning_effort="$2"
      shift 2
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
done

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is required for scripts/acm-cross-review.sh" >&2
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
receipt_fetch_path="${tmp_dir}/receipt-fetch.json"
receipt_scope_paths_path="${tmp_dir}/receipt-scope-paths.txt"
tracked_scope_path="${tmp_dir}/tracked-scope-paths.txt"
untracked_scope_path="${tmp_dir}/untracked-scope-paths.txt"
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

if [[ -z "${ACM_PROJECT_ID:-}" || -z "${receipt_id}" ]]; then
  echo "ACM_PROJECT_ID and ACM_RECEIPT_ID (or plan:<receipt_id>) are required for receipt-scoped review" >&2
  exit 2
fi

if git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_changed="$(git -C "${REPO_ROOT}" diff --name-only --diff-filter=ACDMRTUXB HEAD -- 2>/dev/null || true)"
  untracked_changed="$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard 2>/dev/null || true)"

  ACM_LOG_SINK=discard acm fetch \
    --project "${ACM_PROJECT_ID}" \
    --key "receipt:${receipt_id}" >"${receipt_fetch_path}"

  python3 - "${receipt_fetch_path}" "${receipt_scope_paths_path}" <<'PY'
import json
import sys

fetch_path, output_path = sys.argv[1], sys.argv[2]
with open(fetch_path, "r", encoding="utf-8") as handle:
    envelope = json.load(handle)

items = envelope.get("result", {}).get("items", [])
pointer_paths = []
for item in items:
    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        continue
    try:
        receipt = json.loads(content)
    except json.JSONDecodeError:
        continue
    paths = receipt.get("pointer_paths", [])
    if isinstance(paths, list):
        pointer_paths = [path.strip() for path in paths if isinstance(path, str) and path.strip()]
    if pointer_paths:
        break

with open(output_path, "w", encoding="utf-8") as handle:
    for path in pointer_paths:
        handle.write(path + "\n")
PY

  {
    printf '%s\n' "${tracked_changed}"
    printf '%s\n' "${untracked_changed}"
  } | awk 'NF && !seen[$0]++' >"${changed_files_path}"
  repo_changed_count="$(grep -c '.' "${changed_files_path}" || true)"

  python3 - "${changed_files_path}" "${receipt_scope_paths_path}" <<'PY' >"${tmp_dir}/changed-files-scoped.txt"
import sys

changed_path, scope_path = sys.argv[1], sys.argv[2]
completion_managed_paths = {
    ".acm/acm-rules.yaml",
    ".acm/acm-tags.yaml",
    ".acm/acm-tests.yaml",
    ".acm/acm-workflows.yaml",
    ".acm/bootstrap_candidates.json",
    ".env.example",
    ".gitignore",
    "acm-rules.yaml",
    "acm-tests.yaml",
    "acm-workflows.yaml",
}
with open(scope_path, "r", encoding="utf-8") as handle:
    scope = {line.strip() for line in handle if line.strip()}

with open(changed_path, "r", encoding="utf-8") as handle:
    for line in handle:
        path = line.strip()
        if path and (path in scope or path in completion_managed_paths):
            print(path)
PY
  mv "${tmp_dir}/changed-files-scoped.txt" "${changed_files_path}"
  scoped_changed_count="$(grep -c '.' "${changed_files_path}" || true)"

  if (( repo_changed_count > 0 && scoped_changed_count == 0 )); then
    printf 'FAIL: Review gate blocked before model execution: %s repo change(s), %s scoped change(s). Refresh /acm-get with a broader task before rerunning /acm-review.\n' "${repo_changed_count}" "${scoped_changed_count}"
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
Review the current uncommitted changes in the repository at ${REPO_ROOT}.

You are the cross-LLM review gate for ACM. This review is read-only and blocks completion if there are real issues.

Changed files:
$(if [[ -s "${changed_files_path}" ]]; then cat "${changed_files_path}"; else echo "(no changed files detected)"; fi)

Diff summary:
$(if [[ -s "${diff_summary_path}" ]]; then cat "${diff_summary_path}"; else echo "(no diff summary available)"; fi)

Scope counts:
- repo_changed: ${repo_changed_count}
- scoped_changed: ${scoped_changed_count}

Instructions:
- Start by reading AGENTS.md and .acm/acm-workflows.yaml when present.
- Treat the review scope as the active receipt scope plus ACM-managed governance files already allowed by completion reporting. Ignore dirty files outside the filtered changed-file list above.
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
- plan_key: ${ACM_PLAN_KEY:-}
- review_key: ${ACM_REVIEW_KEY:-review:cross-llm}
- review_summary: ${ACM_REVIEW_SUMMARY:-Cross-LLM review}
- workflow_source_path: ${ACM_WORKFLOW_SOURCE_PATH:-.acm/acm-workflows.yaml}
EOF

codex_args=(
  exec
  --model "${codex_model}"
  -c "model_reasoning_effort=\"${codex_reasoning_effort}\""
  --sandbox read-only
  --ephemeral
  -C "${REPO_ROOT}"
  --output-schema "${schema_path}"
  --output-last-message "${output_path}"
  -
)

codex "${codex_args[@]}" <"${prompt_path}"

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
