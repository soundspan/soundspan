# Architecture

High-level runtime topology, request flows, and service interaction patterns for soundspan.

## Service Topology

```mermaid
graph TD
    Browser["Browser"]
    FE["frontend<br/>Next.js :3030"]
    BE["backend<br/>Express.js :3006"]
    BW["backend-worker<br/>Express.js :3010<br/>(optional profile)"]
    PG["PostgreSQL<br/>pgvector/pg16 :5432"]
    RD["Redis 7 :6379"]
    TD["tidal-downloader<br/>FastAPI :8585"]
    YT["ytmusic-streamer<br/>FastAPI :8586"]
    AA["audio-analyzer<br/>Essentia/MusiCNN"]
    AC["audio-analyzer-clap<br/>LAION-CLAP"]

    Browser -->|HTTP/WS| FE
    FE -->|"custom-server streaming proxy /api/*, /rest/*, Listen Together WS"| BE
    BE --> PG
    BE --> RD
    BW --> PG
    BW --> RD
    BE -->|HTTP| TD
    BE -->|HTTP| YT
    AA --> PG
    AA --> RD
    AC --> PG
    AC --> RD
    AC -->|HTTP| BE
```

## Service Communication Map

| Source | Target | Protocol | Port | Auth | Purpose |
|--------|--------|----------|------|------|---------|
| frontend | backend | HTTP (custom-server streaming proxy `/api/*`; Next route-handler fallback) | 3006 | JWT cookie | All API requests (admin-only surfaces such as Library Health and Bull Board included) |
| frontend | backend | WebSocket (Socket.IO, proxied by the custom server) | 3006 | JWT (`handshake.auth.token`) | Listen Together real-time sync |
| backend | PostgreSQL | TCP (Prisma) | 5432 | Connection string | All persistent state |
| backend | Redis | TCP | 6379 | None | Listen Together presence/state, cache, pub/sub, stream queues |
| backend | tidal-downloader | HTTP | 8585 | `INTERNAL_API_SECRET` header | TIDAL OAuth, search, stream extraction, downloads |
| backend | ytmusic-streamer | HTTP | 8586 | None (sidecar-internal) | YT Music OAuth, search, stream proxy, browse shelves; `/yt/*` pasted-URL preview/stream/download jobs |
| backend-worker | PostgreSQL | TCP (Prisma) | 5432 | Connection string | Background job state |
| backend-worker | Redis | TCP | 6379 | None | Job queues (BullMQ/streams), scheduler claims |
| audio-analyzer | PostgreSQL | TCP (direct) | 5432 | Connection string | Analysis results write |
| audio-analyzer | Redis | TCP | 6379 | None | BRPOP job queue |
| audio-analyzer-clap | PostgreSQL | TCP (direct) | 5432 | Connection string | Embedding writes |
| audio-analyzer-clap | Redis | TCP | 6379 | None | BRPOP job queue |
| audio-analyzer-clap | backend | HTTP | 3006 | `INTERNAL_API_SECRET` | Track metadata lookup |

## Compose File Matrix

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Split-stack deployment (canonical ports) |
| `docker-compose.aio.yml` | All-in-one single container |
| `docker-compose.local.yml` | Local npm/tsx dev with +1 ports (3031/3007) |
| `docker-compose.services.yml` | Optional Lidarr service |
| `docker-compose.override.ha.yml` | HA-focused override |
| `docker-compose.override.lite-mode.yml` | Analyzer-disabled override |

## Request Flows

### Browser to API

```
Browser → frontend:3030 → custom-server streaming proxy /api/* → backend:3006 → Prisma → PostgreSQL
```

The frontend's custom server (`frontend/server.js` + `frontend/server-proxy.js`) streams all `/api/*` requests to the backend via http-proxy-middleware — no body buffering, backend gzip and streaming preserved — enforcing a configurable time-to-first-byte budget (`PROXY_REQUEST_TIMEOUT_MS`, default 20s; `PROXY_IMPORT_PREVIEW_TIMEOUT_MS`, default 90s → `504 UPSTREAM_TIMEOUT`). The Next route handler at `app/api/[...path]` remains as a fallback. The browser never talks to the backend directly. `frontend/lib/api.ts` is the canonical API boundary — no direct `fetch` calls from components.

### Music Playback (Local Library)

```
Browser → GET /api/streaming/track/:id → backend reads file from /music → audio stream response
```

Local files are served directly from the mounted `/music` volume. Transcoded variants are cached in `backend_cache` volume.

### Gap-Fill Playback (TIDAL)

```
Browser → GET /api/tidal-streaming/stream/:tidalId
  → backend → tidal-downloader:8585/stream
    → tidal-downloader uses tiddl + per-user OAuth token → TIDAL CDN
  → audio stream proxied back to browser
```

Each user authenticates their own TIDAL account via device-code OAuth flow. Stream quality is per-user configurable. The backend looks up the user's encrypted OAuth credentials from `UserSettings.tidalOAuthJson`.

