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
  echo "║  The container is configured to run as 'node' user.         ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

is_critical_secret_invalid() {
  secret_value="$1"
  insecure_default="$2"
  [ -z "$secret_value" ] || [ "$secret_value" = "$insecure_default" ] || [ "${#secret_value}" -lt 32 ]
}

# Validate critical secrets before migrations or other external startup work.
if is_critical_secret_invalid "${SESSION_SECRET:-}" "changeme-generate-secure-key"; then
  cat >&2 <<'EOF'
[ERROR] SESSION_SECRET is missing, uses the published default, or is shorter than 32 characters.
SESSION_SECRET must be stable because it signs JWTs and is the API-key pepper fallback.
An ephemeral value invalidates all sessions and API-key hashes on restart.
Generate one with: openssl rand -base64 32
EOF
  exit 1
fi

if is_critical_secret_invalid "${SETTINGS_ENCRYPTION_KEY:-}" "default-encryption-key-change-me"; then
  cat >&2 <<'EOF'
[ERROR] SETTINGS_ENCRYPTION_KEY is missing, uses the published default, or is shorter than 32 characters.
SETTINGS_ENCRYPTION_KEY encrypts API keys, passwords, and 2FA secrets and must be stable across restarts.
Changing it makes existing encrypted data unreadable.
Generate one with: openssl rand -base64 32
EOF
  exit 1
fi

if is_critical_secret_invalid "${INTERNAL_API_SECRET:-}" "soundspan-internal-secret-change-me"; then
  cat >&2 <<'EOF'
[ERROR] INTERNAL_API_SECRET is missing, uses the published default, or is shorter than 32 characters.
INTERNAL_API_SECRET authenticates service-to-service requests and must match every backend sidecar.
Generate one with: openssl rand -base64 32
EOF
  exit 1
fi

echo "[START] Starting soundspan Backend..."

# Docker Compose health checks ensure database and Redis are ready
# Add a small delay to be extra safe
echo "[WAIT] Waiting for services to be ready..."
sleep 3
echo "Services are ready"

is_retryable_migrate_error() {
  # Retry bounded startup failures caused by transient DB saturation/connectivity.
  echo "$1" | grep -Eqi "too many clients already|P2037|Can't reach database server|Connection reset|ECONNRESET|ETIMEDOUT|schema engine error"
}

run_prisma_migrations_with_retry() {
  max_attempts="${PRISMA_MIGRATE_MAX_ATTEMPTS:-12}"
  base_delay_seconds="${PRISMA_MIGRATE_RETRY_DELAY_SECONDS:-5}"
  max_delay_seconds="${PRISMA_MIGRATE_MAX_DELAY_SECONDS:-30}"
  attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    echo "[DB] Running database migrations (attempt ${attempt}/${max_attempts})..."

    set +e
    migrate_output=$(./node_modules/.bin/prisma migrate deploy 2>&1)
    migrate_exit_code=$?
    set -e

    echo "$migrate_output"

    if [ "$migrate_exit_code" -eq 0 ]; then
      echo "[DB] Database migrations completed successfully"
      return 0
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[DB] Migration failed after ${max_attempts} attempts"
      return "$migrate_exit_code"
    fi

    if is_retryable_migrate_error "$migrate_output"; then
      delay_seconds=$((base_delay_seconds * attempt))
      if [ "$delay_seconds" -gt "$max_delay_seconds" ]; then
        delay_seconds="$max_delay_seconds"
      fi
      echo "[DB] Migration failed with retryable DB saturation/connectivity error; retrying in ${delay_seconds}s"
      sleep "$delay_seconds"
      attempt=$((attempt + 1))
      continue
    fi

    echo "[DB] Migration failed with non-retryable error; aborting startup"
    return "$migrate_exit_code"
  done

  return 1
}

# Run database migrations unless explicitly disabled.
if [ "${RUN_DB_MIGRATIONS_ON_STARTUP:-true}" = "true" ]; then
  run_prisma_migrations_with_retry
else
  echo "[DB] Skipping database migrations (RUN_DB_MIGRATIONS_ON_STARTUP=false)"
fi

# Generate Prisma client only when explicitly requested.
# Runtime images already include generated clients from build stage.
if [ "${PRISMA_GENERATE_ON_STARTUP:-false}" = "true" ]; then
  echo "[DB] Generating Prisma client..."
  ./node_modules/.bin/prisma generate
else
  echo "[DB] Skipping Prisma client generation (PRISMA_GENERATE_ON_STARTUP=false)"
fi

# Optional Redis cache flush on startup.
# Safe default is disabled; explicitly opt in only for dedicated-Redis cache clearing.
if [ "${REDIS_FLUSH_ON_STARTUP:-false}" = "true" ]; then
  echo "[REDIS] REDIS_FLUSH_ON_STARTUP=true, running FLUSHALL..."
  echo "[REDIS] WARNING: This is destructive for shared Redis instances."
  node -e "
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
  client.connect()
    .then(() => client.flushAll())
    .then(() => { console.log('[REDIS] Cache cleared successfully'); return client.quit(); })
    .catch(err => { console.warn('[REDIS] Cache clear failed (non-critical):', err.message); });
  " || echo "[REDIS] Cache clear skipped (Redis unavailable)"
else
  echo "[REDIS] Skipping startup cache flush (REDIS_FLUSH_ON_STARTUP=false)"
fi

echo "[START] soundspan Backend starting on port ${PORT:-3006}..."
echo "[CONFIG] Music path: ${MUSIC_PATH:-/music}"
echo "[CONFIG] Environment: ${NODE_ENV:-production}"

# Execute the main command
exec "$@"
