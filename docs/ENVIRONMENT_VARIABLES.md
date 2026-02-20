# Environment Variables by Container

Centralized self-hosting reference for Docker deployments.

Scope:

- Covers deployment/runtime variables used by containerized services in this repo.
- Includes compose host-side variables (ports, image tags, container names, mounts).
- Excludes test-only/CI-only variables (`SOUNDSPAN_TEST_*`, Playwright helpers, etc.).

Primary sources:

- `docker-compose.yml`
- `docker-compose.aio.yml`
- `docker-compose.override.ha.yml`
- `docker-compose.services.yml`
- `docker-compose.local.yml`
- `backend/src/config.ts`
- `backend/src/utils/db.ts`
- `frontend/lib/api.ts`
- `frontend/lib/api-base-url.ts`
- `services/audio-analyzer/analyzer.py`
- `services/audio-analyzer-clap/analyzer.py`
- `services/tidal-downloader/app.py`
- `services/ytmusic-streamer/app.py`

Status labels:

- `Required`: must exist at runtime for service startup/feature operation (compose may still supply a default automatically).
- `Required (production)`: technically has a fallback, but must be explicitly set in real deployments.
- `Optional`: safe default exists, or feature is disabled when unset.

## Container Map

| Container / Service | File | Purpose |
| --- | --- | --- |
| `soundspan` | `docker-compose.aio.yml` | All-in-one image (frontend + backend + postgres + redis internal) |
| `backend` | `docker-compose.yml` | API service (or combined role) |
| `backend-worker` | `docker-compose.yml` | Background workers/schedulers |
| `frontend` | `docker-compose.yml` | Web UI (Next.js) |
| `postgres` | `docker-compose.yml` | PostgreSQL |
| `redis` | `docker-compose.yml` | Redis |
| `tidal-downloader` | `docker-compose.yml` | TIDAL sidecar |
| `ytmusic-streamer` | `docker-compose.yml` | YouTube Music sidecar |
| `audio-analyzer` | `docker-compose.yml` | MusicCNN/Essentia analyzer |
| `audio-analyzer-clap` | `docker-compose.yml` | CLAP embedding analyzer |
| `lidarr` | `docker-compose.services.yml` | Optional external Lidarr |
| `postgres-local` | `docker-compose.local.yml` | Local host-run Postgres |
| `redis-local` | `docker-compose.local.yml` | Local host-run Redis |
| `audio-analyzer-local` | `docker-compose.local.yml` | Local host-run analyzer profile |
| `audio-analyzer-clap-local` | `docker-compose.local.yml` | Local host-run CLAP profile |

