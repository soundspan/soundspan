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

ENGINE_MODE="${STREAMING_ENGINE_MODE:-}"
case "$ENGINE_MODE" in
  ""|"videojs"|"howler")
    ;;
  *)
    echo "[WARN] Invalid STREAMING_ENGINE_MODE '$ENGINE_MODE'; expected howler|videojs (videojs is experimental). Using primary default (howler)."
    ENGINE_MODE=""
    ;;
esac

if [ -n "$ENGINE_MODE" ]; then
  export STREAMING_ENGINE_MODE="$ENGINE_MODE"
else
  export STREAMING_ENGINE_MODE=""
fi

echo "[CONFIG] STREAMING_ENGINE_MODE: ${ENGINE_MODE:-howler (primary default)}"

SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE="${SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS:-}"
if [ -n "$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE" ]; then
  case "$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE" in
    *[!0-9]*)
      echo "[WARN] Invalid SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS '$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE'; expected integer milliseconds. Using default (20000ms)."
      SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE=""
      ;;
  esac
fi

if [ -n "$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE" ]; then
  if [ "$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE" -lt 1500 ]; then
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE=1500
  elif [ "$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE" -gt 22000 ]; then
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE=22000
  fi
  export SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS="$SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE"
  echo "[CONFIG] SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: ${SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS_VALUE}ms"
else
  export SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS=""
  echo "[CONFIG] SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: 20000ms (default)"
fi

LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE="${LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED:-}"
case "$LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE" in
  ""|"true"|"false")
    ;;
  *)
    echo "[WARN] Invalid LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED '$LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE'; expected true|false. Using default (false)."
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE=""
    ;;
esac

if [ -n "$LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE" ]; then
  export LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED="$LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE"
  echo "[CONFIG] LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: $LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_VALUE"
else
  export LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED=""
  echo "[CONFIG] LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: false (default)"
fi

HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE="${HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED:-}"
case "$HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE" in
  ""|"true"|"false")
    ;;
  *)
    echo "[WARN] Invalid HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED '$HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE'; expected true|false. Using default (false)."
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE=""
    ;;
esac

if [ -n "$HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE" ]; then
  export HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED="$HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE"
  echo "[CONFIG] HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: $HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_VALUE"
else
  export HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED=""
  echo "[CONFIG] HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: false (default)"
fi

SEGMENTED_SESSION_PREWARM_ENABLED_VALUE="${SEGMENTED_SESSION_PREWARM_ENABLED:-}"
case "$SEGMENTED_SESSION_PREWARM_ENABLED_VALUE" in
  ""|"true"|"false")
    ;;
  *)
    echo "[WARN] Invalid SEGMENTED_SESSION_PREWARM_ENABLED '$SEGMENTED_SESSION_PREWARM_ENABLED_VALUE'; expected true|false. Using default (true)."
    SEGMENTED_SESSION_PREWARM_ENABLED_VALUE=""
    ;;
esac

if [ -n "$SEGMENTED_SESSION_PREWARM_ENABLED_VALUE" ]; then
  export SEGMENTED_SESSION_PREWARM_ENABLED="$SEGMENTED_SESSION_PREWARM_ENABLED_VALUE"
  echo "[CONFIG] SEGMENTED_SESSION_PREWARM_ENABLED: $SEGMENTED_SESSION_PREWARM_ENABLED_VALUE"
else
  export SEGMENTED_SESSION_PREWARM_ENABLED=""
  echo "[CONFIG] SEGMENTED_SESSION_PREWARM_ENABLED: true (default)"
fi

# Execute the main command
exec "$@"
