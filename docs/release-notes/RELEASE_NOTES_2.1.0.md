# [2.1.0] Release Notes - 2026-08-16

Soundspan 2.1.0 adds single sign-on, federated library sharing, and durable
track identity.

- **OIDC/SSO login.** Connect any OpenID Connect provider (Authentik,
  Keycloak, Authelia, Pocket ID, or a cloud IdP). Identities link to local
  accounts by `(provider, sub)`. An email match never links silently — the
  user confirms with their local password first. Unknown identities go
  through the existing invite-code gate unless you explicitly enable
  automatic provisioning. Roles stay local unless you opt into IdP group
  management. See the new [OIDC and SSO guide](../OIDC_SSO.md).
- **App passwords for OpenSubsonic clients.** SSO users have no account
  password, so every user can now mint revocable `ssap_` app passwords for
  Subsonic apps. Secrets are encrypted at rest, shown once, and work with
  both password and token authentication.
- **Federated library sharing.** Link soundspan instances as peers and
  browse, stream, and mix a friend's library with local-wins deduplication,
  provenance labels, bandwidth and concurrency caps, and full administrator
  lifecycle controls. Disabled by default.
- **Durable track identity.** Tracks keep their IDs, playlists, likes,
  history, and analysis when files move, rename, or are retagged. Missing
  files soft-remove with a retention window and revive automatically when
  they return.
- **Smarter discovery.** Discover Weekly rotates seed artists
  deterministically each week with repeat-artist decay, and random/radio
  selection enforces artist-diversity caps.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.1.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

If you already run 2.0.x, no manual steps are required:

- The database migration for the new OIDC and app-password tables runs
  automatically at startup (`prisma migrate deploy`). It adds tables and
  makes one column nullable; it does not rewrite existing rows.
- Every new capability ships disabled by default (`OIDC_ENABLED=false`,
  `FEDERATION_ENABLED=false`). Existing logins and Subsonic clients keep
  working unchanged.
- If the browser reaches your deployment over HTTPS, set
  `SECURE_COOKIES=true` to get the hardened `__Host-` OIDC flow cookie.

## Fixed

- OIDC browser flows now bind callback and one-time hand-off tokens to the
  initiating browser, count redirect responses against rate limits, serialize
  role demotion and identity unlink guards, enforce one identity per provider
  for each user, and preserve the original ten-minute expiry across link and
  invite retries.
- Federation pairing now denies reciprocal library sharing by default. The
  consumer sends callback credentials and upgrades to `BOTH` only when an
  administrator explicitly selects bidirectional sharing.
- Federated stream cache fills now accept only complete status-200 responses,
  bypass known oversized responses, enforce a remaining-capacity byte ceiling
  for unknown lengths, remove partial files after overflow or write failure,
  and retry capacity overflows as uncached streams.
- Subsonic playlist listing and item reads again include visible playlist
  tracks from discovery albums while retaining federated local-wins dedup
  suppression.
- Federation deltas now detect artist and album changes through maintained
  update timestamps, recover missing parent rows directly, reject expired
  cursors with a full resync, and anchor initial cursors to host time.
- Federation sync now rechecks deduplication when a matching local file arrives,
  reveals peer copies whose local winner was soft-removed, retries bounded jobs,
  and queues one follow-up when “sync now” overlaps an active run.
- Federation peer calls now cap JSON responses, release rejected stream bodies,
  preserve inbound status during credential rotation, reject duplicate links,
  and avoid logging failed offline plays.
- Soft-removed library tracks are now excluded from library, search, radio,
  recommendation, streaming, Subsonic, sharing, import-matching, and offline
  read surfaces. Playlists and play history retain removed entries as
  unplayable records, while Subsonic playlists omit them.
- Continue Listening and social now-listening no longer expose missing or
  soft-removed local tracks retained for possible revival.
- Background audio-analysis and vibe-embedding producers now use bounded,
  deduplicated Redis admission and leave queued tracks pending until an
  analyzer claims them. Queue wait time no longer consumes the processing
  timeout or creates false stale-processing failures during large library
  imports.
- Retrying all failed analyzer work now resets retry budgets and lets the
  bounded background producer drain the backlog instead of enqueueing every
  failed track at once. Selected vibe failures can also be retried correctly.
