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
    TD["tidal-streamer<br/>FastAPI :8585"]
    YT["ytmusic-streamer<br/>FastAPI :8586"]
    AA["audio-analyzer<br/>Essentia/MusiCNN"]
    VQ["audio:clap:queue<br/>Redis provider jobs"]
    DC["vibe-provider-dclap<br/>DCLAP ONNX :8092<br/>(Compose/AIO default; Helm opt-in)"]
    PEER["peer soundspan instance<br/>/api/federation/v1"]
    IDP["OIDC identity provider"]

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
    BW -->|enqueue| VQ
    VQ -->|"BLPOP to worker"| BW
    VQ -.->|stored in| RD
    BW -->|"audio embedding HTTP"| DC
    BW -->|"TrackEmbedding writes"| PG
    BE -->|"text embedding HTTP"| DC
    BE <-->|"HTTPS catalog, cover, stream"| PEER
    BE -->|"HTTPS discovery, token, JWKS"| IDP
```

## Service Communication Map

| Source                   | Target                  | Protocol                                                                   | Port                            | Auth                                                                                                                          | Purpose                                                                                               |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| frontend                 | backend                 | HTTP (custom-server streaming proxy `/api/*`; Next route-handler fallback) | 3006                            | Bearer JWT (`Authorization` header, token in localStorage), plus `X-API-Key`; `?token=` query JWT only for media-element URLs | All API requests (admin-only surfaces such as Library Health and Bull Board included)                 |
| frontend                 | backend                 | WebSocket (Socket.IO, proxied by the custom server)                        | 3006                            | JWT (`handshake.auth.token`)                                                                                                  | Listen Together real-time sync                                                                        |
| backend                  | PostgreSQL              | TCP (Prisma)                                                               | 5432                            | Connection string                                                                                                             | All persistent state                                                                                  |
| backend                  | Redis                   | TCP                                                                        | 6379                            | None                                                                                                                          | Listen Together presence/state, OIDC flow state, cache, pub/sub, stream queues                        |
| backend                  | tidal-streamer          | HTTP                                                                       | 8585                            | `x-internal-secret` (`INTERNAL_API_SECRET`); `/health` exempt                                                                 | TIDAL OAuth, search, stream extraction, downloads                                                     |
| backend                  | ytmusic-streamer        | HTTP                                                                       | 8586                            | `x-internal-secret` (`INTERNAL_API_SECRET`); `/health` exempt                                                                 | YT Music OAuth, search, stream proxy, browse shelves; `/yt/*` pasted-URL preview/stream/download jobs; library album download jobs |
| backend-worker           | PostgreSQL              | TCP (Prisma)                                                               | 5432                            | Connection string                                                                                                             | Background job state                                                                                  |
| backend-worker           | Redis                   | TCP                                                                        | 6379                            | None                                                                                                                          | Job queues (Bull/streams), scheduler claims                                                           |
| audio-analyzer           | PostgreSQL              | TCP (direct)                                                               | 5432                            | Connection string                                                                                                             | Analysis results write                                                                                |
| audio-analyzer           | Redis                   | TCP                                                                        | 6379                            | None                                                                                                                          | BRPOP job queue                                                                                       |
| backend / backend-worker | vibe-provider-dclap     | HTTP                                                                       | 8092                            | `x-internal-secret` (`INTERNAL_API_SECRET`)                                                                                   | Provider space identity plus text and audio embedding                                                 |
| backend / backend-worker | peer soundspan instance | HTTPS (`/api/federation/v1`)                                               | 443                             | Scoped instance Bearer token                                                                                                  | Catalog sync, health checks, cover art, and audio streaming                                           |
| backend                  | OIDC identity provider  | HTTPS                                                                      | 443                             | OIDC confidential client credentials                                                                                          | Provider discovery, authorization-code token exchange, and JWKS retrieval                             |
| OpenSubsonic client      | backend (`/rest`)       | HTTP/HTTPS                                                                 | 3006, or frontend proxy on 3030 | Local password, revocable `ssap_` app password, token digest, or API key                                                      | OpenSubsonic-compatible browse, state, and media operations                                           |

## Compose File Matrix

| File                                    | Purpose                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `docker-compose.yml`                    | Split-stack deployment (canonical ports)                                              |
| `docker-compose.aio.yml`                | All-in-one single container                                                           |
| `docker-compose.local.yml`              | Local npm/tsx dev with +1 ports (3031/3007)                                           |
| `docker-compose.services.yml`           | Optional Lidarr service                                                               |
| `docker-compose.override.ha.yml`        | HA-focused override                                                                   |
| `docker-compose.override.lite-mode.yml` | Analyzer-disabled override                                                            |
| `docker-compose.dev.yml`                | Deprecated development stack; use `docker-compose.local.yml` for host-run development |

## Request Flows

### Browser to API

```
Browser → frontend:3030 → custom-server streaming proxy /api/* → backend:3006 → Prisma → PostgreSQL
```

The frontend's custom server (`frontend/server.js` + `frontend/server-proxy.js`) streams all `/api/*` requests to the backend via http-proxy-middleware — no body buffering, backend gzip and streaming preserved — enforcing a configurable time-to-first-byte budget (`PROXY_REQUEST_TIMEOUT_MS`, default 20s; `PROXY_IMPORT_PREVIEW_TIMEOUT_MS`, default 90s → `504 UPSTREAM_TIMEOUT`). The upstream proxy request retains a bounded timeout, while reused browser sockets do not receive per-request timeout listeners. The Next route handler at `app/api/[...path]` remains as a fallback. The browser never talks to the backend directly. `frontend/lib/api.ts` is the canonical API boundary — no direct `fetch` calls from components.

### Music Playback (Local Library)

```
Browser → GET /api/library/tracks/:id/stream → backend reads file from /music → audio stream response
```

Local files are served directly from the mounted `/music` volume. Transcoded variants are cached in `backend_cache` volume. The `/api/streaming` router carries authenticated playback client metrics; it does not serve audio.

### Gap-Fill Playback (TIDAL)

```
Browser → GET /api/tidal-streaming/stream/:tidalId
  → backend → tidal-streamer:8585/stream
    → tidal-streamer uses tiddl + per-user OAuth token → TIDAL CDN
  → audio stream proxied back to browser
```

Each user authenticates their own TIDAL account via device-code OAuth flow. Stream quality is per-user configurable. The backend looks up the user's encrypted OAuth credentials from `UserSettings.tidalOAuthJson`.

TIDAL has **two separate auth identities**: the per-user OAuth above (streaming only) and a single admin-owned download connection whose encrypted tokens live in `SystemSettings.tidalAccessToken`/`tidalRefreshToken`. Album downloads always use the admin connection (`backend/src/services/tidal.ts`), never per-user credentials. The admin connection is established exclusively through the `/api/system-settings/tidal-auth` device-code endpoints; the general settings API neither returns the token material (`GET` reports a `tidalConnected` boolean instead) nor accepts it on save, so a settings round-trip cannot overwrite the stored tokens.

The TIDAL sidecar keeps `app.py` as a compatibility entrypoint and composition
shim. Focused auth, browse, download, lifecycle, search, serialization, and
stream modules own route behavior; `tidal_runtime.py` owns FastAPI composition,
logging, paths, and client construction. Sidecar imports of shared helpers use
the repository-qualified `services.common` prefix.

### Gap-Fill Playback (YouTube Music)

```
Browser → GET /api/ytmusic/proxy/:videoId
  → backend → ytmusic-streamer:8586/proxy
    → ytmusic-streamer downloads the full track via yt-dlp (HLS)
      into a bounded LRU disk spool (256 MiB default), sharing one
      download per track and quality across concurrent requests
  → Range requests served from the spooled file back to the browser
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
LOCAL Track.filePath → TIDAL (if user connected) → YouTube Music → Unplayable
FEDERATED Track → owning peer stream proxy → Unplayable when peer is offline
```

The `TrackMapping` table bridges between local tracks and provider tracks.
Mappings are populated lazily during gap-fill, playlist import, background
reconciliation, or federation deduplication. A federated row can also point to
its local winner through `Track.dedupOfTrackId`.

### Listen Together (Real-Time Sync)

```
Browser ↔ Socket.IO WebSocket ↔ backend:3006
  → Redis pub/sub (cross-replica sync)
  → Redis state store (session persistence)
  → PostgreSQL (SyncGroup/SyncGroupMember persistence)
```

Listen Together uses in-memory state with Redis-backed cluster sync for multi-replica deployments. Mutation locks prevent concurrent state corruption. State is periodically persisted to PostgreSQL.

### Federated Library Sharing

```mermaid
sequenceDiagram
    participant Host as Host instance
    participant API as /api/federation/v1
    participant Worker as Consumer federation-sync worker
    participant DB as Consumer PostgreSQL
    participant Browser as Consumer browser
    participant Proxy as Consumer backend

    Host->>API: Export visible local artists, albums, tracks, tombstones
    Worker->>API: Pull manifest, catalog pages, or deltas
    API-->>Worker: Scoped generic media envelopes
    Worker->>DB: Upsert FEDERATED rows and local-wins dedup links
    Browser->>Proxy: Request federated cover or track stream
    Proxy->>API: Forward Range request with peer Bearer token
    API-->>Proxy: Cover or audio bytes
    Proxy-->>Browser: Same-origin streamed response
```

The host mounts the read-only `/api/federation/v1` surface for manifest,
catalog, delta, cover, and stream requests. It exports only visible local
library rows, so content received from another peer is never re-exported. The
consumer periodically materializes peer metadata in its own database. Its
browse and search reads therefore stay available when a peer is offline.

Pairing is directional and explicit. A host administrator creates a host peer
and receives its token once. A client administrator enters the host URL and
token to create a consumer link. Reverse sharing requires a separate host
credential and token exchange. Existing `BOTH` rows remain supported by
authentication, health, and sync reads.

Presence capability is granted implicitly to library peers, but each user stays
hidden unless they enable **Share online presence** in their Social settings.
That single setting controls visibility on the local instance and to federated
peers. **Share listening status** independently controls whether track details
are included. Every playlist marked public is available to peers with the
`social:read` scope; users must make a playlist private to prevent peer export.
On the consuming instance, the Social roster includes cached peer presence
whenever federation is enabled; there is no administrator display gate. A peer
snapshot read failure fails closed to the local roster instead of failing the
request.

The browser never receives an instance credential. Federated cover and stream
requests use the consumer's ordinary authenticated routes; the consumer backend
decrypts its outbound token and proxies the request to the owning peer. Audio
Range headers pass through, and the host remains responsible for any requested
transcoding and cache use.

### Audio Analysis Pipeline

```
backend-worker writes audio:analysis:queue in Redis
  → audio-analyzer BRPOP → Essentia analysis (BPM, key, mood, energy) → writes to PostgreSQL

backend-worker writes and consumes audio:clap:queue in Redis
  → backend-worker POSTs the audio reference to vibe-provider-dclap
  → DCLAP returns a 512-dim vector over HTTP
  → backend-worker validates the provider space and writes TrackEmbedding through Prisma/pgvector

backend text vibe query
  → backend POSTs text to vibe-provider-dclap
  → backend queries TrackEmbedding rows in the provider's registered space
```

The MusiCNN analyzer remains an independent worker and writes mood/feature
columns on `Track`. Its Redis read timeout defaults to 35 seconds and is kept at
least five seconds above `BRPOP_TIMEOUT`; deployments can tune it with
`AUDIO_REDIS_SOCKET_TIMEOUT`.

The `vibe-provider-dclap` sidecar is an HTTP-only inference provider. It reads
audio from the read-only music mount and has no direct PostgreSQL or Redis
access. The backend owns queue admission, retries, space registration, and
`TrackEmbedding` writes. Split Compose and AIO enable DCLAP by default. Helm
keeps `vibeProviderDclap.enabled: false` until an operator opts in.

The API process also serves `/api/vibe/map` by reading CLAP embeddings from PostgreSQL, projecting them through an in-process Node worker thread, and caching the normalized coordinates in Redis. That worker entrypoint must resolve in both tsx `src/` runtime and compiled `dist/` runtime layouts.

The same authenticated vibe router builds track- or mood-targeted journeys from
service-layer embedding reads (`trackEmbeddings.ts`) and reports library-relative
distance calibration from a bounded sample (`vibeCalibration.ts`). Calibration
results use the existing Redis cache; these services add no new runtime process
or network boundary.

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

| Role     | Serves API                | Runs Workers/Cron | Default |
| -------- | ------------------------- | ----------------- | ------- |
| `all`    | Yes                       | Yes               | Yes     |
| `api`    | Yes                       | No                |         |
| `worker` | No (health endpoint only) | Yes               |         |

For small deployments, `all` is fine. For scale-out, run separate `api` and `worker` containers sharing the same DB and Redis.

### Durable Worker Lanes

| Queue                  | Ownership      | Runtime contract                                                                                                                                     |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `album-download`       | backend-worker | Durable Bull queue with two attempts and exponential backoff. One processor per worker plus a renewable Redis claim serializes provider dispatch across replicas; claim contention is re-enqueued with a delay. |
| `scrobble-forwarding`  | backend-worker | Durable, per-user-rate-limited Bull queue for Last.fm and ListenBrainz. Four processors consume secret-free jobs with three bounded attempts; invalid credentials disable only the exact connection that failed. |

Scheduled and serialized worker operations share
`utils/schedulerClaim.ts`. The primitive acquires Redis `NX`/expiry leases with
bounded connection recovery, identifies each owner with a unique token, and
releases or extends a lease only when that token still owns it. Album downloads
use the same primitive instead of busy-polling while another replica holds the
claim.

Coarse feature flags (`AUDIO_ANALYSIS_ENABLED`, `DISCOVERY_ENABLED`,
`AUTO_PLAYLISTS_ENABLED`, and `FEATURE_REQUESTS`, all default `true`;
`FEDERATION_ENABLED`, default `false`) gate both sides. `FEATURE_REQUESTS`
gates `/api/requests` and the request-fulfillment reconciler. With a flag off, the API process mounts a disabled
handler for the subsystem's routes (requests get `404` with
`code: FEATURE_DISABLED`) and the worker process does not register its queues or
schedules. Disabling federation also prevents identity initialization,
tombstone writes, peer sync/health work, and federated playback branches. All flags
except `FEATURE_REQUESTS` are exposed through Helm values (`config.features.*`)
and forwarded by the docker-compose files; `FEATURE_REQUESTS` is set through
the chart's raw env passthrough.

### Scheduled Federation Jobs

| Job                                                                  | Schedule                                                                           | Purpose                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Federation sync (`federation-sync` queue: `sync-tick` → `peer-sync`) | Startup after 10 seconds and every `FEDERATION_SYNC_INTERVAL_MINUTES` (default 15) | Enqueue one coalesced, bounded catalog sync for each non-revoked consumer peer. The sync processor runs with concurrency 2. |
| Federation health (`federation-sync` queue: `peer-health`)           | Startup and hourly                                                                 | Ping consumer-peer manifests and update peer `ACTIVE`/`OFFLINE` status. Health work runs with concurrency 1.                |

### Scheduled Library Maintenance Jobs

| Job                                         | Schedule                 | Purpose                                                                                      |
| ------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| Audio hash backfill (`audio-hash-backfill`) | Startup one-shot         | Fills missing durable audio hashes in bounded pages without blocking startup.                |
| Track removal purge (`track-removal-purge`) | Startup and daily repeat | Permanently deletes soft-removed tracks after `TRACK_REMOVAL_RETENTION_DAYS` (default `90`). |

The worker process runs an event-loop stall watchdog (`services/workerEventLoopMonitor.ts`): its `/health/live` endpoint answers unconditionally, so a liveness-probe timeout always means the single-threaded event loop was blocked. Attribution has two paths: stalls the loop recovers from are logged by a `monitorEventLoopDelay` sampler naming the active Bull jobs (threshold `WORKER_EVENT_LOOP_WARN_MS`, default 1s); stalls that end in a kubelet kill can never reach that sampler (a pegged loop runs no timers), so the heavy queues (`worker-scheduler`, `library-scan`) log an unconditional `job-start` breadcrumb whose final occurrence before death names the culprit.

## Key Runtime Boundaries

- **Frontend API boundary:** `frontend/lib/api.ts` — all HTTP calls go through here. The `ApiClient` is composed from an abstract `ApiClientCore` (`frontend/lib/api/core.ts`, holding the token/URL/`request` plumbing) plus per-domain mixin modules under `frontend/lib/api/` (library, playlists, media, discover, downloads, podcasts, audiobooks, vibe, ytmusic, youtube, tidal, etc.); `api.ts` re-exports the shared response types and the `api` singleton, so consumers keep calling `api.<method>()` unchanged
- **Backend config:** `backend/src/config.ts` — Zod-validated env vars
- **Database access:** Prisma; raw SQL is limited to the pgvector, full-text-search, and row-locking exceptions defined in `AGENTS.md`
- **Logging:** Shared helpers (`frontend/lib/logger.ts`, `backend/src/utils/logger.ts`, `services/common/logging_utils.py`)
- **DCLAP provider boundary:** `services/vibe-provider-dclap/http_server.py` — authenticated HTTP-only embedding and space-identity contract
