# Federated Library Sharing — Implementation Plan

Companion to [federated-library-sharing.md](federated-library-sharing.md) (the spec, issue #451). Drafted 2026-08-15 at the start of implementation on `feature/federated-library-sharing`. The spec's Resolved Decisions stand; this document adds the build order, per-chunk contracts, and the decisions made during implementation (marked **[D]** — best-judgment calls to review after the fact).

## Context updates since the spec

- The **durable track identity prerequisite shipped** (#457, merged): `Track.audioHash`, `recordingMbid`, `isrc`, `removedAt` all exist with backfill. Federation dedup uses these as its top tiers via the existing `matchTrackIdentities` matcher and `trackIdentityTags` helper — stronger than the spec assumed.
- The removed-track exclusion audit introduced shared visibility fragments (`TRACK_VISIBLE_WHERE`, `LIBRARY_TRACK_WHERE`, `VISIBLE_TRACK_SQL`, `trackWhere()`); federation reuses the same pattern for origin scoping.

## Implementation decisions [D]

1. **Intelligence surfaces exclude federated tracks in v1.** Mixes, radio, vibe/similarity, discovery seeds, shuffle, and mood buckets operate on `origin: LOCAL` only. Rationale: deterministic behavior when peers sleep, and the spec already gates intelligence to phase 3. Browse, search, artist/album pages, playlists, and playback include federated items. A shared `LOCAL_TRACK_WHERE` fragment (sibling of `TRACK_VISIBLE_WHERE`) enforces this.
2. **Subsonic (`/rest`) exposes local content only in v1** — per the spec's resolved decision 4. Documented in OPENSUBSONIC_COMPATIBILITY.md.
3. **No transcoding of federated streams.** The consumer proxies bytes with Range passthrough; the quality parameter is forwarded to the host, which transcodes with its own cache. Protects consumer disk and keeps the host authoritative over its bandwidth.
4. **Tombstones are written only while federation is enabled** (`FEDERATION_ENABLED`), from the two places rows die: the retention purge and orphan cleanup. Tombstone retention 90 days (`FEDERATION_TOMBSTONE_RETENTION_DAYS`); a consumer whose cursor predates available tombstones performs a full resync.
5. **Delta cursor = (`updatedAt` high-water mark, instance `catalogEpoch`).** The host manifest carries a `catalogEpoch` (bumped on restore-from-backup or manual reset); an epoch mismatch forces full resync. Overlap window of 5 minutes on incremental pulls absorbs clock skew; upserts are idempotent so overlap is harmless.
6. **Instance identity** is a generated `federationInstanceId` (cuid) stored in `SystemSettings` on first enable, reported in the manifest.
7. **Embedding sharing ships as scoped API support host-side** (`embeddings:read` includes 512-dim vectors in track envelopes) **and consumer-side import into `TrackEmbedding`**, but federated tracks still do not join vibe/similarity in v1 (decision 1). The data lands so enabling intelligence later is a query change, not a resync.
8. **Downloads, offline caching, and share links exclude federated items.** You cannot share, zip, or offline-cache media you don't host. Stream-through is the only egress.
9. **Peer stream auth**: the consumer's backend attaches the outbound token as `Authorization: Bearer` on proxied requests. Browser never sees peer credentials; frontend URLs stay same-origin.
10. **Federated track IDs stay ordinary cuids locally.** The wire envelope uses the host's IDs; the consumer stores them as `(peerId, remoteId)` unique pairs. `unifiedTrackResponse` exposes `source: "federated"` plus `peer: { id, name, online }`.

## Build chunks (each = one Codex dispatch + review gate + commit)

| # | Chunk | Contents |
|---|---|---|
| F1 | Schema foundations | `FederationPeer`, `FederationTombstone`, `SystemSettings.federationInstanceId`; `Track.origin` (`LOCAL\|FEDERATED`, default LOCAL), `Track.filePath` DROP NOT NULL, `peerId`/`remoteId` (+unique pair) on Artist/Album/Track; `AlbumLocation.FEDERATED`; expand-only migrations; scanner + purge + backfill guards (`origin: LOCAL`, `filePath: not null`) |
| F2 | Peer auth + credentials | `config.features.federation` (`FEDERATION_ENABLED`, default false); hashed peer credentials (reuse `apiKeyHash`); `requireFederationPeer(scope)` middleware → `req.federationPeer` (never `req.user`); admin peer CRUD routes (`requireAuth`+`requireAdmin`): create/list/rotate/revoke + pairing-code flow (DeviceLinkCode pattern); per-peer rate limiter |
| F3 | Host federation API | `/api/federation/v1`: `GET /manifest` (instanceId, name, version, catalogEpoch, counts, mediaTypes); `GET /catalog/items?type&cursor` generic envelope `{id, mediaType, updatedAt, parentRef?, attributes}` keyset-paged; `GET /catalog/delta?since&epoch` (changes + tombstones); `GET /cover/:itemId`; `GET /stream/:itemId` (Range, quality, `AudioStreamingService`); LIBRARY + visible only; `stream:read`/`library:read`/`embeddings:read` scopes; tombstone writes wired into purge + orphan cleanup |
| F4 | Consumer sync | `federation-sync` queue/processor: full import + delta; upsert FEDERATED artist/album/track rows keyed `(peerId, remoteId)`; dedup vs local via identity tiers (audioHash → recordingMbid → isrc → rgMbid+position) recording `TrackMapping source:"federation"`, local-wins (no duplicate browse rows — federated copy recorded as alternate only); embedding import when scoped; peer health-check job (manifest ping → ACTIVE/OFFLINE); counts backfill integration; bounded/resumable/idempotent with epoch resync |
| F5 | Consumer playback | Stream route branch for `origin: FEDERATED` → proxy `{peer.baseUrl}/api/federation/v1/stream/:remoteId` (Range passthrough, no cache); cover proxy fallback; `unifiedTrackResponse` `source:"federated"` + peer info; play logging unchanged; offline-peer → 503 with typed code |
| F6 | Admin UI + api mixin | `FederationSection.tsx` (peers list/status/scopes/sync-now/revoke, add via pairing code or URL+token), sidebar entry, `frontend/lib/api/federation.ts` mixin, features-context flag |
| F7 | Frontend provenance | `PeerBadge` (TidalBadge sibling) via `titleBadges`/card badge slots at the toRowItem adapters; now-playing badge; Search "Peers" pill (flag-gated, Soulseek precedent); library Local/Peers filter; offline greying from `peer.online` |
| F8 | Surface scoping | `LOCAL_TRACK_WHERE` applied to mixes/radio/vibe/discovery/shuffle/mood/Subsonic/downloads/offline/share-links; browse/search/count surfaces include FEDERATED; flag-off equivalence proven (zero federated rows ⇒ byte-identical) |
| F9 | Docs + contracts | ARCHITECTURE.md (topology + flows), DATA_MODEL.md, ENVIRONMENT_VARIABLES.md, FEATURE_INDEX.json, routes/services READMEs, OPENSUBSONIC note, CHANGELOG, spec status |
| F10 | Deep review + sweep + PR | Multi-agent adversarial review (correctness/concurrency, security/exclusion, quality/contracts), fix findings, chunked full-suite regression sweep, all enforcement gates locally, open PR |

## Non-negotiable engineering constraints (from coding-handbook + AGENTS.md)

Expand-only migrations with `CONCURRENTLY` indexes; all outbound peer HTTP bounded (timeout, retry limit, backoff, concurrency cap) through a single federation HTTP client; peer sync bounded/resumable/idempotent/observable with keyset+epoch cursors; no floating promises; catch narrowed `unknown`; errors never identified by message text; raw-error leak ratchet at zero for all new files; functions ≤60 lines; TDD per chunk with negative-path tests at every trust boundary (peer auth scope enforcement, revoked/expired credentials, malformed envelopes, epoch mismatch, offline peer); mocked-prisma unit style per repo convention; targeted suites only; Prettier/format gate before every commit; no AI attribution in commits.

## Testing strategy

- Peer API: route tests with mocked prisma + supertest-style handlers (repo convention), covering scope enforcement, pagination, tombstones, Range streaming, and rejection paths.
- Sync: processor tests proving idempotent re-runs, epoch resync, dedup tiers (local wins), tombstone application (soft-hide vs delete), embedding import gating.
- Playback proxy: Range passthrough, peer-offline 503, no credential leak to client.
- Frontend: component tests for PeerBadge rendering, filter pills, admin section states.
- Flag-off: with `FEDERATION_ENABLED=false`, routes unmounted (404 FEATURE_DISABLED pattern), workers unregistered, zero schema-visible behavior change.
