# Configuration and Security

This guide centralizes environment configuration and security expectations.

For deployment mode selection, see [`DEPLOYMENT.md`](DEPLOYMENT.md).
For integration-specific setup values, see [`INTEGRATIONS.md`](INTEGRATIONS.md).

## Core Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_SECRET` | Auto-generated | Session encryption key (set explicitly for restart persistence) |
| `SETTINGS_ENCRYPTION_KEY` | Required | Encryption key for stored credentials |
| `TZ` | `UTC` | Container timezone |
| `PORT` | `3030` | App port |
| `BACKEND_PROCESS_ROLE` | `all` | Backend runtime role: `all` (combined API + workers), `api`, or `worker` |
| `WORKER_HEALTH_PORT` | `3010` | Worker-only health server port (`/health/live`, `/health/ready`) |
| `LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED` | `true` | Enable cross-pod Socket.IO fanout for Listen Together via Redis adapter |
| `LISTEN_TOGETHER_STATE_SYNC_ENABLED` | `true` | Enable cross-pod Listen Together in-memory state sync via Redis pub/sub snapshots |
| `LISTEN_TOGETHER_STATE_STORE_ENABLED` | `true` | Enable Redis-backed authoritative Listen Together snapshot store |
| `LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS` | `21600` | TTL for persisted Listen Together snapshots in Redis |
| `LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX` | `listen-together:state` | Redis key prefix for Listen Together snapshot state |
| `LISTEN_TOGETHER_MUTATION_LOCK_ENABLED` | `true` | Enable Redis-backed per-group mutation lock for playback/queue/ready hot-path writes |
| `LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS` | `3000` | Lock TTL for Listen Together mutation critical section |
| `LISTEN_TOGETHER_MUTATION_LOCK_PREFIX` | `listen-together:mutation-lock` | Redis key prefix for Listen Together mutation locks |
| `LISTEN_TOGETHER_RECONNECT_SLO_MS` | `5000` | Reconnect-latency warning threshold for Listen Together socket reconnects |
| `LISTEN_TOGETHER_ALLOW_POLLING` | `false` | Allow polling fallback transport (`true` only when sticky sessions are guaranteed) |
| `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` | `3` | Consecutive scheduler-claim skips before warning-level SLO log emission |
| `READINESS_REQUIRE_DEPENDENCIES` | `true` | Require PostgreSQL/Redis health for readiness success |
| `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` | `5000` | Minimum interval between dependency readiness probes |
| `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` | `2000` | Timeout per dependency readiness probe operation |
| `SOUNDSPAN_CALLBACK_URL` | `http://host.docker.internal:3030` | URL for Lidarr webhook callbacks |
| `AUDIO_ANALYSIS_WORKERS` | `2` | Parallel workers for audio analysis |
| `AUDIO_ANALYSIS_THREADS_PER_WORKER` | `1` | Threads per audio worker |
| `AUDIO_ANALYSIS_BATCH_SIZE` | `10` | Tracks per analyzer batch |
| `AUDIO_BRPOP_TIMEOUT` | `30` | Redis blocking wait timeout in seconds |
| `AUDIO_MODEL_IDLE_TIMEOUT` | `300` | Seconds before idle ML model unload (`0` disables unload) |
| `MAX_FILE_SIZE_MB` | `250` | Analyzer input file hard cap (`0` disables cap) |
| `BATCH_ANALYSIS_TIMEOUT_SECONDS` | `900` | Batch processing timeout before permanent failure |
| `LOG_LEVEL` | `warn` (prod) / `debug` (dev) | Logging verbosity |
| `DOCS_PUBLIC` | `false` | Allow public API docs in production when `true` |
| `RUN_DB_MIGRATIONS_ON_STARTUP` | `true` | API entrypoint toggle to run `prisma migrate deploy` on startup |
| `PRISMA_MIGRATE_MAX_ATTEMPTS` | `12` | Max startup migration retries for transient DB saturation/connectivity failures |
| `PRISMA_MIGRATE_RETRY_DELAY_SECONDS` | `5` | Base delay seconds between startup migration retries (linear backoff, capped) |
| `PRISMA_MIGRATE_MAX_DELAY_SECONDS` | `30` | Max delay cap per startup migration retry |
| `PRISMA_GENERATE_ON_STARTUP` | `false` | API entrypoint toggle for runtime `prisma generate` (normally unnecessary; generated at image build) |
| `YTMUSIC_STREAMER_URL` | `http://127.0.0.1:8586` | YouTube Music streamer sidecar URL |
| `YTMUSIC_DEBUG` | _(unset)_ | Set to any value for sidecar debug logging |
| `TIDAL_SIDECAR_URL` | `http://127.0.0.1:8585` | TIDAL sidecar URL |
| `TIDAL_TRACK_DELAY` | `3` | Seconds between TIDAL track downloads |