TIDAL has **two separate auth identities**: the per-user OAuth above (streaming only) and a single admin-owned download connection whose encrypted tokens live in `SystemSettings.tidalAccessToken`/`tidalRefreshToken`. Album downloads always use the admin connection (`backend/src/services/tidal.ts`), never per-user credentials. The admin connection is established exclusively through the `/api/system-settings/tidal-auth` device-code endpoints; the general settings API neither returns the token material (`GET` reports a `tidalConnected` boolean instead) nor accepts it on save, so a settings round-trip cannot overwrite the stored tokens.

### Gap-Fill Playback (YouTube Music)

```
Browser → GET /api/ytmusic/proxy/:videoId
  → backend → ytmusic-streamer:8586/proxy
    → ytmusic-streamer uses yt-dlp to extract stream URL → YouTube CDN
  → audio stream proxied back to browser
```

YouTube `videoId` is permanent; stream URLs from yt-dlp expire in hours. Only `videoId` is stored in `TrackYtMusic`, stream URL is extracted at playback time.

### YouTube URL Paste (Stream & Download)

```
Browser pastes a YouTube URL on /search
  → GET /api/youtube/info | /playlist-info (any authenticated user)
  → GET /api/youtube/stream/:videoId → ytmusic-streamer /yt/proxy/:id (instant playback)
  → POST /api/youtube/download (admin only)
    → ytmusic-streamer /yt/download → yt-dlp writes audio under YT_DOWNLOAD_DIR on the shared /music volume
    → backend watcher polls the job to a terminal state and enqueues ONE coalesced library scan
      (stable Bull jobId; completions during an active scan trigger exactly one follow-up scan)
```

Download endpoints (start/status/list/cancel) are admin-gated server-side (`requireAdmin`), matching the app's downloads model; the download UI and downloads polling are hidden for non-admin users. The ytmusic-streamer pod mounts the music volume for this flow (RWX in multi-node Helm deployments).

### Track Resolution Priority

When a track needs playback, resolution follows this priority chain:

```
Local file (Track.filePath) → TIDAL (if user connected) → YouTube Music → Unplayable
```

The `TrackMapping` table bridges between local tracks and provider tracks. Mappings are populated lazily during gap-fill, playlist import, or background reconciliation.

### Listen Together (Real-Time Sync)

```
Browser ↔ Socket.IO WebSocket ↔ backend:3006
  → Redis pub/sub (cross-replica sync)
  → Redis state store (session persistence)
  → PostgreSQL (SyncGroup/SyncGroupMember persistence)
```

Listen Together uses in-memory state with Redis-backed cluster sync for multi-replica deployments. Mutation locks prevent concurrent state corruption. State is periodically persisted to PostgreSQL.

### Audio Analysis Pipeline

```
backend writes track to Redis queue
  → audio-analyzer BRPOP → Essentia analysis (BPM, key, mood, energy) → writes to PostgreSQL
  → audio-analyzer-clap BRPOP → CLAP embedding (512-dim vector) → writes to track_embeddings table
```

Analyzers run as independent workers. MusiCNN analyzer writes mood/feature columns on `Track`. CLAP analyzer writes to `TrackEmbedding` for vibe/similarity search via pgvector.

The API process also serves `/api/vibe/map` by reading CLAP embeddings from PostgreSQL, projecting them through an in-process Node worker thread, and caching the normalized coordinates in Redis. That worker entrypoint must resolve in both tsx `src/` runtime and compiled `dist/` runtime layouts.

### Enrichment Pipeline

```
Scheduler (backend or backend-worker) → enrichment worker
  → MusicBrainz API (artist/album metadata)
  → Last.fm API (similar artists, tags)
  → Fanart.tv API (artist hero images)
  → Wikidata API (artist summaries)
  → writes enriched data to Artist/Album rows via Prisma
```

Enrichment runs on a configurable schedule. `Artist.enrichmentStatus` tracks progress. `EnrichmentFailure` table tracks retry state for failed lookups.

## Backend Process Roles

The backend supports three runtime roles via `BACKEND_PROCESS_ROLE`:

| Role | Serves API | Runs Workers/Cron | Default |
|------|-----------|-------------------|---------|
| `all` | Yes | Yes | Yes |
| `api` | Yes | No | |
| `worker` | No (health endpoint only) | Yes | |

For small deployments, `all` is fine. For scale-out, run separate `api` and `worker` containers sharing the same DB and Redis.

Coarse feature flags (`AUDIO_ANALYSIS_ENABLED`, `DISCOVERY_ENABLED`, `AUTO_PLAYLISTS_ENABLED`, all default `true`) gate both sides: with a flag off, the API process does not mount the subsystem's routes (requests get `404` with `code: FEATURE_DISABLED`) and the worker process does not register its queues/crons. The flags are exposed through Helm values (`config.features.*`) and forwarded by the docker-compose files.

## Key Runtime Boundaries

- **Frontend API boundary:** `frontend/lib/api.ts` — all HTTP calls go through here
- **Backend config:** `backend/src/config.ts` — Zod-validated env vars
- **Database access:** Prisma only, no raw SQL
- **Logging:** Shared helpers (`frontend/lib/logger.ts`, `backend/src/utils/logger.ts`, `services/common/logging_utils.py`)
