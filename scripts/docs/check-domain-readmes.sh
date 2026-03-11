#!/usr/bin/env bash
# Verify that domain READMEs (routes/services) list all actual modules.
# Usage: check-domain-readmes.sh [routes|services|all]
# Exit 0 = all covered, Exit 1 = missing entries.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
MODE="${1:-all}"
exit_code=0

check_routes() {
  local readme="$REPO_ROOT/backend/src/routes/README.md"
  local dir="$REPO_ROOT/backend/src/routes"

  if [ ! -f "$readme" ]; then
    echo "FAIL: backend/src/routes/README.md does not exist"
    return 1
  fi

  local missing=""
  for f in "$dir"/*.ts; do
    basename_f=$(basename "$f")
    # Skip test dirs, helpers, and error response module
    if [[ "$basename_f" == index.ts ]] || [[ "$basename_f" == routeErrorResponse.ts ]]; then
      continue
    fi
    if ! grep -q "$basename_f" "$readme"; then
      missing="$missing $basename_f"
    fi
  done

  if [ -n "$missing" ]; then
    echo "WARN: Route modules not in backend/src/routes/README.md:$missing"
    return 1
  fi

  echo "OK: backend/src/routes/README.md covers all route modules"
  return 0
}

check_services() {
  local readme="$REPO_ROOT/backend/src/services/README.md"
  local dir="$REPO_ROOT/backend/src/services"

  if [ ! -f "$readme" ]; then
    echo "FAIL: backend/src/services/README.md does not exist"
    return 1
  fi

  local missing=""
  for f in "$dir"/*.ts; do
    basename_f=$(basename "$f")
    if ! grep -q "$basename_f" "$readme"; then
      missing="$missing $basename_f"
    fi
  done

  if [ -n "$missing" ]; then
    echo "WARN: Service modules not in backend/src/services/README.md:$missing"
    return 1
  fi

  echo "OK: backend/src/services/README.md covers all service modules"
  return 0
}

case "$MODE" in
  routes)
    check_routes || exit_code=1
    ;;
  services)
    check_services || exit_code=1
    ;;
  all)
    check_routes || exit_code=1
    check_services || exit_code=1
    ;;
  *)
    echo "Usage: check-domain-readmes.sh [routes|services|all]"
    exit 2
    ;;
esac

exit $exit_code
