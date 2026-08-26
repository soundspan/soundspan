# Federated Library Sharing ("Swarming")

Spec drafted 2026-08-14 for [issue #451](https://github.com/BonzTM/soundspan/issues/451). Status: **shipped**. The implementation includes per-peer settings and dedup arbitration through chunk F14; contract documentation is synchronized through F14.

## Summary

Let independently hosted soundspan instances link together. Each admin keeps hosting and owning their own library. Linked peers share metadata, search, cover art, and streams through an authenticated instance-to-instance API. Remote items merge into local browse, search, and discovery with always-visible provenance ("from Josh's server"). Peers are read-only consumers: a peer can never mutate the host's library.

Two layers ship independently, matching the issue:

1. **Federation API** — a host exposes its library to scoped, revocable peer credentials.
2. **Swarm layer** — a consumer links peers, syncs their catalogs into its own database as `FEDERATED` items, and plays remote media by proxying streams from the owning instance.

## Goals

- Browse, search, and play a friend's library from your own instance with your own account.
- Read-only by default; scoped, revocable, per-peer credentials — never user API keys.
- Seamless merge with dedup where the same release exists in both libraries.
- Provenance visible everywhere: cards, track rows, now-playing, playlists, mixes.
- Graceful degradation when a peer goes offline: items grey out, browse/search keep working.
- The owning instance remains authoritative. Consumers may retain complete proxied responses in their bounded transcode cache; partial Range responses are never cached.

## Non-goals (v1)

- Write federation (remote playlist edits, scrobble forwarding to peers, remote likes).
- Transitive federation (peer-of-a-peer discovery). Links are explicit and pairwise.
- Federated user identity / SSO. Local users see remote *media*, not remote *users*.
- Public/anonymous federation. Every link is an admin-approved pairing.

## Why native federation (vs a Jellyswarrm-style proxy)

A multiplexing proxy in front of N instances would need to re-implement search ranking, discovery, mixes, vibe, and dedup itself, and provenance would be bolted on. Natively, remote items become database rows that Postgres FTS (`backend/src/services/search.ts`) and intelligence surfaces consume without live catalog fan-out. The codebase already runs a multi-source model (local file → TIDAL → YT Music, see `docs/ARCHITECTURE.md` "Track Resolution Priority") — federation adds a fourth source along seams that mostly exist.

## Existing building blocks (verified in-repo)

| Building block | Where | Reused for |
| --- | --- | --- |
| HMAC-at-rest key hashing + pepper resolution | `backend/src/utils/apiKeyHash.ts` | Peer credential storage |
| HMAC-at-rest credential hashing | `backend/src/utils/apiKeyHash.ts` | Peer bearer-token lookup |
| Short-code pairing flow ending in a minted key | `DeviceLinkCode` + `backend/src/routes/deviceLink.ts` | Instance pairing handshake |
| Remote-source tables + arbitration | `TrackTidal`/`TrackYtMusic`/`TrackMapping` (`confidence`, `source`, `stale`) | Dedup/link model |
| Provenance fields that already exist | `Album.location` enum (`LIBRARY \| DISCOVER \| REMOTE`), `Artist.remoteTrackCount` | Origin discriminators |
| Remote stream proxying | `backend/src/routes/tidalStreaming.ts`, `routes/youtubeMusic.ts` | Peer stream proxy |
| Cover art by rgMbid via Cover Art Archive | `backend/src/routes/library/coverArt.ts`, `services/coverArt.ts` | Remote covers mostly free |
| Provider badge components + track-row slot system | `frontend/components/ui/TidalBadge.tsx`, `frontend/components/track/types.ts` (`titleBadges`) | Peer provenance badge |
| Conditional filter pill gated on a feature flag | `frontend/features/search/components/SearchFilters.tsx` (Soulseek pill) | Local/remote filter |
| Unplayable/degraded item UX | `frontend/components/track/badges.tsx` (`UnplayableBadge`), `features/discover/components/UnavailableAlbums.tsx` | Peer-offline greying |
| Admin settings section pattern | `frontend/app/admin/page.tsx` + `features/settings/components/sections/` | Federation admin page |
| Background workers/queues | `backend/src/workers/` (Bull) | Catalog sync + health checks |

> **Superseded (2026-08-23):** Pairing codes were removed in favor of administrator-issued host credentials and one-time tokens.

## Architecture

```
Instance A (consumer)                      Instance B (host)
┌──────────────────────────┐               ┌──────────────────────────┐
│ browse/search over       │   catalog     │ /api/federation/v1/*     │
│ local DB (incl. federated│◄──sync────────│  manifest, delta, art    │
│ rows)                    │   (worker)    │  stream                  │
│                          │               │                          │
│ /api/library/tracks/:id  │   stream      │ auth: Bearer peer token  │
│ /stream (proxy)          │──proxy───────►│ scope: library:read,     │
└──────────────────────────┘               │        stream:read       │
                                           └──────────────────────────┘
```

**Catalog sync, not live fan-out.** The consumer periodically pulls the peer's catalog (manifest + deltas) and materializes it as first-class `Artist`/`Album`/`Track` rows marked `FEDERATED`. Web browse, search (`searchVector` populates on insert), intelligence, Subsonic, and pagination query those materialized rows without live peer fan-out. Live fan-out search was rejected: `services/search.ts` is raw ranked SQL with no abstraction layer to insert a merge into, and fan-out couples every search to the slowest peer.

**Streams proxy through the consumer's backend.** The frontend stays same-origin (no CORS on peers, no token exchange in the browser, no changes to the 8k-line `AudioPlaybackOrchestrator`). This follows the TIDAL/YT proxy pattern exactly. Direct-to-peer streaming is a possible later optimization behind the same URL shape.

### Layer 1 — Federation API (host side)

New route module `backend/src/routes/federation.ts` (mounted `/api/federation/v1`), one module per prefix per repo convention.

Endpoints (all read-only, all peer-credential-authenticated):

| Endpoint | Purpose |
| --- | --- |
| `GET /manifest` | UUID instance identity and catalog epoch, `HOSTNAME`-based name, version, supported `mediaTypes`, local-only counts, embedding availability, additive `socialAvailable` presence signal |
| `GET /catalog/items?type=&cursor=` | Paged media items in a generic envelope (see below); `type` ∈ `artist \| album \| track \| podcast \| audiobook` |
| `GET /catalog/delta?since=` | Changed/removed items since cursor, same envelope (drives incremental sync) |
| `GET /cover/:itemId` | Cover art bytes (ETag) |
| `GET /stream/:itemId` | Audio with Range support, quality param; reuses `AudioStreamingService` |
| `GET /stream/audiobook/:itemId` | Audiobook audio with Range support; reuses the Audiobookshelf proxy |
| `GET /cover/audiobook/:itemId` | Exported audiobook cover bytes |

**Generic media-item envelope.** Every catalog row is `{ id, mediaType, updatedAt, parentRef?, attributes }`. Track attributes include structural metadata plus optional analyzer fields and the scoped optional embedding. Podcast attributes are `feedUrl`, `title`, `author`, `description`, `imageUrl`, and `itunesId`. Audiobook attributes are `title`, `author`, `narrator`, `duration`, `description`, `asin`, `isbn`, and a Boolean cover-presence flag. Consumers bound finite numbers and string/array sizes at the wire boundary. Manifest media types are bounded strings that consumers filter to the types they understand; unknown count keys and future manifest fields are tolerated. New media types and attributes remain additive without a `/v2` split.

Notes:

- Only `location=LIBRARY` content is exported. `DISCOVER` and already-`REMOTE`/`FEDERATED` items are excluded — this also prevents transitive re-export (peer-of-a-peer laundering).
- Delta feed uses row update timestamps plus `FederationTombstone(entityType, entityId, deletedAt)` records written by retention purge and orphan cleanup while federation is enabled. Tombstone fields remain strict. A consumer skips and counts a well-formed tombstone whose bounded `entityType` it does not understand, while a malformed tombstone for a known type fails the page so deletion integrity is preserved.
- Embedding export (512-dim CLAP vector from `TrackEmbedding`) is included behind scope `embeddings:read`. Soundspan 2.3 and newer consumers send `X-Soundspan-Embedding-Space-Accept: 1` on manifest and catalog requests. Every track page, delta page, or single-item response that carries an embedding also sends `X-Soundspan-Embedding-Space` with the JSON-encoded identity tuple `{ "family": ..., "checkpointHash": ..., "dim": ... }`. The tuple stays out of catalog bodies because released consumers validate those bodies as strict objects; unknown response headers are deployment-skew safe. Consumers ignore future additive tuple fields and store peer vectors only when the three known fields match the active space. A missing response header is accepted only while the seeded canonical space remains active, and a malformed or mismatched header degrades the page to metadata-only sync. Exporters continue serving canonical teacher vectors to headerless pre-2.3 peers before cutover. Once the exporter activates a non-teacher space, headerless peers receive metadata without embedding vectors or the space response header. Upgrade both peers to 2.3 or newer to restore embedding exchange after cutover. If the host has no active embedding space, it also serves metadata without vectors or the header. This keeps embedding sharing opt-in and prevents vectors from one model space entering another. ~2KB/track; optional per link.

**Peer credentials** — new Prisma model, deliberately *not* `ApiKey` (ApiKeys hard-expire at 90 days, map 1:1 to a human user, and grant write surface):

```prisma
model FederationPeer {
  id            String    @id @default(cuid())
  name          String                      // "Josh's server"
  direction     PeerDirection               // HOST (they pull from us) | CONSUMER (we pull from them) | BOTH
  baseUrl       String?                     // consumer side: peer's URL
  credentialHash String?  @unique           // host side: hmac: HMAC-SHA256 of the token we issued
  outboundToken String?                     // consumer side: encrypted token we present (SETTINGS_ENCRYPTION_KEY, like tidal tokens)
  scopes        String[]                    // library:read, stream:read, embeddings:read, social:read
  inboundStatus PeerStatus?                 // auth state for HOST | BOTH
  outboundStatus PeerStatus?                // health state for CONSUMER | BOTH
  lastSeenAt    DateTime?
  lastSyncCursor String?
  catalogEpoch  String?
  createdById   String                      // admin user
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}
```

- Issue/rotate/revoke via admin-only routes (`requireAuth` + `requireAdmin`, pattern of `routes/admin.ts`). Raw token shown once; stored as `hmac:` hash via `apiKeyHash.ts` helpers. No fixed lifetime; revocation is status change (auditable), not row delete.
- Auth middleware `requireFederationPeer(scope)` hashes the bounded bearer token, resolves an active peer by `credentialHash`, and attaches **`req.federationPeer`, never `req.user`** — downstream `userId`-scoped queries fail safely instead of impersonating a user. Per-peer rate limiting.
- Pairing uses an explicit host/client model. A host administrator generates a 30-minute code, and a client administrator enters the host URL plus that code to create one `HOST` link on the host and one `CONSUMER` link on the client. Pairing never mints a reciprocal code or calls back to the client. A second, separately authorized pairing is required to share in the reverse direction. The public endpoint accepts and ignores legacy reciprocal fields during rolling upgrades. Existing `BOTH` rows remain readable and operational, but admin write routes no longer create new ones.

> **Superseded (2026-08-23):** The pairing-code route and wire contract were removed; host credentials and one-time tokens are the only supported link path.

### Layer 2 — Swarm layer (consumer side)

**Data model.** Federated items become first-class rows with an origin discriminator (option (b) from the codebase analysis — `Album.location` already has a `REMOTE` variant and `Track` is the only table needing structural change):

- `Album.location` gains `FEDERATED` (or reuses `REMOTE` with a peer FK; new variant preferred — `REMOTE` currently means "streaming-only Tidal/YT artist content").
- `Track` gains `origin` (`LOCAL | FEDERATED`), nullable `filePath` (federated rows have none; unique constraint keeps ignoring NULLs in Postgres), and `@@unique([peerId, remoteId])`.
- `Artist`/`Album`/`Track` gain nullable `peerId → FederationPeer` + `remoteId` (the peer's cuid for the entity).
- Federated track IDs remain ordinary local `Track.id` cuids. The wire envelope carries the host ID, which is stored as the unique `(peerId, remoteId)` pair. `Play` and `PlaylistItem` use the existing `trackId` column, while API responses discriminate the row with `source: "federated"` and peer provenance. No new polymorphic FK columns are required.

**Podcasts are catalog listings, not mirrors.** A host exports every subscribed `Podcast` feed as `mediaType: "podcast"`. The consumer stores only `FederationPodcastListing` rows keyed by `(peerId, remoteId)` and exposes them through `GET /api/podcasts/peers` with peer and per-user subscription state. It never inserts peer data into `Podcast`, because `Podcast.feedUrl` is globally unique and a mirror could collide with the native feed row. Subscribing follows the existing native feed flow. Episodes do not federate.

**Audiobooks are full mirrors.** `Audiobook` gains nullable `peerId`/`remoteId`; local rows leave both null and hosts export only `peerId: null` rows to prevent transitive re-export. Consumers mint `fed:<uuid>` primary IDs with `node:crypto` `randomUUID()` and mirror metadata without v1 ASIN/ISBN deduplication. List, detail, search, cover, stream, and progress remain available for federated rows when Audiobookshelf is disabled. Progress stays local on the consumer. Streaming is a double proxy: browser → consumer → owning peer → Audiobookshelf. The inherited Audiobookshelf implementation streams only `media.tracks[0]`; multi-track audiobook concatenation or track selection remains future work.

**Federated vs provider-remote tracks.** Federated tracks deliberately do NOT follow the existing TIDAL/YT Music "remote track" pattern. The two models coexist and serve different purposes:

| | Provider-remote (`TrackTidal`/`TrackYtMusic`) | Federated (`Track` with `origin: FEDERATED`) |
| --- | --- | --- |
| Storage | Side tables outside the library | First-class library rows |
| Browse/search | Never appear (playlists/likes only) | Full browse, search, artist/album pages |
| References | Dedicated polymorphic columns on `PlaylistItem`/`LikedRemoteTrack`/`Play` per provider | Ordinary `trackId` — zero new columns |
| Likes | Provider-specific route + `LikedRemoteTrack` | Standard track preference route + `LikedTrack` |
| Playback | Extracted/proxied from the provider at play time | Proxied from the owning peer's federation stream endpoint |
| Dedup vs local | `TrackMapping` gap-fill arbitration | Identity-tier matching (`audioHash`/`recordingMbid`/`isrc`/position), local wins via `dedupOfTrackId` |
| Lifecycle | Ephemeral provider IDs, refreshed lazily | Synced catalog with deltas, tombstones, and peer-cascade cleanup |

Rationale: a peer's library is *library* — a durable catalog a friend curates — so it should feel native (searchable, browsable, deduplicated, badged). Provider streaming is ephemeral gap-fill for individual tracks. The side-table pattern also scales poorly (every new source historically meant new nullable FK columns on every polymorphic table); first-class rows avoid that entirely, which is why federation adds no schema burden to playlists, likes, or plays.

**Sync worker.** The Bull `federation-sync` queue performs an initial full catalog pull, then scheduled delta pulls (default 15 min, configurable). It upserts rows, populates `searchVector` through database behavior, and imports embeddings into `TrackEmbedding` when scoped. Bounded pages, `lastSyncCursor`, catalog epochs, and deterministic per-peer Bull job IDs make work resumable, idempotent, and coalesced. Existing denormalized artist counts remain local-only in v1.

**Dedup.** Track arbitration uses the durable identity keys from the prerequisite feature (`docs/designs/durable-track-identity.md`) in this order: `audioHash`, `recordingMbid`, `isrc`, then `(rgMbid, discNo, trackNo)`. The catalog envelope carries these keys. Federated artist and album rows remain peer-owned; global MBID collisions receive deterministic placeholder identities. Within one peer, track identity keys can rebind a changed host `remoteId` to the existing federated row instead of dropping and recreating it.

When a federated track matches an active local track, the consumer retains the federated row, sets its `dedupOfTrackId` self-relation to the local winner, and records a `TrackMapping` with `source: "federation"`. Browse and search suppress federated rows with a dedup target by default. An administrator may enable `showDedupedCopies` for one peer without changing any other peer or local-only query behavior. Manual link and unlink decisions set `dedupPinned`; sync and scanner reconciliation never rewrite pinned rows. Reset clears the pin and immediately applies the standard identity-tier matcher again.

**Playback.** `handleStreamTrack` (`backend/src/routes/library/tracks.ts`) branches on `origin`. A cache hit serves the complete peer response locally with Range support. A non-Range status-200 miss may fill a temporary transcode-cache file, atomically publish it with a `TranscodedFile` row, and then serve it. The fill ceiling is the remaining configured transcode-cache capacity after eviction. A known `Content-Length` above that ceiling bypasses caching and streams directly; when an unknown-length response crosses the ceiling, its temporary and final paths are removed before a fresh upstream request streams directly without caching. Range misses and non-200 responses proxy directly without caching partial bytes. Concurrent first requests coalesce by `(trackId, quality)`. An audio-hash change or peer deletion removes rows and files. `Play` logging works unchanged.

**Offline degradation.** A lightweight health check pings `GET /manifest` at startup and hourly and flips `FederationPeer.outboundStatus` between `ACTIVE` and `OFFLINE`; stream failures also mark only the outbound direction offline. `inboundStatus` remains independent, so a `BOTH` peer can continue authenticating inbound requests during an outbound outage. Catalog rows stay in the DB, so browse/search never break. API responses include `peer: { id, name, online }` on federated items; the frontend renders offline items greyed with `UnplayableBadge`-style treatment, and playback resolution skips them.

**Provenance UI (frontend).**

- `PeerBadge` component (sibling of `TidalBadge.tsx`), tooltip "From {peer name}".
- Injected via existing `TrackRowSlots.titleBadges` at the ~8–12 `toRowItem()` adapter call sites (album page, playlist page, discover, search, queue…). `MediaCard` already takes `badge?: ReactNode`; `PlayableCard`'s enum `badge` prop widens; `AlbumsGrid`'s hand-rolled card gets a small edit.
- Now playing: badge alongside `SyncBadge`/`PlaybackQualityBadge` in `FullPlayer.tsx`.
- Filters: a "Peers" pill in `SearchFilters.tsx` gated on the `federation` feature flag (exact precedent: the Soulseek pill), plus an All/Local/Peers toggle on the library pages.
- Playlists get provenance through the shared track-row slots. Mix, radio, vibe, discovery, and recommendation generation use the same visible, local-wins track predicate as browse.
- New API mixin `frontend/lib/api/federation.ts` on `ApiClientCore` (mechanical, 23 precedents).

**Admin UI.** `FederationSection.tsx` under `features/settings/components/sections/` + sidebar entry in `app/admin/page.tsx`: list peers (`ConnectionCard` pattern with status/test), add peer (pairing code or URL+token), scope checkboxes, sync now / view last sync, revoke. Feature flag `FEDERATION_ENABLED` (default `false`) follows the existing coarse-flag pattern (`config.features.*` — routes unmounted and workers unregistered when off), surfaced to the frontend via `features-context.tsx`.

> **Superseded (2026-08-23):** The pairing-code UI path was removed in favor of host credential and token entry.

### Security considerations

- Peer tokens: 32-byte random, HMAC-hashed at rest (`apiKeyHash.ts`), shown once, revocable, scoped, never a user identity. Outbound tokens encrypted at rest like TIDAL OAuth material.
- Read-only enforced structurally: the federation router simply has no mutating endpoints, and `req.federationPeer` (not `req.user`) means existing write routes can't be reached with a peer credential at all.
- HTTPS is required for every peer `baseUrl` and is validated during token linking. *(Pairing codes were removed 2026-08 — host credential + token is the only join path.)*
- Per-peer rate limits protect catalog and stream endpoints.
- No transitive re-export (only `LIBRARY` content is served). Catalog sync is media metadata only; plays and likes never leave the instance. Since the phase-0 social surfaces (2026-08), two social exports exist: presence (username, display name, and coarse listening status) for users who enable `shareOnlinePresence`, and every playlist marked `isPublic`. The `shareListeningStatus` setting independently gates presence track details. The `social:read` scope gates both exports; users must disable base presence sharing or make a playlist private to prevent its export. Consumers display successfully read cached presence whenever federation is enabled, without a separate administrator display gate; snapshot-read errors fall back to the local roster.
- Outbound requests from the sync worker follow Modern Coding Rules #4: timeouts, retry limits, backoff, bounded pagination.
- Licensing note for docs: federation shares access to media between private instances; the admin enabling it is responsible for who they link with (same posture as share links today).

## Phasing

| Phase | Scope | Implementation status |
| --- | --- | --- |
| **0. Durable track identity** | Stable local identities and dedup keys | Shipped before federation as #457; consumed by F1 and F4. |
| **1. Federation API** | Peer model, credentials, administrator lifecycle, and read-only host API | Shipped in F1–F3; the administrator UI shipped in F6. |
| **2. Swarm read path** | Pairing/linking, materialized sync, dedup, proxies, provenance, filters, and offline state | Shipped in F4–F7. |
| **3. Intelligence & polish** | Embedding transport plus first-class consumer surfaces | F11 makes mixes, radio, vibe, discovery, shuffle, recommendations, mood assignment, lyrics metadata lookup, and Subsonic federation-aware. Share links, file operations, local analysis producers, imports, and acquisition/offline downloads remain excluded. |

## Feasibility assessment

**Verdict: feasible with medium-high effort; no architectural blockers.** The schema and runtime were already pushed toward multi-source by TIDAL/YT gap-fill — federation lands on existing seams rather than fighting the design.

**What makes it tractable (verified, not assumed):**

- Provenance fields half-exist: `Album.location` enum, `Artist.remoteTrackCount`, `filter=remote` in the artists route.
- Remote streams already proxy through the backend (two precedents), and stream URLs are query-token media-element URLs, so the player needs almost nothing.
- Dedup keys exist at album/artist level (`rgMbid @unique`, `mbid @unique`, `normalizedName`) with an arbitration model (`TrackMapping.confidence/source`) to extend.
- Credential plumbing (hashing, constant-time compare, pairing-code flow, admin section pattern) is all reusable.
- Materialized sync lets web, Subsonic, and intelligence queries use federated rows without catalog fan-out. Imported features and embeddings give those surfaces parity with local analyzed tracks.

**Hard parts / risks:**

1. **`Track.filePath` is non-nullable and unique** — the strongest local-only assumption. Making it nullable touches the scanner (`services/musicScanner.ts` upserts keyed on `filePath`), streaming, and any code assuming a path exists. Mitigation: `origin` discriminator checked before every file access; scanner queries add `origin: LOCAL`. This is the single most invasive schema change and the migration needs care.
2. **Track-level dedup precision** — local `Track` today has no MBID/ISRC/acoustid, and its identity is the file path (a reorg on either side breaks matches). Addressed by the **durable track identity prerequisite** (`docs/designs/durable-track-identity.md`): `recordingMbid`/`isrc` columns from tags plus scanner move detection. With it, matching is exact for tagged libraries and the peer delta feed stays quiet during reorgs; without it, matching degrades to `(rgMbid, discNo, trackNo)`/title+duration.
3. **Deletion/consistency drift** — peers must emit tombstones and consumers must handle cursor resets (peer re-scanned, DB restored). Full-resync fallback required; sync must be idempotent.
4. **Mixes/discovery availability** — federated tracks use materialized features and the same visible, local-wins predicate as browse. Generation remains deterministic over the current catalog even when a peer is temporarily offline; playback reports peer availability separately.
5. **Version skew** — peers on different soundspan versions. The `/v1` prefix, manifest version, and additive request-header capabilities address it; catalog payloads must evolve additively. Peers older than 2.3 stop receiving embedding vectors from a host after that host cuts over to a non-teacher space; upgrade both sides to restore embedding exchange.
6. **Host bandwidth** — N friends can stream from one home connection. Per-peer request rate limits protect the host, optional `maxConcurrentStreams` uses a Redis-backed distributed counter with a refreshed crash-recovery TTL, and optional `maxStreamKbps` paces response bytes through a backpressure-aware Transform. Null caps preserve unlimited behavior. The consumer forwards the requested quality, and complete consumer-cache hits avoid repeated peer transfers.
7. **Blast radius of browse-query changes** — every list endpoint (and Subsonic) must default correctly for users who never enable federation. The `FEDERATION_ENABLED=false` default plus `origin` filters keeps the flag-off path byte-identical.

**Rough effort (working sessions, not calendar):**

| Work item | Estimate |
| --- | --- |
| Phase 1: model + migrations + peer auth middleware + v1 API + admin credential UI + tests | ~2–3 weeks equivalent |
| Phase 2: pairing, sync worker + tombstones, `Track` schema change, stream proxy, frontend badges/filters/admin, degradation + tests | ~4–6 weeks equivalent |
| Phase 3: embeddings import, vibe/mixes inclusion rules, Subsonic surface, polish | ~2–3 weeks equivalent |

Testing per repo contract: behavioral tests against real PostgreSQL for sync/dedup/tombstones, negative-path tests for peer auth (scope enforcement, revoked/expired, `req.user` absence), range-request tests for the stream proxy, component tests for badge/filter rendering. Targeted suites only (no full-suite runs).

## Resolved decisions (2026-08-14)

Confirmed with the project owner and implemented in the pending-release v1:

1. **New `FEDERATED` variant** in `Album.location` (and the track `origin` discriminator). `REMOTE` keeps meaning streaming-only Tidal/YT content; filters and denormalized counts stay unambiguous.
2. **Embedding sharing is opt-in per link.** `embeddings:read` is a per-peer admin checkbox, off by default.
3. **Local always wins** when the same track exists locally and on a peer. The federated row points to the local winner through `dedupOfTrackId` and is suppressed from browse/search as a hidden alternate source.
4. **Owner-reversed 2026-08-15: Subsonic includes federated media.** Metadata and playlists expose visible, dedup-suppressed peer items. Streams/downloads proxy through the owning peer, and an offline peer returns a Subsonic generic protocol error.

Owner reversals recorded 2026-08-15: the earlier local-only intelligence decision, local-only Subsonic decision, no-consumer-cache decision, and local-only lyrics decision are superseded by F11. Share links remain the deliberate egress exclusion: a consumer cannot re-share peer media to third parties.
5. **Podcasts and audiobooks use the additive media envelope.** Podcasts are catalog listings only; audiobooks are full mirrors with proxied cover and streaming paths. Both are additive `mediaType` values, not a v2 API.
6. **Duplicate visibility is configured per consumer peer.** `showDedupedCopies=false` preserves local-wins suppression. Enabling it exposes only that peer's linked copies across the shared Prisma and SQL browse/search predicates.
7. **Host stream caps are nullable per peer.** `maxConcurrentStreams` is enforced across replicas through Redis and returns typed `429` with `Retry-After`; `maxStreamKbps` paces both music and audiobook host streams. Null values preserve the pre-F14 path.
8. **Administrator dedup decisions are durable pins.** Manual link and unlink actions set `dedupPinned=true`; both automatic dedup writers skip pinned rows. Reset clears the pin and immediately re-runs the standard audio-hash, recording-MBID, ISRC, then album-position matcher.
