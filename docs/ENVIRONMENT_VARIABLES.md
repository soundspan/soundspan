# Environment Variables by Container

Centralized self-hosting reference for Docker deployments. For configuration guidance, security hardening, and operational patterns, see [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md).

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

Experimental feature note:

- Segmented-streaming variables are documented in detail in [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md). They form four families, all optional with safe defaults:
  - **Cache:** `SEGMENTED_STREAMING_CACHE_PATH` (default: `TRANSCODE_CACHE_PATH`), `SEGMENTED_STREAMING_CACHE_MAX_GB` (default: `TRANSCODE_CACHE_MAX_GB`), `SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS`, `SEGMENTED_STREAMING_CACHE_MIN_AGE_MS`, `SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO` (clamped to `0.1`–`0.99`), and `SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION`.
  - **DASH build lock:** `SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED` (default `true`), `SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX` (default `segmented-streaming:dash-build-lock`), `SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS`.
  - **Segment duration:** `SEGMENTED_LOCAL_SEG_DURATION_SEC` (positive number).
  - **Trace logging:** `STREAMING_TRACE_LOGS` / `SEGMENTED_STREAMING_TRACE_LOGS` (truthy: `1`, `true`, `yes`, `on`).

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
| `POSTGRES_PASSWORD` | `backend`, `backend-worker`, `postgres`, `soundspan` (AIO) | Required (production) | split stack: `changeme`; AIO: generated when unset | PostgreSQL password (and used to build `DATABASE_URL`). In AIO, an operator value is honored and persisted to `/data/secrets/postgres_password`; otherwise a strong value is generated once and persisted there. |
| `POSTGRES_DB` | `backend`, `backend-worker`, `postgres` | Required | `soundspan` | PostgreSQL database name (and used to build `DATABASE_URL`). |
| `SESSION_SECRET` | `backend`, `soundspan` (AIO) | Required | split stack: none (compose refuses to start without it); AIO: operator value honored, else persisted/generated at `/data/secrets/session_secret` | Session/JWT signing secret; must be stable and 32+ chars. The backend image's entrypoint fails fast when it is unset, still the old published default, or shorter than 32 chars (generate with `openssl rand -base64 32`). In AIO, an operator value takes precedence and is written through to `/data/secrets`; otherwise the persisted or a newly generated value is used. |
| `SETTINGS_ENCRYPTION_KEY` | `backend`, `soundspan` (AIO) | Required | split stack: none (compose refuses to start without it); AIO: operator value honored, else persisted/generated at `/data/secrets/encryption_key` | Encrypts stored credentials/settings. The backend image's entrypoint fails fast when it is unset or the insecure default (generate with `openssl rand -base64 32`); it must stay stable or encrypted data becomes unreadable. In AIO, an operator value takes precedence and is written through to `/data/secrets`; otherwise the persisted or a newly generated value is used. |
| `SETTINGS_DECRYPT_FAIL_CLOSED` | `backend`, `backend-worker` | Optional | `false` | When `true`, the legacy (pre-GCM, AES-256-CBC / plaintext-passthrough) at-rest decryption path fails **closed**: a stored value that is not an authenticated `v2:` envelope throws instead of being returned verbatim. Leave `false` until `GET /api/admin/secrets-status` reports `settingsCipher.legacy: 0` (v1→v2 migration complete); flipping it before then would make any remaining legacy/plaintext value unreadable. Authenticated `v2` ciphertext always fails closed regardless of this flag. See `docs/UPGRADING.md`. |
| `SECRETS_DB_ONLY` | `backend`, `backend-worker` | Optional | `false` | When `true`, integration secrets are read only from encrypted System Settings for exactly these keys: `LASTFM_API_KEY`, `FANART_API_KEY`, `LIDARR_API_KEY`, `OPENAI_API_KEY`, `DEEZER_API_KEY`, and `AUDIOBOOKSHELF_API_KEY`. Their env fallbacks are ignored and settings-driven `.env` sync omits them. The database/settings layer must be initialized before backend and worker services start; startup fails fast when it is unreadable. This may become the default in a future release once deployments no longer rely on `.env`-sourced integration keys. |
| `MUSIC_PATH` | `backend`, `backend-worker`, `tidal-downloader`, analyzers; also mount control in compose | Required | split stack host mount: `./music`; AIO sample: `/path/to/your/music`; container path: `/music` | Library root path/mount. |
| `PORT` | `backend` (runtime), `frontend` (runtime), `soundspan` (AIO host publish var) | Optional | backend: `3006`; frontend: `3030`; AIO publish: `3030` | Service bind/publish port control (context-dependent by container). |
| `NODE_ENV` | `backend`, `backend-worker`, `frontend` | Optional | `production` (compose) | Runtime mode. |
| `BACKEND_PROCESS_ROLE` | `backend`, `backend-worker` | Optional | split stack: `all`; HA override for backend: `api`; worker: `worker` | Role split for API/worker processes. |
| `WORKER_HEALTH_PORT` | `backend-worker` | Optional | `3010` | Worker health endpoint port (`/health/live`, `/health/ready`). |
| `WORKER_EVENT_LOOP_WARN_MS` | `backend-worker` | Optional | `1000` | Event-loop stall watchdog: stalls at or above this many milliseconds log a warning naming the active Bull jobs. |
| `WORKER_EVENT_LOOP_SAMPLE_MS` | `backend-worker` | Optional | `5000` | Event-loop stall watchdog sampling interval in milliseconds. |
| `GENERATION_ARTIST_WEIGHT_ALPHA` | `backend` | Optional | `0.5` | Artist-diversity damping exponent for generated queues/mixes: each artist weighs `n^alpha` (`0` = one share each, `1` = fully proportional to discography size). |
| `GENERATION_ARTIST_SHARE_CEILING` | `backend` | Optional | `0.3` | Hard per-artist ceiling for generated queues/mixes as a share of the queue size — no artist can exceed this share regardless of discography size. |
| `LOG_LEVEL` | `backend`, `backend-worker`, python sidecars using shared logger | Optional | backend-worker compose: `warn`; otherwise env-dependent defaults | Shared logger verbosity (`debug`, `info`, `warn`, `error`, `silent` for TS; Python also supports `critical`). |
| `DATABASE_POOL_SIZE` | `backend`, `backend-worker` | Optional | role-aware: `api=8`, `worker=4`, `all=12` | Prisma DB pool connection limit. |
| `DATABASE_POOL_TIMEOUT` | `backend`, `backend-worker` | Optional | `30` | Prisma DB pool timeout in seconds. |
| `LOG_QUERIES` | `backend`, `backend-worker` | Optional | `false` | Enables Prisma query logging in development. |
| `IVFFLAT_PROBES` | `backend`, `backend-worker` | Optional | `32` | pgvector `ivfflat.probes` for "similar tracks" / vibe ANN queries — how many of the embedding index's 224 inverted lists each query scans, applied per-query on the same connection via a transaction-scoped `set_config`. Postgres' default of `1` makes recall near-random; the `32` default was benchmark-tuned for recall@10 ≈ 0.96 on the reference corpus. Higher = better recall, more scan cost. Values outside `1..32768` are clamped (Postgres only warns server-side and silently keeps probes=1 otherwise). |
| `REDIS_FLUSH_ON_STARTUP` | `backend`, `backend-worker`, `soundspan` (AIO) | Optional | `false` everywhere (compose files, the Helm chart's `config.redisFlushOnStartup`, and the backend image's entrypoint fallback) | When `true`, the backend image's entrypoint runs a destructive `FLUSHALL` against the configured Redis at container start. The safe default is `false` in every shipped config **and** in the entrypoint itself, preserving the Redis Streams/consumer-group state the analyzers rely on; opt in explicitly only for a dedicated-Redis cache clear. |
| `TRANSCODE_CACHE_PATH` | `backend` | Optional | `/app/cache/transcodes` (compose) | Directory for transcoding cache files. |
| `TRANSCODE_CACHE_MAX_GB` | `backend` | Optional | `10` | Max transcode cache size in GB. |
| `BROWSE_IMAGE_CACHE_MAX_BYTES` | `backend`, `soundspan` (AIO) | Optional | `268435456` (256 MiB) | Maximum combined bytes for cached browse thumbnails and their metadata sidecars; least-recently-used entries are evicted before writes exceed the bound. |
| `BROWSE_IMAGE_CACHE_MAX_ENTRIES` | `backend`, `soundspan` (AIO) | Optional | `2048` | Maximum cached browse-thumbnail entries; each entry includes an image and optional metadata sidecar. |
| `FFMPEG_PATH` | `backend` | Optional | bundled/system ffmpeg | Absolute path override for the ffmpeg binary used by segmented streaming; when unset, `/usr/bin/ffmpeg` is used if present, otherwise the bundled `@ffmpeg-installer/ffmpeg`. |
| `ALLOWED_ORIGINS` | `backend` | Optional | unset (production denies cross-origin; development allows all) | Allowed CORS origins (comma-separated), e.g. `https://app.example.com`. When unset, production denies cross-origin browser requests (deny-by-default; same-origin and no-`Origin` requests unaffected). |
| `CORS_ALLOW_ALL` | `backend` | Optional | `false` | Set `true` to restore the legacy permissive CORS behavior (reflect any origin with credentials) when no `ALLOWED_ORIGINS` allowlist is configured. Prefer `ALLOWED_ORIGINS`. See `docs/UPGRADING.md`. |
| `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED` | `backend` | Optional | `false` | Set `true` to let `POST /api/webhooks/lidarr` accept requests when no webhook secret is configured in System Settings (legacy fail-open behavior). Default rejects with 401 (fail closed). See `docs/UPGRADING.md`. |
| `SECURE_COOKIES` | `backend` | Optional | `true` when `NODE_ENV=production`, else `false` | Session cookie `secure` flag. Set `false` explicitly for a production-mode deploy served over plain HTTP (e.g. LAN without TLS), or logins will not persist. |
| `TRUST_PROXY_HOPS` | `backend` | Optional | unset (trust all hops) | Express `trust proxy` depth. Set to your real reverse-proxy count (usually `1`) for spoof-resistant client-IP resolution in rate limiting; unset preserves the legacy trust-all behavior. |
| `DOCS_PUBLIC` | `backend` | Optional | `false` | Allows public API docs in production when `true`. |
| `ADMIN_RESET_PASSWORD` | `backend` | Optional | unset | One-time startup password reset for admin account. |
| `JWT_SECRET` | `backend` | Optional | falls back to `SESSION_SECRET` | Explicit JWT signing secret override. |