- Backend track-mapping reconciliation now reuses a normalized local-library
  index, yields between mapping attempts, and enforces configurable per-run
  row and time limits. The scheduler persists its continuation cursor in Redis
  so bounded runs advance across larger backlogs. Large unmatched backlogs no
  longer block worker readiness probes or Bull lock renewal indefinitely.

## Added

- Added OIDC/SSO login with explicit `(provider, sub)` account links,
  local-password confirmation for email-hinted links, invite-gated account
  provisioning by default, and `OIDC_WEB_BASE_URL` support for same-site web/API
  origins on sibling subdomains or different ports.
- Added revocable `ssap_` app passwords for OpenSubsonic password and token
  authentication. Each secret is encrypted at rest and shown once.
- Added `LOCAL_LOGIN_ENABLED` so operators can hide local login after they
  verify OIDC. Startup rejects configurations that disable every login method.
- Added administrator visibility for SSO-linked and OIDC-only users.
- Added opt-in federated library sharing, disabled by default with
  `FEDERATION_ENABLED=false`:
  - Host instances expose a read-only `/api/federation/v1` manifest, catalog,
    delta, cover, and Range-streaming API through scoped, HMAC-protected peer
    credentials, short-lived pairing codes, and administrator lifecycle
    controls.
  - Consumer instances link peers, run bounded catalog sync and health jobs,
    materialize peer music with local-wins identity deduplication, and proxy
    covers and streams without exposing encrypted outbound tokens to browsers.
    `FEDERATION_SYNC_INTERVAL_MINUTES` controls sync scheduling (default `15`).
    Deleting a peer also permanently removes its mirrored catalog and any
    playlist items that reference those mirrored tracks.
  - Library, search, artist, album, playlist, queue, and now-playing surfaces
    show peer provenance, source filters, and offline state. Deduplicated peer
    copies stay hidden while the matching local track wins.
  - Federated tracks now participate in mixes, radio, recommendations,
    discovery, vibe/similarity, mood buckets, shuffle, Listen Together,
    metadata-based lyrics lookup, and Subsonic metadata/playlists/playback.
    Local-wins deduplication suppresses peer twins while their local winner is
    active. File analysis/enrichment, imports, acquisition/offline downloads,
    share links, and denormalized artist counts remain local-only.
  - Catalog sync carries optional analyzer feature columns with bounded wire
    validation. Complete non-Range peer streams use the consumer's existing
    transcode cache with concurrent-fill coalescing; Range misses pass through
    without partial caching, and audio-hash changes or peer deletion remove
    cached rows and files.
  - Federation-aware deletion cleanup writes track, album, and artist
    tombstones transactionally.
    `FEDERATION_TOMBSTONE_RETENTION_DAYS` controls retention (default `90`;
    minimum `3`).
  - Federation peers can now link bidirectionally as one `BOTH` row. Reciprocal
    pairing uses bounded callbacks and degrades to a working one-directional
    link with a warning when the callback fails. Inbound authentication and
    outbound health now have independent statuses. (#479)
  - Federation now includes podcast catalog listings and full audiobook
    mirrors. Podcast feeds remain native subscriptions and episodes are not
    mirrored. Federated audiobooks support list, detail, search, cover, Range
    streaming, and local progress without requiring Audiobookshelf on the
    consumer. The double proxy inherits the existing Audiobookshelf
    `media.tracks[0]` single-track limitation. Closes #477.
  - Federation peers now have per-peer duplicate visibility and nullable host
    stream caps. Distributed concurrent-stream admission returns typed `429`
    responses with retry guidance, bandwidth caps pace track and audiobook
    streams, and administrators can keyset-page and pin link/unlink dedup
    decisions or reset them to automatic matching. Closes #476.
- Removed library tracks are now retained for automatic revival when their
  files return. `TRACK_REMOVAL_RETENTION_DAYS` configures the retention window
  before the daily purge permanently deletes them (default `90`; `0` purges
  on the next cycle).
- Tracks now store tag-invariant audio hashes, MusicBrainz recording IDs, and
  ISRCs for durable identity matching. New and changed files populate these
  keys during scans, while a bounded resumable worker backfills existing
  libraries automatically.
- The dedicated backend worker image now bundles ffmpeg so scans and the
  audio-hash backfill can compute durable track identity hashes.
- The audio-hash backfill now also populates recording MBID and ISRC tag keys
  for existing unchanged tracks.
- Library Health now distinguishes and counts removed tracks that are pending
  retention purge, shows the configured retention window, and explains that a
  rescan restores a track when its file returns.
- The enrichment failures modal now provides confirmed, tab-specific “Retry
  all” actions for Audio Analysis and Vibe Embeddings failures.

## Changed

- Hardened OIDC and app-password credential mutations with interactive-auth
  checks, race-safe PostgreSQL advisory locks, secure `__Host-` flow cookies,
  and complete bounded app-password authentication scans.
- Administrator role editing now warns when OIDC role management can overwrite
  a linked user's manual role change at their next SSO login.
- Discover Weekly now rotates play-weighted seed artists deterministically each
  user-week and decays scores for artists featured in up to three of the prior
  six weeks.
- Subsonic `getRandomSongs` now uses artist-diversity weighted sampling, then
  tops up from remaining candidates to preserve the requested response size.
- Score-ranked discovery and artist-radio selection now share the common artist
  cap primitive. Narrow artist-radio pools respect the hard artist-share ceiling
  and may return fewer tracks instead of using an uncapped refill.
- Federated audiobook mirror IDs now use the Node.js `randomUUID()` standard
  library API; the direct `@paralleldrive/cuid2` dependency was removed.
- Federation sync now batches per-page identity and local dedup reads, limits
  incremental artist-count recomputation to touched artists, and persists a
  full-sync page cursor. Resumed full syncs perform a fresh catalog-ID pass
  before cleanup so they converge with uninterrupted syncs. (#478)
- Search queries are now limited to 500 characters. Undeclared query
  parameters remain ignored for compatibility with existing callers.
- Library orphan cleanup deletes at most 10,000 albums and 10,000 artists per
  pass to bound each purge cycle.
- Soft-removed tracks retained for recovery no longer seed mixes, radio, or
  recommendations through play or like history.
- Library scans now soft-remove missing tracks instead of cascading immediate
  deletion. Same-path returns and cross-scan moves revive the original track
  row, including its playlists, likes, history, and analysis metadata.
- Library scans now preserve track IDs, playlists, likes, play history, and
  existing analysis when files move, rename, or are retagged. Replacing audio
  at the same path or matching a moved quality upgrade re-queues audio and
  vibe analysis and invalidates embeddings and transcoded cache files.
- Removed playlist items now use a muted, greyed treatment with a restore-file
  tooltip, while other unavailable-provider items keep their existing warning
  treatment.

## Admin and operations

- New optional environment variables, all inert until you enable their
  feature: `OIDC_ENABLED`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_WEB_BASE_URL`,
  `OIDC_SCOPES`, `OIDC_AUTO_PROVISION`, `OIDC_MANAGE_ROLES`,
  `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP`, `OIDC_EMAIL_CLAIM`,
  `OIDC_NAME_CLAIM`, `OIDC_PROVIDER_NAME`, `LOCAL_LOGIN_ENABLED`,
  `TRACK_REMOVAL_RETENTION_DAYS`, and the `FEDERATION_*` family. See
  [ENVIRONMENT_VARIABLES.md](../ENVIRONMENT_VARIABLES.md).
- The [OIDC and SSO guide](../OIDC_SSO.md) covers provider setup (Authentik,
  Keycloak, Authelia, Pocket ID), a deployment topology matrix,
  troubleshooting, and break-glass recovery.
- Startup validation fails fast on unsafe combinations: OIDC enabled with
  missing required values, every login method disabled, or role management
  without an admin group.
- The Helm chart sources `OIDC_CLIENT_SECRET` from a Secret like other
  sensitive values; the compose files pass the OIDC variables through
  commented defaults.

## Accessibility

- No accessibility improvements documented in this release.

## Deployment and distribution

- Docker images: `ghcr.io/soundspan/*:2.1.0`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.1.0
```

The chart is published only after all `2.1.0` image tags are available.

## Breaking changes

- None. All new features are opt-in and default to disabled.

## Known issues

- Cross-site deployments that serve the web app and API from different
  registrable domains are not supported for OIDC login. See the deployment
  topology matrix in the [OIDC and SSO guide](../OIDC_SSO.md).

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.1.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full changelog

- Compare changes: [2.0.2...2.1.0](https://github.com/soundspan/soundspan/compare/2.0.2...2.1.0)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.1.0/CHANGELOG.md)
