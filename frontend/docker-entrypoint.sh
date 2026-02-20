#!/bin/sh
set -e

# Security check: Refuse to run as root
if [ "$(id -u)" = "0" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  FATAL: CANNOT START AS ROOT                                 ║"
  echo "║                                                              ║"
  echo "║  Running as root is a security risk. This container must    ║"
  echo "║  run as a non-privileged user.                              ║"
  echo "║                                                              ║"
  echo "║  Do NOT use:                                                 ║"
  echo "║    - docker run --user root                                  ║"
  echo "║    - user: root in docker-compose.yml                        ║"
  echo "║                                                              ║"
  echo "║  The container is configured to run as 'nextjs' user.       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

echo "[START] Starting soundspan Frontend..."
echo "[CONFIG] Environment: ${NODE_ENV:-production}"
echo "[CONFIG] API URL: ${NEXT_PUBLIC_API_URL:-not set}"
echo "[CONFIG] API path mode: ${NEXT_PUBLIC_API_PATH_MODE:-auto}"

RUNTIME_CONFIG_FILE="/app/public/runtime-config.js"
ENGINE_MODE="${STREAMING_ENGINE_MODE:-}"
case "$ENGINE_MODE" in
  ""|"videojs"|"react-all-player"|"howler-rollback")
    ;;
  *)
    echo "[WARN] Invalid STREAMING_ENGINE_MODE '$ENGINE_MODE'; expected videojs|react-all-player|howler-rollback. Falling back to default (videojs)."
    ENGINE_MODE=""
    ;;
esac

if [ -n "$ENGINE_MODE" ]; then
  ENGINE_MODE_JSON="\"$ENGINE_MODE\""
else
  ENGINE_MODE_JSON="null"
fi

cat > "$RUNTIME_CONFIG_FILE" << EOF
window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: $ENGINE_MODE_JSON,
  },
);
EOF

echo "[CONFIG] STREAMING_ENGINE_MODE: ${ENGINE_MODE:-videojs (default)}"

# Execute the main command
exec "$@"