## Distributed Runtime and Scheduler Controls

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `INTERNAL_API_SECRET` | `backend`, `backend-worker`, `soundspan` (AIO), `audio-analyzer-clap` (+ local CLAP), `ytmusic-streamer`, `tidal-downloader` | Required | none — `docker-compose.yml` refuses to start without it (generate with `openssl rand -base64 32`), and the HTTP sidecars reject the old published `soundspan-internal-secret-change-me` value as unconfigured; AIO honors an operator value, else generates & persists when unset | Auth secret for internal analyzer callbacks, trusted internal routes, and backend→HTTP-sidecar auth (F31). The ytmusic-streamer/tidal-downloader FastAPI sidecars now **reject** any request without the matching `x-internal-secret` header (fail-closed; `/health` is exempt), so this must be set to the same value on the backend and both HTTP sidecars. In AIO, an operator value takes precedence and is persisted to `/data/secrets/internal_api_secret`; otherwise the persisted or a newly generated value is used. |
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
| `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` | `backend`, `backend-worker` | Optional | `3` | Warn threshold for consecutive skipped scheduler claims. |
| `READINESS_REQUIRE_DEPENDENCIES` | `backend`, `backend-worker` | Optional | `true` | Makes readiness depend on Redis/Postgres health. |
| `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` | `backend`, `backend-worker` | Optional | `5000` | Min interval between readiness dependency checks. |
| `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` | `backend`, `backend-worker` | Optional | `2000` | Timeout per readiness dependency probe. |
| `DISCOVER_PROCESSOR_LOCK_TTL_MS` | `backend-worker` | Optional | `2700000` | TTL for per-user Discover processor lock claims. |
| `ENRICHMENT_CLAIM_TTL_MS` | `backend-worker` | Optional | `900000` | TTL for unified enrichment cycle claim lock. |
| `MOOD_BUCKET_CLAIM_TTL_MS` | `backend-worker` | Optional | `120000` | TTL for mood bucket worker cycle claim lock. |
| `TRACK_RECONCILIATION_MAX_ROWS` | `backend`, `backend-worker` | Optional | `10000` | Hard per-run row cap for remote-to-local track mapping reconciliation. The scheduler persists a shared keyset cursor in Redis so later runs continue across larger backlogs. Valid values are `1..100000`; invalid values use the default. |
| `TRACK_RECONCILIATION_TIMEOUT_MS` | `backend`, `backend-worker` | Optional | `600000` | Deadline for one remote-to-local track mapping reconciliation run. Valid values are `1..3300000` (55 minutes); invalid values use the default. In-flight Prisma queries finish before cancellation is observed. |

