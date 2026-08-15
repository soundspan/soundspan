# Federated Library Sharing — Implementation Plan

Companion to [federated-library-sharing.md](federated-library-sharing.md) (the spec, issue #451). Drafted 2026-08-15 at the start of implementation on `feature/federated-library-sharing`. Status: **F1–F9 complete; implementation is pending its F10 release review**. The spec's Resolved Decisions are implemented; this document records the build order, per-chunk contracts, and reviewed implementation decisions marked **[D]**.

## Context updates since the spec

- The **durable track identity prerequisite shipped** (#457, merged): `Track.audioHash`, `recordingMbid`, `isrc`, and `removedAt` all exist with backfill. The federation sync processor uses the same durable keys as its top dedup tiers, which is stronger than the original spec assumed.
- The removed-track exclusion audit introduced shared visibility fragments (`TRACK_VISIBLE_WHERE`, `LIBRARY_TRACK_WHERE`, `VISIBLE_TRACK_SQL`, `trackWhere()`); federation reuses the same pattern for origin scoping.

## Implementation decisions [D]

1. **Intelligence surfaces exclude federated tracks in v1.** Mixes, radio, vibe/similarity, discovery seeds, shuffle, and mood buckets operate on `origin: LOCAL` only. Rationale: deterministic behavior when peers sleep, and the spec already gates intelligence to phase 3. Browse, search, artist/album pages, playlists, and playback include federated items. A shared `LOCAL_TRACK_WHERE` fragment (sibling of `TRACK_VISIBLE_WHERE`) enforces this.
2. **Subsonic (`/rest`) exposes local content only in v1** — per the spec's resolved decision 4. Documented in OPENSUBSONIC_COMPATIBILITY.md.
3. **No transcoding of federated streams.** The consumer proxies bytes with Range passthrough; the quality parameter is forwarded to the host, which transcodes with its own cache. Protects consumer disk and keeps the host authoritative over its bandwidth.
4. **Tombstones are written only while federation is enabled** (`FEDERATION_ENABLED`), from the two places rows die: the retention purge and orphan cleanup. Tombstone retention is 90 days (`FEDERATION_TOMBSTONE_RETENTION_DAYS`). A cursor older than the retention window minus a two-day margin is rejected as stale, and the consumer performs a full resync. Duplicate tombstone rows for repeated deletion events are accepted because application is idempotent and retention removes them.
5. **Delta progress uses an `updatedAt` high-water mark plus instance `catalogEpoch`.** Artist, album, and track rows all expose Prisma-maintained `updatedAt` values. The consumer persists the high-water timestamp in `lastSyncCursor`; the host uses a timestamp-and-ID keyset within each bounded delta page. A UUID `catalogEpoch` mismatch or stale cursor forces a full resync. Full sync starts from the host manifest's `serverTime`, with a logged local-clock fallback for older hosts. A five-minute overlap on incremental pulls absorbs clock skew; idempotent upserts make overlap safe.
6. **Instance identity uses UUIDs.** Generated `federationInstanceId` and `catalogEpoch` UUIDs are stored in `SystemSettings` when identity is first needed and reported in the manifest.
7. **Embedding sharing ships as scoped API support host-side** (`embeddings:read` includes 512-dim vectors in track envelopes) **and consumer-side import into `TrackEmbedding`**, but federated tracks still do not join vibe/similarity in v1 (decision 1). The data lands so enabling intelligence later is a query change, not a resync.
8. **Downloads, offline caching, and share links exclude federated items.** You cannot share, zip, or offline-cache media you don't host. Stream-through is the only egress.
9. **Peer stream auth**: the consumer's backend attaches the outbound token as `Authorization: Bearer` on proxied requests. Browser never sees peer credentials; frontend URLs stay same-origin.
10. **Federated track IDs stay ordinary cuids locally.** The wire envelope uses the host's IDs; the consumer stores them as `(peerId, remoteId)` unique pairs. `unifiedTrackResponse` exposes `source: "federated"` plus `peer: { id, name, online }`.
11. **Manifest instance name uses `HOSTNAME`.** `config.federation.instanceName` reports `process.env.HOSTNAME`, with `soundspan` as the fallback, because `SystemSettings` has no instance-name field.
12. **Existing denormalized artist counts remain local-only.** Federation sync may run the count backfill after catalog changes, but `libraryAlbumCount`, `discoveryAlbumCount`, and `totalTrackCount` exclude `FEDERATED` tracks. Peer-aware browse and search use their own row filters and projections.
13. **Lyrics remain local-only in v1.** The persisted-track lookup combines visible and local track predicates, so federated rows do not enter embedded or LRCLIB enrichment through the track-backed path.
14. **Bidirectional peers are not supported in v1.** Creation and linking reject `BOTH`; the schema value remains reserved for future protocol work. Credential rotation applies only to host peers, preserves `ACTIVE` or `OFFLINE`, advances `PENDING` to `ACTIVE`, and never revives `REVOKED` peers.
15. **Private-network federation is intentional.** Admin-configured HTTPS peer URLs may resolve to LAN, private, or VPN addresses. Federation requests disable redirects and bound time, retries, concurrency, and JSON response size. The public-address-only SSRF rule is not applied because private networking is a primary self-hosted use case; administrators must treat linked peers as trusted.
16. **Removed tracks never seed intelligence.** `TRACK_VISIBLE_WHERE` applies to play and like history used by mixes, radio, and recommendations, so retained soft-removed rows cannot influence generated results.

## Review disposition appendix

The release review accepted these behaviors without code changes:

- A stalled sync may transiently interleave with a replacement job; idempotent upserts repair the result.
- A concurrent MusicBrainz-ID uniqueness race may fail one sync attempt; the bounded retry and next sync self-heal it.
- Deleting a peer cascades its mirrored rows and playlist items. The destructive scope is disclosed in the changelog and confirmation UI.
- Full-resync counters may count the same logical row more than once across overlapping pages; the effect is cosmetic.
- Federation credentials share the configured HMAC pepper. Their independent random values and scoped verification make this acceptable for v1.
- The peer-specific limiter runs after authentication. The global API limiter still covers unauthenticated traffic.
- The 52 frontend component-suite failures measured on `main` remain the comparison baseline; the federation-specific regression must pass within that sweep.
- Duplicate tombstone rows are accepted because tombstone application is idempotent.

Known follow-up: batch catalog writes and reduce repeated
`backfillAllArtistCounts` work for higher sync throughput. This review does not
change those operations.

## Build chunks (each = one implementation increment + review gate + commit)

| # | Chunk | Status | Contents |
| --- | --- | --- | --- |
| F1 | Schema foundations | Complete | `FederationPeer`, `FederationTombstone`, `SystemSettings` UUID identity fields; `Track.origin` (`LOCAL\|FEDERATED`, default LOCAL), `Track.filePath` DROP NOT NULL, `peerId`/`remoteId` (+unique pair) on Artist/Album/Track; `AlbumLocation.FEDERATED`; expand-only migrations; scanner + purge + backfill guards (`origin: LOCAL`, `filePath: not null`) |
| F2 | Peer auth + credentials | Complete | `config.features.federation` (`FEDERATION_ENABLED`, default false); hashed peer credentials (reuse `apiKeyHash`); `requireFederationPeer(scope)` middleware → `req.federationPeer` (never `req.user`); admin peer CRUD routes (`requireAuth`+`requireAdmin`): create/list/rotate/revoke + pairing-code flow (DeviceLinkCode pattern); per-peer rate limiter |
| F3 | Host federation API | Complete | `/api/federation/v1`: `GET /manifest` (UUID identity/epoch, `HOSTNAME` name, version, local-only counts, media types); generic keyset catalog and delta envelopes; cover and Range stream endpoints; visible local-library export only; `stream:read`/`library:read`/`embeddings:read` scopes; tombstone writes in purge + orphan cleanup |
| F4 | Consumer sync | Complete | `federation-sync` queue/processor: full import + delta; upsert FEDERATED artist/album/track rows keyed `(peerId, remoteId)`; identity-tier local dedup through `dedupOfTrackId` and `TrackMapping source:"federation"`; scoped embedding import; peer health; bounded/resumable/idempotent epoch resync; local-only denormalized counts preserved |
| F5 | Consumer playback | Complete | Stream route branch for `origin: FEDERATED` → proxy `{peer.baseUrl}/api/federation/v1/stream/:remoteId` (Range passthrough, no cache); cover proxy fallback; `unifiedTrackResponse` `source:"federated"` + peer info; play logging unchanged; offline-peer → 503 with typed code |
| F6 | Admin UI + API mixin | Complete | `FederationSection.tsx` (peers list/status/scopes/sync-now/revoke, add via pairing code or URL+token), sidebar entry, `frontend/lib/api/federation.ts` mixin, features-context flag |
| F7 | Frontend provenance | Complete | `PeerBadge` via track-row/card badge slots; now-playing badge; flag-gated Search “Peers” pill; library Local/Peers filter; offline greying from `peer.online` |
| F8 | Surface scoping | Complete | `LOCAL_TRACK_WHERE` applied to mixes/radio/vibe/discovery/shuffle/mood/Subsonic/downloads/offline/share-links and lyrics; browse/search include non-deduplicated FEDERATED rows; denormalized counts stay local; flag-off equivalence proven |
| F9 | Docs + contracts | Complete | Architecture, data model, environment, security, feature index, route/service indexes, OpenSubsonic contract, changelog, and design status synchronized to F1–F8 |
| F10 | Release review + sweep + PR | Pending | Adversarial review, chunked regression sweep, all enforcement gates, and PR publication |

## Non-negotiable engineering constraints (from coding-handbook + AGENTS.md)

Expand-only migrations with `CONCURRENTLY` indexes; all outbound peer HTTP bounded (timeout, retry limit, backoff, concurrency cap) through a single federation HTTP client; peer sync bounded/resumable/idempotent/observable with keyset+epoch cursors; no floating promises; catch narrowed `unknown`; errors never identified by message text; raw-error leak ratchet at zero for all new files; functions ≤60 lines; TDD per chunk with negative-path tests at every trust boundary (peer auth scope enforcement, revoked/expired credentials, malformed envelopes, epoch mismatch, offline peer); mocked-prisma unit style per repo convention; targeted suites only; Prettier/format gate before every commit; no AI attribution in commits.

## Testing strategy

- Peer API: route tests with mocked prisma + supertest-style handlers (repo convention), covering scope enforcement, pagination, tombstones, Range streaming, and rejection paths.
- Sync: processor tests proving idempotent re-runs, epoch resync, dedup tiers (local wins), tombstone application (soft-hide vs delete), embedding import gating.
- Playback proxy: Range passthrough, peer-offline 503, no credential leak to client.
- Frontend: component tests for PeerBadge rendering, filter pills, admin section states.
- Flag-off: with `FEDERATION_ENABLED=false`, routes unmounted (404 FEATURE_DISABLED pattern), workers unregistered, zero schema-visible behavior change.
