# Migrating from Lidify to soundspan

This runbook is the complete migration procedure for moving an existing Lidify deployment to soundspan.

It assumes both repositories are side-by-side on disk:

- soundspan repo: current directory
- Lidify repo: `../lidify`

## Compatibility Status (Read First)

- Database schema compatibility is strong: `backend/prisma/schema.prisma` is byte-identical between `../lidify` and this repo, and migration directories are identical.
- Runtime compatibility is not automatic. You must migrate runtime identifiers and defaults:
  - `LIDIFY_CALLBACK_URL` -> `SOUNDSPAN_CALLBACK_URL`
  - Compose defaults changed for PostgreSQL (from user/database `lidifydb/lidify` to `soundspan/soundspan`)
  - Compose defaults changed for network/container names (`lidify_*` -> `soundspan_*`)
  - Frontend local storage keys changed (`lidify_*` -> `soundspan_*`)
  - Device deep-link scheme changed (`lidify://` -> `soundspan://`)

Because of those required remaps, this is not a zero-touch migration.

## 1. Set Migration Context

Run from the soundspan repo root:

```bash
export LIDIFY_ROOT=../lidify
export SOUNDSPAN_ROOT="$(pwd)"
test -d "$LIDIFY_ROOT"
```

## 2. Back Up Lidify Before Any Cutover

1. Back up Lidify `.env`:

```bash
cp "$LIDIFY_ROOT/.env" "/tmp/lidify.env.$(date +%Y%m%d-%H%M%S).bak"
```

2. If you run Lidify split-stack compose (`../lidify/docker-compose.yml`), dump PostgreSQL:

```bash
cd "$LIDIFY_ROOT"
docker compose -f docker-compose.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-lidifydb}" "${POSTGRES_DB:-lidify}" \
  > "/tmp/lidify-db.$(date +%Y%m%d-%H%M%S).sql"
```

3. If you run Lidify AIO (`../lidify/docker-compose.aio.yml`), back up the data volume:

```bash
docker run --rm \
  -v lidify_data:/from \
  -v /tmp:/to \
  alpine sh -c 'cd /from && tar -czf /to/lidify-data.'"$(date +%Y%m%d-%H%M%S)"'.tgz .'
```

## 3. Stop Lidify

```bash
cd "$LIDIFY_ROOT"
docker compose -f docker-compose.yml down || true
docker compose -f docker-compose.aio.yml down || true
```

## 4. Prepare soundspan Environment From Lidify

```bash
cd "$SOUNDSPAN_ROOT"
cp "$LIDIFY_ROOT/.env" ./.env
```

Apply required remaps:

```bash
# Callback var rename
if grep -q '^LIDIFY_CALLBACK_URL=' .env; then
  sed -i 's/^LIDIFY_CALLBACK_URL=/SOUNDSPAN_CALLBACK_URL=/' .env
fi

# Ensure legacy DB defaults are preserved if they were implicit in Lidify
grep -q '^POSTGRES_USER=' .env || echo 'POSTGRES_USER=lidifydb' >> .env
grep -q '^POSTGRES_DB=' .env || echo 'POSTGRES_DB=lidify' >> .env
grep -q '^POSTGRES_PASSWORD=' .env || echo 'POSTGRES_PASSWORD=changeme' >> .env

# AIO image repository changed to GHCR
if grep -q '^SOUNDSPAN_AIO_IMAGE=' .env; then
  sed -i 's#^SOUNDSPAN_AIO_IMAGE=.*#SOUNDSPAN_AIO_IMAGE=ghcr.io/soundspan/soundspan#' .env
else
  echo 'SOUNDSPAN_AIO_IMAGE=ghcr.io/soundspan/soundspan' >> .env
fi
```

If anything external still points at old Lidify Docker identifiers, pin soundspan to legacy names:

```bash
cat >> .env <<'EOF'
SOUNDSPAN_NETWORK_NAME=lidify_network
SOUNDSPAN_DB_CONTAINER_NAME=lidify_db
SOUNDSPAN_REDIS_CONTAINER_NAME=lidify_redis
SOUNDSPAN_TIDAL_CONTAINER_NAME=lidify_tidal_downloader
SOUNDSPAN_YTMUSIC_CONTAINER_NAME=lidify_ytmusic_streamer
SOUNDSPAN_AUDIO_ANALYZER_CONTAINER_NAME=lidify_audio_analyzer
SOUNDSPAN_CLAP_CONTAINER_NAME=lidify_audio_analyzer_clap
SOUNDSPAN_AIO_CONTAINER_NAME=lidify
SOUNDSPAN_AIO_DATA_VOLUME=lidify_data
EOF
```

## 5. Start soundspan

Use exactly one migration path.

### Path A: Split Stack Compose

```bash
cd "$SOUNDSPAN_ROOT"
docker compose -f docker-compose.yml up -d --build
```

If you also used the optional Lidarr service:

```bash
docker compose -f docker-compose.yml -f docker-compose.services.yml up -d --build
```

### Path B: AIO Compose

```bash
cd "$SOUNDSPAN_ROOT"
docker compose -f docker-compose.aio.yml up -d
```

### Path C: Helm (Existing `lidify` Release)

If you must upgrade an existing Helm release named `lidify` in-place, keep object naming stable with `nameOverride=lidify`:

```bash
helm upgrade lidify ./charts/soundspan \
  --namespace <namespace> \
  --reuse-values \
  --set nameOverride=lidify \
  --set secrets.postgresUser=lidifydb \
  --set secrets.postgresDatabase=lidify
```

If you intentionally want new resource names, do blue/green instead of in-place.

## 6. Required Post-Migration Actions

1. Open soundspan and verify login.
2. Re-save Lidarr integration settings in soundspan admin to refresh webhook configuration.
3. Update any mobile/deep-link integrations from `lidify://` to `soundspan://`.
4. Expect browser playback UI state reset unless you manually migrate local storage.

Optional browser local storage key migration (run once in browser devtools on soundspan origin):

```js
for (const k of Object.keys(localStorage)) {
  if (k.startsWith("lidify_") || k.startsWith("lidify.")) {
    const v = localStorage.getItem(k);
    const nk = k.replace(/^lidify(?=[_.])/, "soundspan");
    if (v !== null) localStorage.setItem(nk, v);
  }
}
```

## 7. Verification Checklist

Run from soundspan repo:

```bash
docker compose -f docker-compose.yml ps || true
docker compose -f docker-compose.aio.yml ps || true
curl -fsS http://127.0.0.1:3006/health/live || true
curl -fsS http://127.0.0.1:3006/api/webhooks/lidarr/verify || true
```

Expected webhook verify payload includes `service: "soundspan"`.

If split-stack is used, verify DB data is present:

```bash
docker compose -f docker-compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c 'select count(*) from "User";'
```

## 8. Rollback

If anything fails:

```bash
cd "$SOUNDSPAN_ROOT"
docker compose -f docker-compose.yml down || true
docker compose -f docker-compose.aio.yml down || true

cd "$LIDIFY_ROOT"
docker compose -f docker-compose.yml up -d || true
docker compose -f docker-compose.aio.yml up -d || true
```

If schema/data issues occurred, restore the SQL dump created in Step 2 before re-cutover.