The music library path is configured via Docker volume mount (`-v /path/to/music:/music`).

## Role Split Guidance (Compose/Kubernetes)

For horizontally scaled split deployments, prefer:

- API pods/containers: `BACKEND_PROCESS_ROLE=api`
- Worker pods/containers: `BACKEND_PROCESS_ROLE=worker`

For single-process deployments, keep `BACKEND_PROCESS_ROLE=all`.

## Backend Worker Environment Variables (Complete Reference)

The worker entrypoint (`backend/src/worker.ts`) loads shared backend config and then starts queue/scheduler workers.

### Required For Worker Startup

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | None | PostgreSQL connection string; worker exits if missing/invalid |
| `REDIS_URL` | Yes | None | Redis connection string for queues/claims/state; worker exits if missing/invalid |
| `SESSION_SECRET` | Yes | None | Required by shared config validation; must be at least 32 chars |
| `MUSIC_PATH` | Yes | None | Must point to mounted music path in container (usually `/music`) |
| `BACKEND_PROCESS_ROLE` | Recommended | `worker` | Worker entrypoint accepts `worker` or `all`; `api` is rejected |
| `WORKER_HEALTH_PORT` | No | `3010` | Health server port used by `/health/live` and `/health/ready` probes |

### Worker Scheduler And Claim Controls

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` | No | `3` | Consecutive scheduler claim skips before warning-level SLO logs |
| `READINESS_REQUIRE_DEPENDENCIES` | No | `true` | Worker readiness requires PostgreSQL and Redis checks |
| `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` | No | `5000` | Minimum interval between dependency checks |
| `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` | No | `2000` | Timeout per dependency check operation |
| `DISCOVER_PROCESSOR_LOCK_TTL_MS` | No | `2700000` | Discover job per-user claim TTL (45 min) |
| `ENRICHMENT_CLAIM_TTL_MS` | No | `900000` | Unified enrichment cycle claim TTL (15 min) |
| `MOOD_BUCKET_CLAIM_TTL_MS` | No | `120000` | Mood bucket cycle claim TTL (2 min) |

### Worker Runtime Tuning

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Standard runtime mode |
| `TZ` | No | `UTC` | Timezone for logs/scheduling context |
| `LOG_LEVEL` | No | `warn` (prod), `debug` (dev) | Logger verbosity |
| `LOG_QUERIES` | No | `false` | Enables Prisma query logging in development only |
| `DATABASE_POOL_SIZE` | No | Role-aware: `api=8`, `worker=4`, `all=12` | Prisma DB pool connection limit (set explicitly to override role default). If `BACKEND_PROCESS_ROLE` is unset, role is inferred from entrypoint (`index.*` => `api`, `worker.*` => `worker`). |
| `DATABASE_POOL_TIMEOUT` | No | `30` | Prisma DB pool timeout in seconds |
| `PORT` | No | `3006` | Shared config field; not used for worker health endpoint |

### Optional Feature-Gated Variables Used By Worker Jobs

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCOVERY_MODE` | No | `recommendation` | Discover job mode (`legacy` or `recommendation`) |
| `LASTFM_API_KEY` | No | Built-in app key | Used for metadata/mood enrichment |
| `LIDARR_ENABLED` | No | `false` | Enables Lidarr-specific worker cleanup/reconciliation paths |
| `LIDARR_URL` | If `LIDARR_ENABLED=true` | None | Lidarr base URL |
| `LIDARR_API_KEY` | If `LIDARR_ENABLED=true` | None | Lidarr API key |
| `FANART_API_KEY` | No | None | Optional fanart enrichment source |
| `OPENAI_API_KEY` | No | None | Optional AI-assisted recommendation paths |
| `DEEZER_API_KEY` | No | None | Optional Deezer-assisted recommendation paths |
| `AUDIOBOOKSHELF_URL` | No | None | Optional audiobook/podcast sync fallback when DB settings are not present |
| `AUDIOBOOKSHELF_TOKEN` | If `AUDIOBOOKSHELF_URL` is set for token-based config consumers | None | Optional token variable used by shared config object |
| `AUDIOBOOKSHELF_API_KEY` | If `AUDIOBOOKSHELF_URL` is set via env | None | Required with `AUDIOBOOKSHELF_URL` for env-based Audiobookshelf fallback |

