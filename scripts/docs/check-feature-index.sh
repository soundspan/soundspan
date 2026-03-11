#!/usr/bin/env bash
# Verify that all frontend/features/* directories are listed in docs/FEATURE_INDEX.json.
# Exit 0 = all covered, Exit 1 = missing entries.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
INDEX="$REPO_ROOT/docs/FEATURE_INDEX.json"
FEATURES_DIR="$REPO_ROOT/frontend/features"

if [ ! -f "$INDEX" ]; then
  echo "FAIL: docs/FEATURE_INDEX.json does not exist"
  exit 1
fi

if [ ! -d "$FEATURES_DIR" ]; then
  echo "OK: No frontend/features directory found, skipping"
  exit 0
fi

missing=0
missing_dirs=""

for dir in "$FEATURES_DIR"/*/; do
  dirname=$(basename "$dir")
  # Skip hidden dirs and __tests__
  if [[ "$dirname" == .* ]] || [[ "$dirname" == __* ]]; then
    continue
  fi
  # Check if dirname appears in coverage.frontend_feature_dirs
  if ! grep -q "\"$dirname\"" "$INDEX"; then
    missing=1
    missing_dirs="$missing_dirs $dirname"
  fi
done

if [ "$missing" -eq 1 ]; then
  echo "FAIL: Frontend feature directories not in docs/FEATURE_INDEX.json:$missing_dirs"
  echo "Add missing directories to coverage.frontend_feature_dirs and create feature entries."
  exit 1
fi

echo "OK: All frontend/features/* directories are covered in FEATURE_INDEX.json"
exit 0
