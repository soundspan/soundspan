#!/usr/bin/env bash
# Check if docs/DATA_MODEL.md is potentially stale relative to schema.prisma.
# Exit 0 = fresh (or no git history), Exit 1 = stale.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DOC="$REPO_ROOT/docs/DATA_MODEL.md"
SCHEMA="$REPO_ROOT/backend/prisma/schema.prisma"

if [ ! -f "$DOC" ]; then
  echo "FAIL: docs/DATA_MODEL.md does not exist"
  exit 1
fi

if [ ! -f "$SCHEMA" ]; then
  echo "OK: No Prisma schema found, skipping drift check"
  exit 0
fi

# Get last commit timestamps
doc_ts=$(git log -1 --format=%ct -- docs/DATA_MODEL.md 2>/dev/null | head -1)
schema_ts=$(git log -1 --format=%ct -- backend/prisma/schema.prisma 2>/dev/null | head -1)

# If doc is untracked, treat as fresh
if [ -z "$doc_ts" ]; then
  echo "OK: docs/DATA_MODEL.md exists (untracked, skipping freshness check)"
  exit 0
fi

if [ -n "$schema_ts" ] && [ "$schema_ts" -gt "$doc_ts" ]; then
  echo "WARN: docs/DATA_MODEL.md may be stale — backend/prisma/schema.prisma was modified more recently."
  echo "Review and update DATA_MODEL.md if models, relations, or enums changed."
  exit 1
fi

# Also report model count for informational purposes
schema_models=$(grep -c "^model " "$SCHEMA" || true)
doc_model_refs=$(grep -oP '`[A-Z][a-zA-Z]+`' "$DOC" | sort -u | wc -l || true)

echo "OK: docs/DATA_MODEL.md is up to date (schema: $schema_models models, doc references: $doc_model_refs unique entities)"
exit 0