## External Access Settings

If users access soundspan from outside your local network, set API URL and allowed origins.

```env
NEXT_PUBLIC_API_URL=https://soundspan-api.yourdomain.com
NEXT_PUBLIC_API_PATH_MODE=direct
ALLOWED_ORIGINS=http://localhost:3030,https://soundspan.yourdomain.com
```

`NEXT_PUBLIC_API_PATH_MODE` controls how the browser reaches backend APIs:

- `auto` (default): use `NEXT_PUBLIC_API_URL` when set; otherwise use same-origin proxy mode on frontend ports `3030`/`443`/`80`, and direct `:3006` calls on other ports.
- `proxy`: always use same-origin `/api/*` calls through `frontend/app/api/[...path]/route.ts`.
- `direct`: always call backend directly (uses `NEXT_PUBLIC_API_URL` when provided, else derives `protocol://<host>:3006`).

Set this in frontend build/dev environment (same place you set `NEXT_PUBLIC_API_URL`).

For Listen Together, the frontend proxies `/socket.io/listen-together` to backend by default in split deployments.
If you bypass frontend proxying intentionally, your edge proxy/tunnel must route `/socket.io/listen-together` to backend `:3006`.
`LISTEN_TOGETHER_ALLOW_POLLING=false` is recommended for HA deployments; only enable polling fallback when sticky sessions are guaranteed end-to-end.

For multi-replica backend/frontend deployments, configure Redis as a highly available endpoint.
A single Redis pod is a runtime SPOF for sessions, queues, and realtime coordination.
Redis HA is an operator-managed prerequisite (external managed Redis/Dragonfly, Sentinel, or equivalent); soundspan consumes the configured endpoint and does not manage Redis HA topology itself.

## Sensitive Variables

Never commit `.env` files or credentials.

| Variable | Purpose | Required |
| --- | --- | --- |
| `SESSION_SECRET` | Session encryption (32+ chars) | Yes |
| `SETTINGS_ENCRYPTION_KEY` | Encryption of stored credentials | Yes |
| `SOULSEEK_USERNAME` | Soulseek login | If using Soulseek |
| `SOULSEEK_PASSWORD` | Soulseek password | If using Soulseek |
| `LIDARR_API_KEY` | Lidarr integration | If using Lidarr |
| `OPENAI_API_KEY` | AI features | Optional |
| `LASTFM_API_KEY` | Artist recommendations | Optional |
| `FANART_API_KEY` | Artist images | Optional |
| `YTMUSIC_STREAMER_URL` | YouTube Music sidecar URL | If using YouTube Music |
| `TIDAL_SIDECAR_URL` | TIDAL sidecar URL | If using TIDAL |

## Authentication and Session Security

- JWT access tokens expire after 24 hours; refresh tokens after 30 days
- Token refresh uses `/api/auth/refresh`
- Password changes invalidate existing sessions
- Session cookies use `httpOnly`, `sameSite=strict`, and `secure` in production
- Encryption key validity is checked at startup

## Streaming Credential Security

- YouTube Music and TIDAL OAuth tokens are AES-encrypted before database storage
- Credentials are isolated per user account
- Credentials are only decrypted for active sidecar operations
- TIDAL tokens are refreshed automatically and re-encrypted when needed

## Webhook and Admin Security

- Lidarr webhook signatures are supported and should be configured
- Bull Board (`/admin/queues`) requires authenticated admin access
- Swagger docs (`/api-docs`) require auth in production unless `DOCS_PUBLIC=true`

## Optional VPN Notes

If using Mullvad VPN for Soulseek:

- Put WireGuard config in `backend/mullvad/` (gitignored)
- Never commit private keys
- `*.conf` and `key.txt` are already ignored

## Generating Secrets

```bash
# Session secret
openssl rand -base64 32

# Settings encryption key
openssl rand -base64 32
```

## Network Safety Guidance

- soundspan is intended for self-hosted usage
- For internet exposure, place it behind HTTPS reverse proxy/tunnel
- Keep `ALLOWED_ORIGINS` strict and explicit
