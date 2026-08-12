#!/usr/bin/env bash
set -euo pipefail

require_postgres_password() {
    if [ -z "${POSTGRES_PASSWORD:-}" ]; then
        echo "ERROR: POSTGRES_PASSWORD must not be empty." >&2
        return 1
    fi
}

database_url() {
    local encoded_password

    require_postgres_password
    encoded_password=$(
        node -e 'process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))'
    )
    printf 'postgresql://soundspan:%s@localhost:5432/soundspan' "$encoded_password"
}

sync_role() {
    require_postgres_password

    if ! gosu postgres psql -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname = 'soundspan'" | grep -q 1; then
        gosu postgres psql --set ON_ERROR_STOP=1 -c "CREATE USER soundspan"
    fi

    gosu postgres psql --set ON_ERROR_STOP=1 <<'SQL'
\getenv postgres_password POSTGRES_PASSWORD
ALTER USER soundspan WITH PASSWORD :'postgres_password';
SQL
}

case "${1:-}" in
    database-url)
        database_url
        ;;
    sync-role)
        sync_role
        ;;
    *)
        echo "Usage: $0 {database-url|sync-role}" >&2
        exit 2
        ;;
esac
