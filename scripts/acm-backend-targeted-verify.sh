#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run receipt-scoped targeted backend verification for ACM.

Usage:
  scripts/acm-backend-targeted-verify.sh

Environment:
  ACM_PROJECT_ID
  ACM_PROJECT_ROOT
  ACM_RECEIPT_ID
  ACM_PLAN_KEY
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v acm >/dev/null 2>&1; then
  echo "acm CLI is required for scripts/acm-backend-targeted-verify.sh" >&2
  exit 127
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required for scripts/acm-backend-targeted-verify.sh" >&2
  exit 127
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for scripts/acm-backend-targeted-verify.sh" >&2
  exit 127
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for scripts/acm-backend-targeted-verify.sh" >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
REPO_ROOT="${ACM_PROJECT_ROOT:-}"
if [[ -z "${REPO_ROOT}" ]]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

receipt_id="${ACM_RECEIPT_ID:-}"
if [[ -z "${receipt_id}" && "${ACM_PLAN_KEY:-}" == plan:* ]]; then
  receipt_id="${ACM_PLAN_KEY#plan:}"
fi
project_id="${ACM_PROJECT_ID:-soundspan}"

if [[ -z "${receipt_id}" ]]; then
  echo "ACM_RECEIPT_ID (or ACM_PLAN_KEY=plan:<receipt_id>) is required for receipt-scoped verify" >&2
  exit 2
fi

if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "scripts/acm-backend-targeted-verify.sh must run inside a git worktree" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

receipt_fetch_path="${tmp_dir}/receipt-fetch.json"
plan_fetch_path="${tmp_dir}/plan-fetch.json"
receipt_scope_paths_path="${tmp_dir}/receipt-scope-paths.txt"
changed_files_path="${tmp_dir}/changed-files.txt"
scoped_changed_files_path="${tmp_dir}/scoped-changed-files.txt"
backend_changed_files_path="${tmp_dir}/backend-changed-files.txt"

tracked_changed="$(git -C "${REPO_ROOT}" diff --name-only --diff-filter=ACDMRTUXB HEAD -- 2>/dev/null || true)"
untracked_changed="$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard 2>/dev/null || true)"

ACM_LOG_SINK=discard acm fetch \
  --project "${project_id}" \
  --key "receipt:${receipt_id}" >"${receipt_fetch_path}"
ACM_LOG_SINK=discard acm fetch \
  --project "${project_id}" \
  --key "plan:${receipt_id}" >"${plan_fetch_path}"

python3 - "${receipt_fetch_path}" "${plan_fetch_path}" "${receipt_scope_paths_path}" <<'PY'
import json
import sys

receipt_fetch_path, plan_fetch_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

def load_items(fetch_path):
    with open(fetch_path, "r", encoding="utf-8") as handle:
        return json.load(handle).get("result", {}).get("items", [])

scope_paths = []

for item in load_items(receipt_fetch_path):
    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        continue
    try:
        receipt = json.loads(content)
    except json.JSONDecodeError:
        continue
    paths = receipt.get("pointer_paths", [])
    if isinstance(paths, list):
        scope_paths.extend(
            path.strip() for path in paths if isinstance(path, str) and path.strip()
        )
    break

for item in load_items(plan_fetch_path):
    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        continue
    try:
        plan = json.loads(content)
    except json.JSONDecodeError:
        continue
    paths = plan.get("discovered_paths", [])
    if isinstance(paths, list):
        scope_paths.extend(
            path.strip() for path in paths if isinstance(path, str) and path.strip()
        )
    break

with open(output_path, "w", encoding="utf-8") as handle:
    for path in dict.fromkeys(scope_paths):
        handle.write(path + "\n")
PY

{
  printf '%s\n' "${tracked_changed}"
  printf '%s\n' "${untracked_changed}"
} | awk 'NF && !seen[$0]++' >"${changed_files_path}"

python3 - "${changed_files_path}" "${receipt_scope_paths_path}" <<'PY' >"${scoped_changed_files_path}"
import sys

changed_path, scope_path = sys.argv[1], sys.argv[2]
with open(scope_path, "r", encoding="utf-8") as handle:
    scope = {line.strip() for line in handle if line.strip()}

with open(changed_path, "r", encoding="utf-8") as handle:
    for line in handle:
        path = line.strip()
        if path and path in scope:
            print(path)
PY

python3 - "${scoped_changed_files_path}" <<'PY' >"${backend_changed_files_path}"
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    for line in handle:
        path = line.strip()
        if path.startswith("backend/") or path.startswith("packages/media-metadata-contract/"):
            print(path)
PY

scoped_count="$(grep -c '.' "${scoped_changed_files_path}" || true)"
backend_count="$(grep -c '.' "${backend_changed_files_path}" || true)"

if [[ -s "${changed_files_path}" && "${scoped_count}" == "0" ]]; then
  printf 'FAIL: Targeted backend verify blocked: repo has uncommitted changes but none are in the active receipt scope.\n' >&2
  exit 1
fi

if [[ "${backend_count}" == "0" ]]; then
  printf 'SKIP: No receipt-scoped backend or shared media contract paths require targeted backend tests.\n'
  exit 0
fi

mapfile -t backend_changed_files <"${backend_changed_files_path}"
resolved_test_files_path="${tmp_dir}/resolved-test-files.txt"

python3 - "${REPO_ROOT}" "${backend_changed_files_path}" <<'PY' >"${resolved_test_files_path}"
from pathlib import Path
import sys

repo_root = Path(sys.argv[1])
changed_files_path = Path(sys.argv[2])
resolved = []
seen = set()

def add(path: Path) -> None:
    normalized = str(path)
    if normalized not in seen and path.exists():
        seen.add(normalized)
        resolved.append(normalized)

for raw_line in changed_files_path.read_text(encoding="utf-8").splitlines():
    rel_path = raw_line.strip()
    if not rel_path:
        continue

    path = repo_root / rel_path
    parts = Path(rel_path).parts

    if "__tests__" in parts and path.suffix == ".ts":
        add(path)
        continue

    if parts[:2] != ("backend", "src") or path.suffix != ".ts":
        continue

    relative_to_src = Path(*parts[2:])
    stem = relative_to_src.stem
    parent = relative_to_src.parent
    candidate_dirs = []
    if str(parent) != ".":
        candidate_dirs.append(repo_root / "backend" / "src" / parent / "__tests__")
    candidate_dirs.append(repo_root / "backend" / "src" / "__tests__")

    for test_dir in candidate_dirs:
        if not test_dir.is_dir():
            continue
        for candidate in sorted(test_dir.glob(f"{stem}*.test.ts")):
            add(candidate)

for path in resolved:
    print(path)
PY

resolved_test_count="$(grep -c '.' "${resolved_test_files_path}" || true)"

printf 'Running targeted backend verify for %s receipt-scoped file(s).\n' "${backend_count}"
if [[ "${resolved_test_count}" == "0" ]]; then
  printf 'SKIP: No direct backend test files matched the receipt-scoped backend changes.\n'
  exit 0
fi

mapfile -t resolved_test_files <"${resolved_test_files_path}"
npm --prefix "${REPO_ROOT}/backend" test -- \
  --runInBand \
  --passWithNoTests \
  --forceExit \
  --runTestsByPath \
  "${resolved_test_files[@]}"