## Core Runtime Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | `backend`, `backend-worker`, `audio-analyzer`, `audio-analyzer-clap` | Required | `postgresql://soundspan:changeme@postgres:5432/soundspan` (split stack) | PostgreSQL connection string. |
| `REDIS_URL` | `backend`, `backend-worker`, `audio-analyzer`, `audio-analyzer-clap` | Required | `redis://redis:6379` (split stack) | Redis connection for queues, sessions, claims, realtime state. |
| `POSTGRES_USER` | `backend`, `backend-worker`, `postgres` | Required | `soundspan` | PostgreSQL username (and used to build `DATABASE_URL`). |
| `POSTGRES_PASSWORD` | `backend`, `backend-worker`, `postgres` | Required (production) | `changeme` | PostgreSQL password (and used to build `DATABASE_URL`). |
| `POSTGRES_DB` | `backend`, `backend-worker`, `postgres` | Required | `soundspan` | PostgreSQL database name (and used to build `DATABASE_URL`). |
| `SESSION_SECRET` | `backend`, `soundspan` (AIO) | Required (production) | split stack: `changeme-generate-secure-key`; AIO compose: unset | Session/JWT signing secret; should be stable and 32+ chars. |
| `SETTINGS_ENCRYPTION_KEY` | `backend` | Required (production) | empty | Encrypts stored credentials/settings. |
| `MUSIC_PATH` | `backend`, `backend-worker`, `tidal-downloader`, analyzers; also mount control in compose | Required | split stack host mount: `./music`; AIO sample: `/path/to/your/music`; container path: `/music` | Library root path/mount. |
| `PORT` | `backend` (runtime), `frontend` (runtime), `soundspan` (AIO host publish var) | Optional | backend: `3006`; frontend: `3030`; AIO publish: `3030` | Service bind/publish port control (context-dependent by container). |
| `NODE_ENV` | `backend`, `backend-worker`, `frontend` | Optional | `production` (compose) | Runtime mode. |
| `BACKEND_PROCESS_ROLE` | `backend`, `backend-worker` | Optional | split stack: `all`; HA override for backend: `api`; worker: `worker` | Role split for API/worker processes. |
| `WORKER_HEALTH_PORT` | `backend-worker` | Optional | `3010` | Worker health endpoint port (`/health/live`, `/health/ready`). |
| `LOG_LEVEL` | `backend-worker` | Optional | `warn` | Worker log verbosity. |
| `DATABASE_POOL_SIZE` | `backend`, `backend-worker` | Optional | role-aware: `api=8`, `worker=4`, `all=12` | Prisma DB pool connection limit. |
| `DATABASE_POOL_TIMEOUT` | `backend`, `backend-worker` | Optional | `30` | Prisma DB pool timeout in seconds. |
| `LOG_QUERIES` | `backend`, `backend-worker` | Optional | `false` | Enables Prisma query logging in development. |
| `REDIS_FLUSH_ON_STARTUP` | `backend`, `backend-worker`, `soundspan` (AIO) | Optional | `false` | Preserves Redis streams/groups by default; do not flush on start. |
| `TRANSCODE_CACHE_PATH` | `backend` | Optional | `/app/cache/transcodes` (compose) | Directory for transcoding cache files. |
| `TRANSCODE_CACHE_MAX_GB` | `backend` | Optional | `10` | Max transcode cache size in GB. |
| `ALLOWED_ORIGINS` | `backend` | Optional | `http://localhost:3000,http://localhost:3030` | Allowed CORS origins (comma-separated). |
| `SECURE_COOKIES` | `backend` | Optional | `false` | Forces secure cookies when `true`. |
| `DOCS_PUBLIC` | `backend` | Optional | `false` | Allows public API docs in production when `true`. |
| `ADMIN_RESET_PASSWORD` | `backend` | Optional | unset | One-time startup password reset for admin account. |
| `JWT_SECRET` | `backend` | Optional | falls back to `SESSION_SECRET` | Explicit JWT signing secret override. |

## Distributed Runtime and Scheduler Controls

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `INTERNAL_API_SECRET` | `backend`, `backend-worker`, `audio-analyzer-clap` (+ local CLAP) | Required (production) | `soundspan-internal-secret-change-me` | Auth secret for internal analyzer callbacks and trusted internal routes. |
| `LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED` | `backend` | Optional | `true` | Enables Redis adapter fanout for cross-replica Socket.IO. |
| `LISTEN_TOGETHER_STATE_SYNC_ENABLED` | `backend` | Optional | `true` | Enables Redis pub/sub state sync for Listen Together. |
| `LISTEN_TOGETHER_STATE_STORE_ENABLED` | `backend` | Optional | `true` | Enables Redis-backed authoritative group state snapshots. |
| `LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS` | `backend` | Optional | `21600` | TTL for persisted Listen Together state. |
| `LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX` | `backend` | Optional | `listen-together:state` | Redis key prefix for Listen Together snapshots. |
| `LISTEN_TOGETHER_MUTATION_LOCK_ENABLED` | `backend` | Optional | `true` | Enables per-group distributed mutation lock. |
| `LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS` | `backend` | Optional | `3000` | Lock TTL for mutation critical sections. |
| `LISTEN_TOGETHER_MUTATION_LOCK_PREFIX` | `backend` | Optional | `listen-together:mutation-lock` | Redis key prefix for mutation locks. |
| `LISTEN_TOGETHER_RECONNECT_SLO_MS` | `backend` | Optional | `5000` | Reconnect latency warning threshold. |
| `LISTEN_TOGETHER_ALLOW_POLLING` | `backend` | Optional | `false` | Allows polling fallback transport when `true`. |
| `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` | `frontend` | Optional | `false` | Frontend polling fallback toggle for Listen Together socket client. |
| `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` | `backend`, `backend-worker` | Optional | `3` | Warn threshold for consecutive skipped scheduler claims. |
| `READINESS_REQUIRE_DEPENDENCIES` | `backend`, `backend-worker` | Optional | `true` | Makes readiness depend on Redis/Postgres health. |
| `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` | `backend`, `backend-worker` | Optional | `5000` | Min interval between readiness dependency checks. |
| `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` | `backend`, `backend-worker` | Optional | `2000` | Timeout per readiness dependency probe. |
| `DISCOVER_PROCESSOR_LOCK_TTL_MS` | `backend-worker` | Optional | `2700000` | TTL for per-user Discover processor lock claims. |
| `ENRICHMENT_CLAIM_TTL_MS` | `backend-worker` | Optional | `900000` | TTL for unified enrichment cycle claim lock. |
| `MOOD_BUCKET_CLAIM_TTL_MS` | `backend-worker` | Optional | `120000` | TTL for mood bucket worker cycle claim lock. |

