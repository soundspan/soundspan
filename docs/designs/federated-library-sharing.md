# Federated Library Sharing ("Swarming")

Spec drafted 2026-08-14 for [issue #451](https://github.com/BonzTM/soundspan/issues/451). Status: design phase, no implementation yet.

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
- No file copies. Media always streams from (or through) the owning instance.

## Non-goals (v1)

- Write federation (remote playlist edits, scrobble forwarding to peers, remote likes).
- Transitive federation (peer-of-a-peer discovery). Links are explicit and pairwise.
- Federated user identity / SSO. Local users see remote *media*, not remote *users*.
- Podcasts and audiobooks in v1 — music ships first, but all media types are intended to federate eventually, so the catalog API is designed around a generic media-item envelope from day one (see Layer 1).
- Public/anonymous federation. Every link is an admin-approved pairing.

## Why native federation (vs a Jellyswarrm-style proxy)

A multiplexing proxy in front of N instances would need to re-implement search ranking, discovery, mixes, vibe, and dedup itself, and provenance would be bolted on. Natively, remote items become rows the existing intelligence already ranks over: Postgres FTS (`backend/src/services/search.ts`), pgvector similarity (`backend/src/services/hybridSimilarity.ts`), mixes, and radio. The codebase already runs a multi-source model (local file → TIDAL → YT Music, see `docs/ARCHITECTURE.md` "Track Resolution Priority") — federation adds a fourth source along seams that mostly exist.

## Existing building blocks (verified in-repo)

| Building block | Where | Reused for |
| --- | --- | --- |
| HMAC-at-rest key hashing + pepper resolution | `backend/src/utils/apiKeyHash.ts` | Peer credential storage |
| Constant-time secret compare, fail-closed | `backend/src/middleware/internalAuth.ts` | Peer auth middleware template |
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

## Architecture

```
Instance A (consumer)                      Instance B (host)
┌──────────────────────────┐               ┌──────────────────────────┐
│ browse/search/vibe over  │   catalog     │ /api/federation/v1/*     │
│ local DB (incl. federated│◄──sync────────│  manifest, delta, art    │
│ rows)                    │   (worker)    │  stream                  │
│                          │               │                          │
│ /api/federation/peers/:id│   stream      │ auth: Bearer peer token  │
│ /stream/:trackId (proxy) │──proxy───────►│ scope: library:read,     │
└──────────────────────────┘               │        stream:read       │
                                           └──────────────────────────┘
```

**Catalog sync, not live fan-out.** The consumer periodically pulls the peer's catalog (manifest + deltas) and materializes it as first-class `Artist`/`Album`/`Track` rows marked `FEDERATED`. Browse, search (`searchVector` populates on insert), pagination, and Subsonic then work unchanged and stay fast when a peer is slow or down. Live fan-out search was rejected: `services/search.ts` is raw ranked SQL with no abstraction layer to insert a merge into, and fan-out couples every search to the slowest peer.

**Streams proxy through the consumer's backend.** The frontend stays same-origin (no CORS on peers, no token exchange in the browser, no changes to the 8k-line `AudioPlaybackOrchestrator`). This follows the TIDAL/YT proxy pattern exactly. Direct-to-peer streaming is a possible later optimization behind the same URL shape.

### Layer 1 — Federation API (host side)

New route module `backend/src/routes/federation.ts` (mounted `/api/federation/v1`), one module per prefix per repo convention.

Endpoints (all read-only, all peer-credential-authenticated):

| Endpoint | Purpose |
| --- | --- |
| `GET /manifest` | Instance identity: name, version, supported `mediaTypes`, counts, catalog cursor/etag |
| `GET /catalog/items?type=&cursor=` | Paged media items in a generic envelope (see below); `type` ∈ `artist \| album \| track` in v1 |
| `GET /catalog/delta?since=` | Changed/removed items since cursor, same envelope (drives incremental sync) |
| `GET /cover/:itemId` | Cover art bytes (ETag) |
| `GET /stream/:itemId` | Audio with Range support, quality param; reuses `AudioStreamingService` |

**Generic media-item envelope.** Every catalog row is `{ id, mediaType, updatedAt, parentRef?, attributes }` where `attributes` is a per-`mediaType` payload (artist: name/mbid/normalizedName; album: title/rgMbid/year/primaryType; track: title/disc/trackNo/duration/audio-feature summary/optional embedding). The manifest advertises which `mediaTypes` the host exports. Podcasts, episodes, and audiobooks later become new `mediaType` values with their own `attributes` shapes — additive, no `/v2`. Consumers skip unknown `mediaType`s. The envelope lives in `packages/media-metadata-contract` alongside the existing shared media types.

Notes:

- Only `location=LIBRARY` content is exported. `DISCOVER` and already-`REMOTE`/`FEDERATED` items are excluded — this also prevents transitive re-export (peer-of-a-peer laundering).
- Delta feed is cheap to build from `Track.fileModified`/row `updatedAt` plus a tombstone table for deletes (`FederationTombstone(entityType, entityId, deletedAt)` written by the scanner's delete path).
- Embedding export (512-dim CLAP vector from `TrackEmbedding`) is included behind scope `embeddings:read` so remote tracks can participate in vibe/similarity on the consumer without re-analysis. ~2KB/track; optional per-link.

**Peer credentials** — new Prisma model, deliberately *not* `ApiKey` (ApiKeys hard-expire at 90 days, map 1:1 to a human user, and grant write surface):

```prisma
model FederationPeer {
  id            String    @id @default(cuid())
  name          String                      // "Josh's server"
  direction     PeerDirection               // HOST (they pull from us) | CONSUMER (we pull from them) | BOTH
  baseUrl       String?                     // consumer side: peer's URL
  credentialHash String?  @unique           // host side: hmac: HMAC-SHA256 of the token we issued
  outboundToken String?                     // consumer side: encrypted token we present (SETTINGS_ENCRYPTION_KEY, like tidal tokens)
  scopes        String[]                    // library:read, stream:read, embeddings:read
  status        PeerStatus                  // PENDING | ACTIVE | OFFLINE | REVOKED
  lastSeenAt    DateTime?
  lastSyncCursor String?
  createdById   String                      // admin user
  createdAt     DateTime  @default(now())
}
```

- Issue/rotate/revoke via admin-only routes (`requireAuth` + `requireAdmin`, pattern of `routes/admin.ts`). Raw token shown once; stored as `hmac:` hash via `apiKeyHash.ts` helpers. No fixed lifetime; revocation is status change (auditable), not row delete.
- Auth middleware `requireFederationPeer(scope)` attaches **`req.federationPeer`, never `req.user`** — downstream `userId`-scoped queries fail safely instead of impersonating a user. Constant-time compare per `internalAuth.ts`. Per-peer rate limiting.
- Pairing handshake (nice-to-have over manual token paste): admin on host generates a short-lived pairing code (à la `DeviceLinkCode`); admin on consumer enters `https://host.example` + code; consumer calls `POST /api/federation/v1/pair` and receives its scoped token; both sides create their `FederationPeer` row. Manual token exchange remains the fallback.

### Layer 2 — Swarm layer (consumer side)

**Data model.** Federated items become first-class rows with an origin discriminator (option (b) from the codebase analysis — `Album.location` already has a `REMOTE` variant and `Track` is the only table needing structural change):

- `Album.location` gains `FEDERATED` (or reuses `REMOTE` with a peer FK; new variant preferred — `REMOTE` currently means "streaming-only Tidal/YT artist content").
- `Track` gains `origin` (`LOCAL | FEDERATED`), nullable `filePath` (federated rows have none; unique constraint keeps ignoring NULLs in Postgres), and `@@unique([peerId, remoteId])`.
- `Artist`/`Album`/`Track` gain nullable `peerId → FederationPeer` + `remoteId` (the peer's cuid for the entity).
- Serialized track IDs for the frontend/Subsonic follow the existing convention (`tidal:<id>` in `services/unifiedTrackResponse.ts`) as `federated:<peerId>:<trackId>` where a discriminated ID is needed; within the DB they are ordinary cuids, so `Play`, `PlaylistItem`, and `TrackMapping` reference them with the **existing** `trackId` column — no new polymorphic FK columns (the per-source-table pattern of `TrackTidal` is explicitly avoided; it's the part of the current model that scales worst).

**Sync worker.** New Bull queue + processor in `backend/src/workers/` (`federation-sync`): initial full catalog pull, then scheduled delta pulls (default 15 min, configurable). Upserts rows, populates `searchVector` (automatic on insert), updates denormalized counts via `artistCountsService.ts`, imports embeddings into `TrackEmbedding` when scoped. Bounded batches, resumable via `lastSyncCursor`, per-peer advisory lock so replicas don't double-sync.

**Dedup.** Reuse the existing arbitration hierarchy from `trackMappingService.ts`, extended with the durable identity keys from the prerequisite feature (`docs/designs/durable-track-identity.md`):

1. Album: `rgMbid` exact match (strongest key; both sides run MusicBrainz enrichment). Skip `temp-` placeholder mbids.
2. Artist: `mbid`, then `normalizedName` (`utils/artistNormalization.ts`).
3. Track: `recordingMbid`, then `isrc`, then `(rgMbid, discNo, trackNo)`, then normalized title + duration tolerance. The catalog envelope carries all of these keys. Matches key on durable attributes, not the peer's cuid — when a peer's IDs churn (file reorg on their side), the consumer re-binds `remoteId` on its existing federated row instead of dropping and recreating it.

When a federated album matches a local `LIBRARY` album, the consumer records the link (in `TrackMapping` with `source: "federation"`) but **does not insert duplicate browse rows** — local wins, and the federated copy is retained only as an alternate stream source. Dedup across two *peers* keeps one row (first-synced wins) with alternates recorded. A per-peer "show duplicates" toggle is out of scope for v1.

**Playback.** `handleStreamTrack` (`backend/src/routes/library/tracks.ts`) branches on `origin`: federated tracks proxy from `GET {peer.baseUrl}/api/federation/v1/stream/:remoteId` with the outbound token, streaming the response through with Range passthrough — the `tidalStreaming.ts` pattern. `Play` logging works unchanged (real `trackId`). Transcode caching of remote streams is off in v1 (respect the owner's bandwidth over disk; revisit later). Segmented/DASH streaming: out of scope v1; `routes/streaming.ts` keeps `sourceType: ["local"]`.

**Offline degradation.** A lightweight health check (worker pings `GET /manifest` on schedule; stream failures mark immediately) flips `FederationPeer.status` to `OFFLINE`. Catalog rows stay in the DB, so browse/search never break. API responses include `peer: { id, name, online }` on federated items; the frontend renders offline items greyed with `UnplayableBadge`-style treatment, and playback resolution skips them. An admin setting chooses grey-out (default) vs hide.

**Provenance UI (frontend).**

- `PeerBadge` component (sibling of `TidalBadge.tsx`), tooltip "From {peer name}".
- Injected via existing `TrackRowSlots.titleBadges` at the ~8–12 `toRowItem()` adapter call sites (album page, playlist page, discover, search, queue…). `MediaCard` already takes `badge?: ReactNode`; `PlayableCard`'s enum `badge` prop widens; `AlbumsGrid`'s hand-rolled card gets a small edit.
- Now playing: badge alongside `SyncBadge`/`PlaybackQualityBadge` in `FullPlayer.tsx`.
- Filters: a "Peers" pill in `SearchFilters.tsx` gated on the `federation` feature flag (exact precedent: the Soulseek pill), plus an All/Local/Peers toggle on the library pages.
- Playlists/mixes/recommendations get the badge for free via the shared `TrackList` slots; mix/radio *generation* includes federated tracks only when the peer is online and the user hasn't filtered them out.
- New API mixin `frontend/lib/api/federation.ts` on `ApiClientCore` (mechanical, 23 precedents).

**Admin UI.** `FederationSection.tsx` under `features/settings/components/sections/` + sidebar entry in `app/admin/page.tsx`: list peers (`ConnectionCard` pattern with status/test), add peer (pairing code or URL+token), scope checkboxes, sync now / view last sync, revoke. Feature flag `FEDERATION_ENABLED` (default `false`) follows the existing coarse-flag pattern (`config.features.*` — routes unmounted and workers unregistered when off), surfaced to the frontend via `features-context.tsx`.

### Security considerations

- Peer tokens: 32-byte random, HMAC-hashed at rest (`apiKeyHash.ts`), shown once, revocable, scoped, never a user identity. Outbound tokens encrypted at rest like TIDAL OAuth material.
- Read-only enforced structurally: the federation router simply has no mutating endpoints, and `req.federationPeer` (not `req.user`) means existing write routes can't be reached with a peer credential at all.
- HTTPS required for peer `baseUrl` in production (validated on save; explicit override env for LAN/dev).
- Per-peer rate limits on catalog and stream endpoints; stream concurrency cap per peer to protect host bandwidth.
- No transitive re-export (only `LIBRARY` content is served). No user PII crosses the wire — catalog is media metadata only; plays/likes/playlists never leave the instance.
- Outbound requests from the sync worker follow Modern Coding Rules #4: timeouts, retry limits, backoff, bounded pagination.
- Licensing note for docs: federation shares access to media between private instances; the admin enabling it is responsible for who they link with (same posture as share links today).

## Phasing

| Phase | Scope | Ships value alone? |
| --- | --- | --- |
| **0. Durable track identity** (separate feature, ships first) | `Track.recordingMbid`/`isrc` columns read from tags + scanner move detection — see `docs/designs/durable-track-identity.md` | Yes — fixes local data loss on file reorgs (playlists, likes, embeddings) independent of federation |
| **1. Federation API** | `FederationPeer` model + admin issue/revoke UI + read-only v1 API (manifest/catalog/cover/stream) + peer auth middleware | Yes — external consumers/scripts can browse & stream with a scoped token; also the substrate for phase 2 |
| **2. Swarm read path** | Consumer peer linking (pairing flow), sync worker, `FEDERATED` rows, stream proxy, provenance badges + filters, offline greying | Yes — the headline feature |
| **3. Intelligence & polish** | Embedding import → vibe/mixes/radio inclusion, dedup arbitration UI, Subsonic exposure of federated items, per-peer settings (hide/show, bandwidth caps) | Incremental |

## Feasibility assessment

**Verdict: feasible with medium-high effort; no architectural blockers.** The schema and runtime were already pushed toward multi-source by TIDAL/YT gap-fill — federation lands on existing seams rather than fighting the design.

**What makes it tractable (verified, not assumed):**

- Provenance fields half-exist: `Album.location` enum, `Artist.remoteTrackCount`, `filter=remote` in the artists route.
- Remote streams already proxy through the backend (two precedents), and stream URLs are query-token media-element URLs, so the player needs almost nothing.
- Dedup keys exist at album/artist level (`rgMbid @unique`, `mbid @unique`, `normalizedName`) with an arbitration model (`TrackMapping.confidence/source`) to extend.
- Credential plumbing (hashing, constant-time compare, pairing-code flow, admin section pattern) is all reusable.
- Materialized sync means search/browse/Subsonic/vibe work on federated rows with near-zero changes to those subsystems.

**Hard parts / risks:**

1. **`Track.filePath` is non-nullable and unique** — the strongest local-only assumption. Making it nullable touches the scanner (`services/musicScanner.ts` upserts keyed on `filePath`), streaming, and any code assuming a path exists. Mitigation: `origin` discriminator checked before every file access; scanner queries add `origin: LOCAL`. This is the single most invasive schema change and the migration needs care.
2. **Track-level dedup precision** — local `Track` today has no MBID/ISRC/acoustid, and its identity is the file path (a reorg on either side breaks matches). Addressed by the **durable track identity prerequisite** (`docs/designs/durable-track-identity.md`): `recordingMbid`/`isrc` columns from tags plus scanner move detection. With it, matching is exact for tagged libraries and the peer delta feed stays quiet during reorgs; without it, matching degrades to `(rgMbid, discNo, trackNo)`/title+duration.
3. **Deletion/consistency drift** — peers must emit tombstones and consumers must handle cursor resets (peer re-scanned, DB restored). Full-resync fallback required; sync must be idempotent.
4. **Mixes/discovery contamination** — federated tracks entering mood buckets, Discover Weekly seeds, and shuffle needs explicit inclusion rules (online-only, user filter respected) or the feature feels broken when a peer sleeps. Phase 3 gates this deliberately.
5. **Version skew** — peers on different soundspan versions. The `/v1` prefix + manifest version handshake addresses it; catalog payloads must evolve additively.
6. **Host bandwidth** — N friends streaming from one home connection. Per-peer stream concurrency caps and quality caps in v1; no transcode-cache of others' media by default.
7. **Blast radius of browse-query changes** — every list endpoint (and Subsonic) must default correctly for users who never enable federation. The `FEDERATION_ENABLED=false` default plus `origin` filters keeps the flag-off path byte-identical.

**Rough effort (working sessions, not calendar):**

| Work item | Estimate |
| --- | --- |
| Phase 1: model + migrations + peer auth middleware + v1 API + admin credential UI + tests | ~2–3 weeks equivalent |
| Phase 2: pairing, sync worker + tombstones, `Track` schema change, stream proxy, frontend badges/filters/admin, degradation + tests | ~4–6 weeks equivalent |
| Phase 3: embeddings import, vibe/mixes inclusion rules, Subsonic surface, polish | ~2–3 weeks equivalent |

Testing per repo contract: behavioral tests against real PostgreSQL for sync/dedup/tombstones, negative-path tests for peer auth (scope enforcement, revoked/expired, `req.user` absence), range-request tests for the stream proxy, component tests for badge/filter rendering. Targeted suites only (no full-suite runs).

## Resolved decisions (2026-08-14)

Confirmed with the project owner:

1. **New `FEDERATED` variant** in `Album.location` (and the track `origin` discriminator). `REMOTE` keeps meaning streaming-only Tidal/YT content; filters and denormalized counts stay unambiguous.
2. **Embedding sharing is opt-in per link.** `embeddings:read` is a per-peer admin checkbox, off by default.
3. **Local always wins** when the same release exists locally and on a peer. The federated copy is retained only as a hidden alternate stream source.
4. **Subsonic exposure lands in phase 3.** External Subsonic clients see local media only until the web-app federation path is proven.
5. **All media types federate eventually.** Music ships first, but the catalog API uses the generic media-item envelope from day one so podcasts and audiobooks become additive `mediaType` values, not a v2 API.
