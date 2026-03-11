#!/usr/bin/env bash
# Check if docs/ARCHITECTURE.md is potentially stale relative to trigger files.
# Exit 0 = fresh (or no git history), Exit 1 = stale.
#
# Trigger files: docker-compose*.yml, backend/src/routes/, backend/src/services/
# Logic: if any trigger file was modified more recently than ARCHITECTURE.md, warn.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ARCH_DOC="$REPO_ROOT/docs/ARCHITECTURE.md"

if [ ! -f "$ARCH_DOC" ]; then
  echo "FAIL: docs/ARCHITECTURE.md does not exist"
  exit 1
fi

# Get the last commit timestamp of ARCHITECTURE.md
arch_ts=$(git log -1 --format=%ct -- docs/ARCHITECTURE.md 2>/dev/null | head -1)

# If file is untracked (no git history), treat as fresh
if [ -z "$arch_ts" ]; then
  echo "OK: docs/ARCHITECTURE.md exists (untracked, skipping freshness check)"
  exit 0
fi

stale=0
stale_files=""

check_trigger() {
  local path="$1"
  local f_ts
  f_ts=$(git log -1 --format=%ct -- "$path" 2>/dev/null | head -1)
  if [ -n "$f_ts" ] && [ "$f_ts" -gt "$arch_ts" ]; then
    stale=1
    stale_files="$stale_files $path"
  fi
}

# Check docker-compose files
for f in "$REPO_ROOT"/docker-compose*.yml; do
  if [ -f "$f" ]; then
    check_trigger "$(basename "$f")"
  fi
done

# Check route/service directory changes
for dir in backend/src/routes backend/src/services; do
  if [ -d "$REPO_ROOT/$dir" ]; then
    check_trigger "$dir"
  fi
done

if [ "$stale" -eq 1 ]; then
  echo "WARN: docs/ARCHITECTURE.md may be stale. Changed since last update:$stale_files"
  echo "Review and update ARCHITECTURE.md if the topology or service map changed."
  exit 1
fi

echo "OK: docs/ARCHITECTURE.md is up to date"
exit 0