## Frontend Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `BACKEND_URL` | `frontend` (and `audio-analyzer-clap-local` in local profile) | Optional (required when default route is not correct) | split stack: `http://backend:3006`; local CLAP: `http://host.docker.internal:3007` | Server-side URL used by frontend proxy/SSR and local CLAP callback target. |
| `NEXT_PUBLIC_API_URL` | `frontend` | Optional | empty | Explicit browser API base URL. |
| `NEXT_PUBLIC_API_PATH_MODE` | `frontend` | Optional | `auto` | Browser API routing mode: `auto`, `proxy`, or `direct`. |
| `NEXT_PUBLIC_BUILD_TYPE` | `frontend` (build-time) | Optional | `nightly` (compose build arg) | Marks build channel (nightly/release semantics). |
| `NEXT_PUBLIC_APP_VERSION` | `frontend` (build-time) | Optional | `frontend/package.json` version | Explicit app version override in UI. |
| `ANALYZE` | `frontend` (build-time) | Optional | unset (`false`) | Enables Next.js bundle analyzer when `true`. |

## Integration and Feature Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `SOUNDSPAN_CALLBACK_URL` | `backend`, `soundspan` (AIO) | Optional | split stack: `http://backend:3006`; AIO: `http://host.docker.internal:3030` | Callback URL used for webhook/integration callbacks (for example Lidarr completion hooks). |
| `LIDARR_ENABLED` | `backend`, `backend-worker` | Optional | `false` | Enables Lidarr integration logic from env fallback paths. |
| `LIDARR_URL` | `backend`, `backend-worker` | Required when `LIDARR_ENABLED=true` | unset | Lidarr base URL. |
| `LIDARR_API_KEY` | `backend`, `backend-worker` | Required when `LIDARR_ENABLED=true` | unset | Lidarr API key. |
| `LASTFM_API_KEY` | `backend`, `backend-worker` | Optional | built-in app key | Last.fm metadata/recommendation API key override. |
| `OPENAI_API_KEY` | `backend`, `backend-worker` | Optional | unset | OpenAI key for AI-assisted recommendation features. |
| `DEEZER_API_KEY` | `backend`, `backend-worker` | Optional | unset | Deezer API key override. |
| `DISCOVERY_MODE` | `backend`, `backend-worker` | Optional | `recommendation` | Discovery mode (`recommendation` or `legacy`). |
| `AUDIOBOOKSHELF_URL` | `backend`, `backend-worker` | Optional | unset | Audiobookshelf service URL (env fallback path). |
| `AUDIOBOOKSHELF_API_KEY` | `backend`, `backend-worker` | Optional (required if using API-key auth fallback) | unset | Audiobookshelf API key for env-based fallback configuration. |
| `AUDIOBOOKSHELF_TOKEN` | `backend`, `backend-worker` | Optional (required if using token auth fallback) | unset | Audiobookshelf token for env-based fallback configuration. |
| `TIDAL_SIDECAR_URL` | `backend` | Optional | `http://tidal-downloader:8585` | URL for TIDAL sidecar service. |
| `YTMUSIC_STREAMER_URL` | `backend` | Optional | `http://ytmusic-streamer:8586` | URL for YouTube Music sidecar service. |