## Frontend Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `BACKEND_URL` | `frontend` (and `audio-analyzer-clap-local` in local profile) | Optional (required when default route is not correct) | split stack: `http://backend:3006`; local CLAP: `http://host.docker.internal:3007` | Server-side URL used by frontend proxy/SSR and local CLAP callback target. |
| `STREAMING_ENGINE_MODE` | `frontend`, `soundspan` (AIO) | Optional | `native` | Playback engine selection, validated by the container entrypoint: `native` (default as of 1.8.0 — single native `<audio>` element; see [`NATIVE_AUDIO_ENGINE.md`](NATIVE_AUDIO_ENGINE.md)), `howler` (legacy engine, the gated fallback/opt-out — Android WebView deployments are pinned to it automatically regardless of this setting), or `videojs` (segmented experimental playback; see [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md)). Container runtime env, not a `NEXT_PUBLIC_*` build arg; an unrecognized value logs a warning and falls back to `native`. |
| `NEXT_PUBLIC_API_URL` | `frontend` (build-time) | Optional (build-time only) | empty | Explicit browser API base URL. Runtime changes on prebuilt images do not affect browser bundle behavior. |
| `NEXT_PUBLIC_API_PATH_MODE` | `frontend` (build-time) | Optional (build-time only) | `auto` | Browser API routing mode: `auto`, `proxy`, or `direct`. Runtime changes on prebuilt images do not affect browser bundle behavior. |
| `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` | `frontend` (build-time) | Optional (build-time only) | `false` | Browser polling fallback toggle for Listen Together socket client. Runtime changes on prebuilt images do not affect browser bundle behavior. |
| `NEXT_PUBLIC_LOG_LEVEL` | `frontend` (build-time) | Optional (build-time only) | `info` (dev), `warn` (prod) | Browser-visible frontend logger verbosity (`debug`, `info`, `warn`, `error`, `silent`). Uses `NEXT_PUBLIC_` because client-side code cannot read non-public env vars. |
| `NEXT_PUBLIC_BUILD_TYPE` | `frontend` (build-time) | Optional (build-time only) | `nightly` (compose build arg) | Marks build channel (nightly/release semantics). |
| `NEXT_PUBLIC_APP_VERSION` | `frontend` (build-time) | Optional (build-time only) | `frontend/package.json` version | Explicit app version override in UI. |
| `ANALYZE` | `frontend` (build-time) | Optional (build-time only) | unset (`false`) | Enables Next.js bundle analyzer when `true`. |