## Sidecar Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `TIDDL_PATH` | `tidal-downloader` | Optional | `/data/.tiddl` | Sidecar data/config path for tiddl artifacts. |
| `TIDAL_TRACK_DELAY` | `tidal-downloader` | Optional | `3` | Delay between TIDAL track downloads (seconds). |
| `DEBUG` | `tidal-downloader`, `ytmusic-streamer` | Optional | unset | Debug logging toggle for sidecar services. |
| `YTMUSIC_DEBUG` | compose host variable mapping to `ytmusic-streamer:DEBUG` | Optional | unset | Convenience key in compose for ytmusic debug logging. |
| `DATA_PATH` | `ytmusic-streamer` | Optional | `/data` | Sidecar data/cache path. |
| `YTMUSIC_BATCH_CONCURRENCY` | `ytmusic-streamer` | Optional | `3` | Max concurrent batched search requests. |
| `YTMUSIC_BATCH_DELAY_MIN` | `ytmusic-streamer` | Optional | `0.3` | Min delay between batched search calls (seconds). |
| `YTMUSIC_BATCH_DELAY_MAX` | `ytmusic-streamer` | Optional | `1.0` | Max delay between batched search calls (seconds). |
| `YTMUSIC_EXTRACT_DELAY_MIN` | `ytmusic-streamer` | Optional | `0.5` | Min delay between stream extraction calls (seconds). |
| `YTMUSIC_EXTRACT_DELAY_MAX` | `ytmusic-streamer` | Optional | `2.0` | Max delay between stream extraction calls (seconds). |
| `YTMUSIC_SEARCH_CACHE_TTL` | `ytmusic-streamer` | Optional | `300` | Search cache TTL in seconds (`0` disables cache). |

## Analyzer Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `AUDIO_ANALYSIS_BATCH_SIZE` | compose host variable mapping to `audio-analyzer:BATCH_SIZE` | Optional | `10` | Batch size for MusicCNN analyzer. |
| `AUDIO_ANALYSIS_INTERVAL` | compose host variable mapping to `audio-analyzer:SLEEP_INTERVAL` | Optional | `5` | Loop interval between analyzer cycles (seconds). |
| `AUDIO_BRPOP_TIMEOUT` | compose host variable mapping to `audio-analyzer:BRPOP_TIMEOUT` | Optional | `30` | Redis blocking pop timeout for analyzer worker (seconds). |
| `AUDIO_MODEL_IDLE_TIMEOUT` | compose host variable mapping to `audio-analyzer:MODEL_IDLE_TIMEOUT` | Optional | `300` | Idle timeout before unloading analyzer ML models (seconds). |
| `AUDIO_ANALYSIS_WORKERS` | compose host variable mapping to `audio-analyzer:NUM_WORKERS` | Optional | `2` | Parallel MusicCNN analyzer workers. |
| `AUDIO_ANALYSIS_THREADS_PER_WORKER` | compose host variable mapping to `audio-analyzer:THREADS_PER_WORKER` | Optional | `1` | CPU threads per MusicCNN analyzer worker. |
| `MAX_FILE_SIZE_MB` | `audio-analyzer` | Optional | `500` | Hard file-size cap for analysis candidates (`0` disables cap). |
| `BATCH_ANALYSIS_TIMEOUT_SECONDS` | `audio-analyzer` | Optional | `900` | Timeout for a batch before failure handling. |
| `MAX_RETRIES` | `audio-analyzer` | Optional | `3` | Max retries for failed analyzer jobs. |
| `STALE_PROCESSING_MINUTES` | `audio-analyzer` | Optional | `15` | Resets tracks stuck in processing state after this age. |
| `MAX_ANALYZE_SECONDS` | `audio-analyzer` | Optional | `90` | Max audio duration analyzed per track clip. |
| `DB_RECONCILE_MIN_INTERVAL_SECONDS` | `audio-analyzer` | Optional | defaults to `BRPOP_TIMEOUT` | Minimum DB reconciliation interval while idle. |
| `DB_RECONCILE_MAX_INTERVAL_SECONDS` | `audio-analyzer` | Optional | `max(BRPOP_TIMEOUT*12, 60)` | Maximum DB reconciliation interval while idle. |
| `DB_RECONCILE_BACKOFF_MULTIPLIER` | `audio-analyzer` | Optional | `2.0` | Idle reconciliation backoff multiplier. |
| `CLAP_SLEEP_INTERVAL` | compose host variable mapping to `audio-analyzer-clap:SLEEP_INTERVAL` | Optional | `5` | Loop interval between CLAP analyzer cycles (seconds). |
| `CLAP_WORKERS` | compose host variable mapping to `audio-analyzer-clap:NUM_WORKERS` | Optional | `2` | Parallel CLAP workers. |
| `CLAP_THREADS_PER_WORKER` | compose host variable mapping to `audio-analyzer-clap:THREADS_PER_WORKER` | Optional | `1` | CPU threads per CLAP worker. |
| `CLAP_MODEL_IDLE_TIMEOUT` | compose host variable mapping to `audio-analyzer-clap:MODEL_IDLE_TIMEOUT` | Optional | `300` | Idle timeout before unloading CLAP model (seconds). |
| `TEXT_EMBED_GROUP` | `audio-analyzer-clap` | Optional | `clap:text:embed:group` | Redis stream consumer group for text embedding requests. |
| `TEXT_EMBED_RESPONSE_TTL_SECONDS` | `audio-analyzer-clap` | Optional | `120` | TTL for text embedding responses in Redis. |
| `TEXT_EMBED_CLAIM_IDLE_MS` | `audio-analyzer-clap` | Optional | `60000` | Idle time before pending text-embed messages can be claimed. |
| `TEXT_EMBED_CLAIM_BATCH` | `audio-analyzer-clap` | Optional | `10` | Batch size when claiming pending text-embed messages. |
| `TEXT_EMBED_CONSUMER_PREFIX` | `audio-analyzer-clap` | Optional | `HOSTNAME` or `clap` | Consumer-name prefix for CLAP text embedding stream worker. |

## Debug and Trace Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `PODCAST_DEBUG` | `backend` | Optional | `0` | Enables extra podcast streaming/cache debug logs when set to `1`. |
| `DEBUG_WEBHOOKS` | `backend` | Optional | `false` | Enables verbose webhook route diagnostics. |
| `SUBSONIC_TRACE_LOGS` | `backend` | Optional | `false` | Enables request/response trace logs for Subsonic endpoints. |

## Compose Host-Side Control Variables

These are read by Docker Compose itself and are not always injected into containers as runtime env vars.