## Integration and Feature Variables

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `SOUNDSPAN_CALLBACK_URL` | `backend`, `soundspan` (AIO) | Optional | split stack: `http://backend:3006`; AIO: `http://host.docker.internal:3030` | Callback URL used for webhook/integration callbacks (for example Lidarr completion hooks). |
| `AUDIO_ANALYSIS_ENABLED` | `backend`, `backend-worker` | Optional | `true` | Feature flag for audio analysis queueing/consumption (Essentia + CLAP vibe embeddings), the mood-bucket worker, and the `/api/analysis` + `/api/vibe` routes. Set `false` to disable; analyzer containers should then also be disabled. |
| `AUDIO_ANALYSIS_QUEUE_MAX_DEPTH` | `backend-worker` | Optional | `100` | Maximum number of pending MusicCNN jobs admitted to Redis. Additional pending tracks remain in PostgreSQL until capacity is available. |
| `VIBE_ANALYSIS_QUEUE_MAX_DEPTH` | `backend-worker` | Optional | `100` | Maximum number of pending CLAP jobs admitted to Redis. Additional pending tracks remain in PostgreSQL until capacity is available. |
| `ANALYSIS_QUEUE_RESERVATION_TTL_SECONDS` | `backend-worker` | Optional | `3600` | TTL for per-track Redis admission reservations that suppress duplicate queue entries. Maximum accepted value is 86400 seconds. |
| `DISCOVERY_ENABLED` | `backend`, `backend-worker` | Optional | `true` | Feature flag for Discover Weekly (cron + queue processors), the `/api/discover` + `/api/recommendations` routes, and the discovery auto-download lifecycle. |
| `AUTO_PLAYLISTS_ENABLED` | `backend`, `backend-worker` | Optional | `true` | Feature flag for Made For You mixes (on-demand programmatic playlists) and the `/api/mixes` routes. |
| `LIDARR_ENABLED` | `backend`, `backend-worker` | Optional | `false` | Enables Lidarr integration logic from env fallback paths. |
| `LIDARR_URL` | `backend`, `backend-worker` | Required when `LIDARR_ENABLED=true` | unset | Lidarr base URL. |
| `LIDARR_API_KEY` | `backend`, `backend-worker` | Required when `LIDARR_ENABLED=true` | unset | Lidarr API key. |
| `LASTFM_API_KEY` | `backend`, `backend-worker` | Optional | unset | Last.fm metadata/recommendation API key. When unset, Last.fm features stay disabled unless an encrypted system setting supplies a key. |
| `FANART_API_KEY` | `backend` | Optional | unset | Fanart.tv API key for artist images/backgrounds. A database-stored key (System Settings) takes precedence; this var is the `.env` fallback used only when no key is stored. By default, the background enrichment cycle's `ImageProviderService` retains its historical env-only behavior. Under `SECRETS_DB_ONLY=true`, that enrichment path instead reads the stored System Settings key and ignores this env var. |
| `OPENAI_API_KEY` | `backend`, `backend-worker` | Optional | unset | OpenAI key for AI-assisted recommendation features. |
| `DEEZER_API_KEY` | `backend`, `backend-worker` | Optional | unset | Deezer API key override. |
| `DISCOVERY_MODE` | `backend`, `backend-worker` | Optional | `recommendation` | Discovery mode (`recommendation` or `legacy`). |
| `AUDIOBOOKSHELF_URL` | `backend`, `backend-worker` | Optional | unset | Audiobookshelf service URL (env fallback path). |
| `AUDIOBOOKSHELF_API_KEY` | `backend`, `backend-worker` | Optional (required if using the env fallback) | unset | Audiobookshelf API key for env-based fallback configuration. Consumed with `AUDIOBOOKSHELF_URL` via `config.audiobookshelf` when no database-stored Audiobookshelf settings exist. |
| `TIDAL_SIDECAR_URL` | `backend` | Optional | `http://tidal-downloader:8585` | URL for TIDAL sidecar service. |
| `YTMUSIC_STREAMER_URL` | `backend` | Optional | `http://ytmusic-streamer:8586` | URL for YouTube Music sidecar service. |
| `YTMUSIC_REGION` | `backend` | Optional | `US` | Region hint passed to the YouTube Music browse/discovery proxies. |

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
| `YTMUSIC_EXTRACT_TIMEOUT` | `ytmusic-streamer` | Optional | `60` | Overall per-request deadline (seconds) for yt-dlp stream-URL extraction; on expiry the request fails fast with HTTP 504 instead of hanging. |
| `YTMUSIC_YTDLP_SOCKET_TIMEOUT` | `ytmusic-streamer` | Optional | `20` | yt-dlp `socket_timeout` (seconds) bounding individual network reads during extraction and downloads, so a stalled worker thread eventually frees. |
| `YTMUSIC_SEARCH_CACHE_TTL` | `ytmusic-streamer` | Optional | `300` | Search cache TTL in seconds (`0` disables cache). |
| `YTMUSIC_SEARCH_CACHE_MAX` | `ytmusic-streamer` | Optional | `1024` | Max in-memory search-cache entries; the oldest are evicted past this bound to cap memory. |
| `YTMUSIC_STREAM_CACHE_MAX` | `ytmusic-streamer` | Optional | `1024` | Max in-memory stream-URL cache entries; the oldest are evicted past this bound to cap memory. |
| `YTMUSIC_SEARCH_MODE` | `ytmusic-streamer` | Optional | `auto` | Search strategy: `auto` (native-first with per-user TV fallback on #813 invalid-argument errors), `tv` (legacy TV parser), or `native` (`ytmusicapi` `yt.search()` only). |
| `YTMUSIC_LANGUAGE` | `ytmusic-streamer` | Optional | `en` | BCP-47 language code forwarded to all `YTMusic()` client instances; controls the language of shelf titles and content descriptions regardless of the server's geo-IP locale. |
| `YTMUSIC_HOME_FILTERED_SHELVES` | `ytmusic-streamer` | Optional | `Quick picks` | Comma-separated, case-insensitive list of shelf titles to exclude from `/home` responses. |
| `YT_DOWNLOAD_DIR` | `ytmusic-streamer` | Optional | `/music/YouTube Downloads` | Destination directory for `/yt/download` audio files. Must live inside the shared `/music` volume so the backend's library scanner picks up completed downloads; Helm deployments need an RWX music volume in multi-node clusters. |
| `YT_DOWNLOAD_CONCURRENCY` | `ytmusic-streamer` | Optional | `2` | Max concurrent YouTube download jobs processed by the sidecar's download worker pool. |

## Analyzer Variables

The AIO image maps its deployment-facing analyzer variables into the MusicCNN
and CLAP runtime names; values set through Helm `aio.env` or the AIO container
environment are effective.

| Variable | Used In Container(s) | Required | Default | What It Does |
| --- | --- | --- | --- | --- |
| `AUDIO_ANALYSIS_BATCH_SIZE` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer:BATCH_SIZE` | Optional | `10` | Batch size for MusicCNN analyzer. |
| `AUDIO_ANALYSIS_INTERVAL` | compose host variable mapping to `audio-analyzer:SLEEP_INTERVAL` | Optional | `5` | Loop interval between analyzer cycles (seconds). |
| `AUDIO_BRPOP_TIMEOUT` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer:BRPOP_TIMEOUT` | Optional | `30` | Redis blocking pop timeout for analyzer worker (seconds). |
| `AUDIO_REDIS_SOCKET_TIMEOUT` | `soundspan` (AIO) and `audio-analyzer` | Optional | `35` | Redis socket read timeout for the MusicCNN queue worker (seconds). The runtime enforces an effective minimum of `BRPOP_TIMEOUT + 5` so blocking queue polls complete before the socket deadline. |
| `AUDIO_MODEL_IDLE_TIMEOUT` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer:MODEL_IDLE_TIMEOUT` | Optional | `300` | Idle timeout before unloading analyzer ML models (seconds). |
| `AUDIO_ANALYSIS_WORKERS` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer:NUM_WORKERS` | Optional | `2` | Parallel MusicCNN analyzer workers. |
| `AUDIO_ANALYSIS_THREADS_PER_WORKER` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer:THREADS_PER_WORKER` | Optional | `1` | CPU threads per MusicCNN analyzer worker. |
| `MAX_FILE_SIZE_MB` | `audio-analyzer` | Optional | `500` | Hard file-size cap for analysis candidates (`0` disables cap). |
| `BATCH_ANALYSIS_TIMEOUT_SECONDS` | `audio-analyzer` | Optional | `900` | Timeout for a batch before failure handling. |
| `MAX_RETRIES` | `audio-analyzer` | Optional | `3` | Max retries for failed analyzer jobs. |
| `STALE_PROCESSING_MINUTES` | `audio-analyzer` | Optional | `15` | Resets tracks stuck in processing state after this age. |
| `MAX_ANALYZE_SECONDS` | `audio-analyzer` | Optional | `90` | Max audio duration analyzed per track clip. |
| `DB_RECONCILE_MIN_INTERVAL_SECONDS` | `audio-analyzer` | Optional | defaults to `BRPOP_TIMEOUT` | Minimum DB reconciliation interval while idle. |
| `DB_RECONCILE_MAX_INTERVAL_SECONDS` | `audio-analyzer` | Optional | `max(BRPOP_TIMEOUT*12, 60)` | Maximum DB reconciliation interval while idle. |
| `DB_RECONCILE_BACKOFF_MULTIPLIER` | `audio-analyzer` | Optional | `2.0` | Idle reconciliation backoff multiplier. |
| `CLAP_SLEEP_INTERVAL` | compose host variable mapping to `audio-analyzer-clap:SLEEP_INTERVAL` | Optional | `5` | Loop interval between CLAP analyzer cycles (seconds). |
| `CLAP_REDIS_SOCKET_TIMEOUT` | `soundspan` (AIO) and compose host variable mapping to `audio-analyzer-clap:CLAP_REDIS_SOCKET_TIMEOUT` | Optional | `10` | Redis socket read timeout for the CLAP queue worker (seconds). The runtime enforces an effective minimum of `CLAP_SLEEP_INTERVAL + 5` so blocking queue polls complete before the socket deadline. |
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
| `POSTGRES_PORT` | split postgres port publish | Optional | `5432` | Host port mapped to postgres container port `5432`. Bound to `127.0.0.1` only; see docs/UPGRADING.md for the override-file escape hatch to publish on other interfaces. |
| `REDIS_PORT` | split redis port publish | Optional | `6379` | Host port mapped to redis container port `6379`. Bound to `127.0.0.1` only; see docs/UPGRADING.md for the override-file escape hatch to publish on other interfaces. |
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
| `AUDIO_REDIS_SOCKET_TIMEOUT` | `audio-analyzer-local` | Optional | `15` | MusicCNN Redis socket read timeout; effective minimum is local `BRPOP_TIMEOUT + 5` seconds. |
| `CLAP_SLEEP_INTERVAL` | `audio-analyzer-clap-local` | Optional | `5` | CLAP local analyzer loop interval. |
| `CLAP_REDIS_SOCKET_TIMEOUT` | `audio-analyzer-clap-local` | Optional | `10` | CLAP Redis socket read timeout; effective minimum is `CLAP_SLEEP_INTERVAL + 5` seconds. |
| `CLAP_WORKERS` | `audio-analyzer-clap-local` | Optional | `2` | CLAP local worker count. |
| `CLAP_THREADS_PER_WORKER` | `audio-analyzer-clap-local` | Optional | `1` | CLAP local threads per worker. |
| `CLAP_MODEL_IDLE_TIMEOUT` | `audio-analyzer-clap-local` | Optional | `300` | CLAP local model idle unload timeout. |
| `INTERNAL_API_SECRET` | `audio-analyzer-clap-local` | Required (production-like validation) | empty (fails closed — the backend rejects callbacks with 403 until a real value is set in `.env`) | Internal callback auth between CLAP local analyzer and backend. The old published default is no longer shipped anywhere. |

## Operational Notes

| Topic | Recommendation |
| --- | --- |
| Secrets | Always set `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, and `INTERNAL_API_SECRET` explicitly in production. |
| API routing mode | Keep `NEXT_PUBLIC_API_PATH_MODE=auto` unless you intentionally need direct browser calls (`direct`). |
| Frontend build-time vars | In prebuilt frontend images, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_PATH_MODE`, and `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` require an image rebuild to change browser behavior. |
| HA behavior | Keep Listen Together Redis/state/lock flags enabled for multi-replica correctness. |
| Drift control | When adding/changing/removing env vars in compose, backend/frontend config, or sidecars, update this file in the same PR. |