| Variable | Applies To | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `SOUNDSPAN_AIO_IMAGE` | `docker-compose.aio.yml` | Optional | `ghcr.io/soundspan/soundspan` | AIO image repository. |
| `VERSION` | `docker-compose.aio.yml` | Optional | `latest` | AIO image tag. |
| `SOUNDSPAN_AIO_CONTAINER_NAME` | AIO container | Optional | `soundspan` | AIO container name override. |
| `SOUNDSPAN_AIO_DATA_VOLUME` | AIO volume | Optional | `soundspan_data` | AIO data volume name override. |
| `SOUNDSPAN_DB_CONTAINER_NAME` | split postgres | Optional | `soundspan_db` | Postgres container name override. |
| `SOUNDSPAN_REDIS_CONTAINER_NAME` | split redis | Optional | `soundspan_redis` | Redis container name override. |
| `SOUNDSPAN_TIDAL_CONTAINER_NAME` | split TIDAL sidecar | Optional | `soundspan_tidal_downloader` | TIDAL sidecar container name override. |
| `SOUNDSPAN_YTMUSIC_CONTAINER_NAME` | split ytmusic sidecar | Optional | `soundspan_ytmusic_streamer` | YTMusic sidecar container name override. |
| `SOUNDSPAN_AUDIO_ANALYZER_CONTAINER_NAME` | split analyzer | Optional | `soundspan_audio_analyzer` | MusicCNN analyzer container name override. |
| `SOUNDSPAN_CLAP_CONTAINER_NAME` | split CLAP analyzer | Optional | `soundspan_audio_analyzer_clap` | CLAP analyzer container name override. |
| `SOUNDSPAN_LIDARR_CONTAINER_NAME` | optional Lidarr | Optional | `soundspan_lidarr` | Lidarr container name override. |
| `SOUNDSPAN_NETWORK_NAME` | split stack network | Optional | `soundspan_network` | Docker network name override. |
| `BACKEND_PORT` | split backend port publish | Optional | `3006` (`0` recommended for local replica scale-out) | Host port mapped to backend container port `3006`. |
| `FRONTEND_PORT` | split frontend port publish | Optional | `3030` | Host port mapped to frontend container port `3030`. |
| `POSTGRES_PORT` | split postgres port publish | Optional | `5432` | Host port mapped to postgres container port `5432`. |
| `REDIS_PORT` | split redis port publish | Optional | `6379` | Host port mapped to redis container port `6379`. |
| `LIDARR_PORT` | optional Lidarr port publish | Optional | `8686` | Host port mapped to Lidarr container port `8686`. |
| `PORT` | AIO port publish | Optional | `3030` | Host port mapped to AIO container port `3030`. |
| `DOWNLOAD_PATH` | optional Lidarr volume mount | Optional | `./downloads` | Host download path mounted into Lidarr `/downloads`. |
| `PUID` | optional Lidarr | Optional | `1000` | Linux user ID for Lidarr container permissions. |
| `PGID` | optional Lidarr | Optional | `1000` | Linux group ID for Lidarr container permissions. |
| `TZ` | AIO + optional Lidarr | Optional | `UTC` | Container timezone. |

## Local Host-Run Profile Variables

Used primarily with `docker-compose.local.yml` (host-run backend/frontend; containers for infra + optional analyzers):

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `BACKEND_URL` | `audio-analyzer-clap-local` | Optional | `http://host.docker.internal:3007` | Local CLAP callback target to host-run backend. |
| `CLAP_SLEEP_INTERVAL` | `audio-analyzer-clap-local` | Optional | `5` | CLAP local analyzer loop interval. |
| `CLAP_WORKERS` | `audio-analyzer-clap-local` | Optional | `2` | CLAP local worker count. |
| `CLAP_THREADS_PER_WORKER` | `audio-analyzer-clap-local` | Optional | `1` | CLAP local threads per worker. |
| `CLAP_MODEL_IDLE_TIMEOUT` | `audio-analyzer-clap-local` | Optional | `300` | CLAP local model idle unload timeout. |
| `INTERNAL_API_SECRET` | `audio-analyzer-clap-local` | Required (production-like validation) | `soundspan-internal-secret-change-me` | Internal callback auth between CLAP local analyzer and backend. |

## Operational Notes

| Topic | Recommendation |
| --- | --- |
| Secrets | Always set `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, and `INTERNAL_API_SECRET` explicitly in production. |
| API routing mode | Keep `NEXT_PUBLIC_API_PATH_MODE=auto` unless you intentionally need direct browser calls (`direct`). |
| HA behavior | Keep Listen Together Redis/state/lock flags enabled for multi-replica correctness. |
| Drift control | When adding/changing/removing env vars in compose, backend/frontend config, or sidecars, update this file in the same PR. |
