# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

### Added

### Changed

### Fixed

### Removed

- Removed the never-documented `/api/spotify` endpoints, unused Spotify
  credential settings fields, and unused Link Device settings section. Spotify
  playlist imports through the generic `/api/import` flow are unaffected. (#484)

## [2.1.0] - 2026-08-16

### Added

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

### Changed

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

### Fixed

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

## [2.0.2] - 2026-08-13

### Added

### Changed

### Fixed

- M3U playlist import previews no longer fail with a 15-second timeout on
  large libraries. The frontend now gives the M3U preview the same 60-second
  window as URL imports. The backend now matches entries against a prebuilt
  library index instead of re-sorting and re-normalizing every library track
  for each playlist entry, so previews complete in a fraction of the old
  time.

## [2.0.1] - 2026-08-13

### Added

### Changed

### Fixed

- The CLAP analyzer image now ships `pgrep` so the Helm chart's default liveness and readiness probes work (#448).

## [2.0.0] - 2026-08-12

### Added

- Added an opt-in `SECRETS_DB_ONLY` flag (default `false`). When enabled, integration secrets (Last.fm, Fanart.tv, Lidarr, OpenAI, Deezer, Audiobookshelf API keys) are read exclusively from encrypted system settings — the `.env` fallback for those keys is ignored and the settings-driven `.env` sync omits them. Startup fails fast if the settings layer is not readable before services start. Default behavior is unchanged.
- Added repo-wide Prettier and EditorConfig conventions, applied through
  mechanical per-package formatting commits. The six formatting-only commits
  are excluded from blame through `.git-blame-ignore-revs`.
- Added a blocking Python quality gate for Ruff lint/format checks and mypy
  analysis across all four sidecars.

- CI visibility now includes a `Python Sidecar Tests` matrix job in
  `quality-visibility.yml`, running the `pytest` suites for all four sidecars
  (tidal-downloader, ytmusic-streamer, audio-analyzer, and audio-analyzer-clap),
  including their internal-auth and security coverage, on every pull request.
  A new root `npm run verify:python` command runs the four suites locally, and
  both analyzer sidecars now have dedicated `requirements-test.txt` manifests.

### Changed

- API-key settings now show each key's expiry date with expired and
  expiring-soon badges, while API-key, linked-device, and two-factor setup
  actions surface interactive-session step-up failures inline.
- Consolidated component network calls behind the frontend API layer and added
  a boundary ratchet that prevents new direct `fetch()` calls in frontend app,
  component, and feature modules.
- Mypy now runs in strict mode with enumerated, justified per-module exceptions;
  tidal-downloader and ytmusic-streamer are fully strict, including their tests.
- Consolidated environment configuration reads into the backend config module
  for 20 more production files; the config-boundary allowlist shrank from 39
  files to 19.
- Frontend TypeScript now compiles under strict mode.
- Renamed playback telemetry so log names match their emitters:
  `player.howler_startup` → `player.engine_startup`;
  `route.client.signal` / `[SegmentedStreaming.Trace]` →
  `playback.client.signal` / `[Playback.Trace]` for client signals; and
  `[SegmentedStreaming][Metric] client.signal` →
  `[Playback.Metric] client.signal`, with client-ingestion errors moving from
  the `[SegmentedStreaming]` scope to `[Playback]`. Genuinely segmented
  manifest, segment, session, and DASH lifecycle telemetry keeps its existing
  names.
- Split the library routes into named, per-resource sub-routers while preserving
  the `/api/library` mount surface and registration order, completing #124.
- Extracted the library route helpers into typed utility modules as the first
  stage of the `library.ts` decomposition (#124); behavior is unchanged.
- Retained the Python 3.11 Essentia analyzer platform matrix after reevaluating
  current PyPI artifacts: `essentia-tensorflow` 2.1b6.dev1389 remains the newest
  CPython 3.11 manylinux x86-64 build, while 2.1b6.dev1438 is CPython 3.14-only.
  Documented its embedded TensorFlow C 2.5.0 runtime separately from the locked
  TensorFlow 2.15.1 Python package and established a deterministic MusiCNN model
  load/inference baseline without changing analyzer or AIO dependency locks.
- The Rediscover daily mix now builds its candidates from a bounded, indexed
  pool (overplayed tracks excluded via a grouped play query, then a capped track
  fetch) instead of loading and counting plays for the entire track library on
  every cache miss.
- The Subsonic `getPlaylists` endpoint now computes playlist durations with a
  single query over playlist items instead of one aggregate query per playlist,
  removing an unbounded N+1 fan-out that could saturate the database connection
  pool for users with many playlists.
- Promoted the segmented-streaming session service's identity-guarded
  keyed-singleflight into a shared backend helper and rethreaded transcode
  caching, vibe calibration, and both the YouTube Music and TIDAL OAuth-restore
  paths onto it, unifying the short-TTL negative-cache policy for OAuth restores
  and bounding the YouTube Music library limit params.
- Widened the route-error leak ratchet to catch `String(err)`, bare `${err}`,
  `.toString()`, `.name`, `JSON.stringify(err)`, plural `.errors`, and Axios
  `.response.data` interpolation idioms outside logger calls.
- The ytmusic-streamer auth endpoints (`/auth/restore`, `/auth/clear`, and the
  device-code poll success path) now offload credential-file writes and removals
  to the asyncio thread pool, matching the sidecar's established
  `asyncio.to_thread` pattern for blocking work.
- Replaced the three source-scraping `audioAnalyzer*Contract` Jest suites with
  behavioral pytest coverage in `services/audio-analyzer/tests/` for queue claim
  alignment, process-pool crash recovery, stale-failure resolution, and
  TensorFlow-free model loading, plus a producer-side pre-claim assertion in the
  unified-enrichment Jest suite.

- Renamed the backend RSS parser service file to
  `backend/src/services/rssParser.ts` to match the repo-wide camelCase service
  naming convention; imports, tests, and the service index were updated with no
  behavior change.
- Route error responses for Soulseek direct download, enrichment metadata 404s,
  downloads interactive releases, and the YouTube age-restriction case now use
  the canonical single-field `{ error }` envelope; the secondary `message` key
  is removed from those error bodies (the frontend keys on `error`), and the
  admin clear-Lidarr-queue response now reports an error count instead of
  echoing raw Lidarr error strings.
- Browse, discover, and releases routes now share one bounded-integer query
  parser; `limit` and day-range query params are clamped to safe maximums
  (limit <= 100, day ranges <= 365) instead of accepting unbounded values.
- Worker, background-processor, file-logger, middleware, and remaining frontend
  logging now uses the shared scoped `logger.child` helpers instead of ad-hoc
  `[bracket-tag]` message prefixes, so log scope is a structured field across
  tiers.
- Documented every CI gate in the AGENTS.md CI-gates table (adding the Python
  Quality, Enforcement Gates, and Backend/Frontend Typecheck jobs) and added a
  `verify:ci` npm script that reproduces all gates locally, including the Python
  ruff/mypy and sidecar-pytest gates that `npm run verify` omits.
- Lowered the enforced frontend ESLint warning budget from 244 to 183 and made
  timer-dependent frontend tests deterministic instead of waiting on real-time
  sleeps.
- Made the hardcoded-hex baseline (130), per-file route-error canonicalization
  baselines, OpenAPI route synchronization, and repository-wide Prettier/Ruff
  format checks blocking CI enforcement gates.

- **Frontend audio orchestrator decomposition (first increment).** The
  `AudioPlaybackOrchestrator` no longer reads the deprecated composite
  `useAudioPlayback()` context; its body now subscribes only to
  `usePlaybackStatus()`. The high-frequency playback-clock subscription is
  isolated into a new focused child component,
  `components/player/PlaybackProgressSnapshot`, which owns the
  `usePlaybackProgress()` read and keeps the orchestrator's trusted
  position/track-id snapshot refs in sync. As a result the orchestrator body no
  longer re-renders on every clock tick. Playback behavior is unchanged
  (verified by the existing orchestrator component suite plus a new render-count
  regression test).
- Frontend soundspan colors now have a centralized Tailwind v4 CSS-first
  `@theme` palette, with synchronized TypeScript tokens and contrast guards for
  accessible text and settings focus indicators.
- **Accessibility:** Raised low-contrast gray body text to the WCAG-AA gray-400
  floor, gave settings inputs a visible (>=3:1) brand focus ring, and added a
  ratchet guard against new hardcoded arbitrary-hex Tailwind classes.
- **Backend route-monolith decomposition (library, internal refactor).** The
  oversized `backend/src/routes/library.ts` (~8.3k lines) now delegates its
  service-shaped helper clusters to focused, individually testable modules under
  `backend/src/services/`: `libraryTrackPreferences.ts` (thumbs-up/down
  persistence, preference score maps, and response formatting),
  `libraryRadioBuilder.ts` (seeded multi-track radio building and artist-diversity
  selection), and `nativeCoverHealing.ts` (native album-cover path resolution and
  provider-chain cover healing). These are byte-for-byte pure moves — no route
  paths, methods, middleware, request/response shapes, status codes, or log
  messages change. A new characterization test
  (`backend/src/routes/__tests__/libraryRouteTable.test.ts`) snapshots the
  library router's path+method+middleware surface to guard the refactor, and the
  existing `apiEntrypointRuntime` mount-contract test continues to pass unchanged.
- **Frontend API client split into cohesive domain modules.** The 3,700-line
  single-class `frontend/lib/api.ts` monolith is decomposed into an abstract
  `ApiClientCore` (`frontend/lib/api/core.ts`, holding the token/URL/`request`
  plumbing) plus per-domain mixin modules under `frontend/lib/api/` (library,
  playlists, media, recommendations, plays, settings, connectors, auth,
  downloads, imports, discover, notifications, audiobooks, podcasts, soulseek,
  enrichment, metadata, vibe, ytmusic, youtube, tidal, listen-groups). `api.ts`
  is now a thin facade (~390 lines) that composes the mixins, re-exports the
  shared response types, and exports the `api` singleton, so every consumer
  keeps calling `api.<method>()` unchanged. No behavior, endpoint, or signature
  changes. A characterization test pins the public method surface. The
  `useJobStatus` hook's job-failure value is now typed at the boundary
  (`getScanStatus` returns `result` as `Record<string, unknown>` instead of the
  `any` alias) and narrowed to a string via a tested `resolveJobFailureMessage`
  helper before reaching `onError(string)`.
- **Backend error-response canonicalization (developer-facing standard + first
  exemplars).** The canonical route error contract is now documented in
  `backend/src/routes/README.md`: async handlers wrap in `asyncHandler`,
  deliberate client errors use `sendRouteError(res, status, message)`, and
  unexpected/internal failures are logged once and returned via
  `sendInternalRouteError` (or a thrown `AppError`) so every error body is the
  single-field `{ "error": string }` envelope (`AppError` additionally carries
  `code`/`category`). `routes/vibe.ts` and `routes/notifications.ts` are
  retrofitted as the reference exemplars, and `routes/vibeJourneyRequest.ts` now
  validates with `zod` instead of a bespoke helper pattern. Status codes and
  error messages are unchanged except for the two client-visible field removals
  noted below. A ratcheting CI check
  (`npm run check:error-canon`,
  `scripts/ci/check-route-error-canon.mjs`) freezes the current per-file count of
  ad-hoc `res.status(500).json(...)` literals and fails the build if any route
  file introduces new ones — canonicalize a route and lower its baseline; new
  route files start at a baseline of zero.
- **Minor API change (self-consumed vibe endpoints):** two error responses drop
  their secondary `message` field to conform to the `{ error }` envelope —
  `GET /api/vibe/similar/:trackId` (404 "No similar tracks found") and
  `POST /api/vibe/search` (504 "Text embedding service unavailable"). The
  `error` string and HTTP status are unchanged; the frontend reads only `error`,
  so no client action is required.

- Frontend playback context split for playback re-render hygiene: the single
  `AudioPlaybackContext` is now served as two contexts by the same
  `AudioPlaybackProvider` — a high-frequency progress context (`currentTime`,
  read via the new `usePlaybackProgress()` hook) and a low-frequency status
  context (`isPlaying`, `duration`, `streamProfile`, seek/buffer flags, and all
  setters, read via the new `usePlaybackStatus()` hook). Status-only consumers
  (the album/playlist/discover pages, `LibraryTracksList`, and the playback
  quality badge) were migrated to `usePlaybackStatus()` so they no longer
  re-render on every ~1 Hz clock tick during playback. `useAudioPlayback()` is
  retained unchanged as a deprecated composite (same shape, same referential
  stability, same out-of-provider error) for the remaining consumers; no
  playback behavior changed. Prefer the two granular hooks going forward.
- The artist page's Start Radio action now uses the in-app confirmation dialog
  before adding tracks to a Listen Together group's shared queue, instead of the
  native browser confirmation prompt.
- Discover settings now uses the in-app confirmation dialog when clearing the
  Discovery playlist instead of the native browser confirmation prompt.
- Removed seven unused frontend API client methods (`testNzbget`,
  `testQbittorrent`, `testListenNotes`, `testDeezer`, `trackPlayback`,
  `getPodcastEpisode`, and `getSlskdDownloads`) that targeted non-existent
  backend routes. The onboarding page now checks status through the shared API
  boundary (`api.getOnboardingStatus`) instead of calling `fetch` directly.
- Enrichment `GET /api/enrichment/status` now returns a complete zeroed
  `EnrichmentState` when idle instead of a partial object, and the frontend
  `enrichmentApi.getStatus` return type is now non-null.
- Media-source contract: the hand-copied `local`/`tidal`/`youtube`/`youtube-direct`
  source unions scattered across the frontend and backend now derive from
  `CanonicalMediaSource` in `@soundspan/media-metadata-contract` instead of being
  re-typed by hand. Two documented derived types were added —
  `RemoteMediaSource` (`Exclude<CanonicalMediaSource, "local">`, for stream-source
  hints) and `ResolvedMediaSource` (`Exclude<CanonicalMediaSource, "youtube-direct">`,
  for resolved/origin sources, since `youtube-direct` is a container variant of
  `youtube` and never an independent resolution target) — and every exported symbol
  in the contract package is now documented. No allowed string value changed and
  there is no runtime behavior change; this only removes drift risk between the
  copies. Consumers updated: `trackRef.ts`, `audio-state-context.tsx`,
  `listen-together-socket.ts`, `api.ts` (annotations only), `listenTogetherManager.ts`,
  `listenTogetherResolution.ts`, and `playlistImportService.ts`.
- Helm chart: the individual-mode audio-analyzer and CLAP-analyzer Deployments
  now have liveness/readiness probes (exec `pgrep`, mirroring the compose
  healthcheck), closing the compose/chart probe-parity gap. Both are
  configurable via `audioAnalyzer.livenessProbe`/`readinessProbe` and the CLAP
  equivalents (set to `null` to disable).
- Helm chart: `aio.gpu.enabled`, `audioAnalyzer.gpu.enabled`, and
  `audioAnalyzerClap.gpu.enabled` are now wired — previously no-ops. When
  enabled they add an `nvidia.com/gpu: <gpu.count>` resource limit (default 1)
  and an optional pod `runtimeClassName` (`gpu.runtimeClassName`) for clusters
  requiring a non-default GPU runtime. Requires the NVIDIA device plugin.
- Helm chart: the AIO default memory request/limit was raised from `1Gi`/`4Gi`
  to `2Gi`/`8Gi`. The AIO image bundles the backend, frontend, Postgres, Redis,
  and (by default) the Essentia + CLAP analyzers in one container, whose models
  alone peak well above the old 4Gi ceiling.
- Helm chart: the frontend pod now runs as UID/GID `1001` (the published image's
  `nextjs` user) via a `frontend.podSecurityContext` override merged over the
  chart-wide `1000`, fixing the UID/file-ownership mismatch until the image is
  realigned.
- Frontend (refactor slice P25, frontend-dedup): mechanical duplication
  collapse across the frontend, no user-visible behavior change.
  - YouTube Music account linking (`YouTubeMusicSection`) now uses the shared
    `useDeviceAuthPolling` hook instead of a third hand-rolled device-code
    polling/expiry/countdown state machine, matching the Tidal sections. This
    inherits the hook's bounded, race-safe polling, tracked timers with
    deterministic cleanup, and generation-guarded cancellation.
  - Extracted the duplicated device-code linking UI shared by the TIDAL and
    YouTube Music settings sections into one presentational component
    (`features/settings/components/ui/DeviceAuthLinkPanel`).
  - Extracted the copy-pasted Explore media card (square thumbnail + title +
    subtitle) into a shared `features/explore/components/BrowseCard`, adopted by
    the featured-shelves and mixes sections for both TIDAL and YouTube Music.
  - Consolidated nine local time/duration re-implementations onto
    `utils/formatTime`, adding a documented `formatRelativeTime` helper for the
    activity tabs (History, Notifications, Active Downloads).
  - Replaced index-based React keys with stable content-derived keys in
    `PreviewEpisodes` and `SyncedLyrics`.
- Backend: began consolidating scattered `process.env` reads behind the
  `backend/src/config.ts` boundary mandated by `AGENTS.md`. Added typed config
  sections (`jwtSecret`, `docsPublic`, `adminResetPassword`,
  `settingsDecryptFailClosed`, `ytmusicRegion`, `tidal`, `listenTogether`,
  `readiness`, `segmentedStreaming`, and an `audiobookshelf` getter) and migrated
  the streaming services (Tidal download/streaming sidecar URL and decrypt-fail-
  closed flag), the segmented-streaming session-token secret, the Audiobookshelf
  env fallback, and the API docs-public/admin-reset entrypoint gates to read from
  it. The segmented session token, `middleware/auth`, and these services now share
  the single `config.jwtSecret` derivation (`JWT_SECRET` else `SESSION_SECRET`)
  instead of re-deriving it independently. A new backend guard test enforces the
  boundary as a ratchet: only `config.ts`/`config/**` may read `process.env`
  (build-metadata `npm_package_version` excepted); every other reader must stay on
  an allowlist that can only shrink. No runtime behavior changed. Remaining
  subsystems (segmented-streaming, Listen Together socket, dependency-readiness,
  browse, and the `BACKEND_PROCESS_ROLE`/`worker.ts` split) remain on the
  allowlist and are tracked for follow-up migration.
- Backend: fixed a dead `config.audiobookshelf` block that read the unused
  `AUDIOBOOKSHELF_TOKEN` variable instead of the `AUDIOBOOKSHELF_API_KEY` the live
  Audiobookshelf service actually consumes; `AUDIOBOOKSHELF_TOKEN` (never read by
  any code path) is removed from the environment-variable reference.
- Digest-pinned all base images by `@sha256:` alongside their existing tags:
  the backend, frontend, tidal-downloader, ytmusic-streamer, and
  audio-analyzer-clap Dockerfiles plus the pgvector/redis images in
  `docker-compose.yml` and `docker-bake.json`. Dependabot's Docker ecosystem
  keeps the pins fresh.
- **BREAKING (frontend image runtime UID changed 1001 -> 1000):** the frontend
  production image now runs as the base Node image's built-in `node` user
  (UID/GID 1000), matching the chart's `runAsUser: 1000`. Existing `.next/cache`
  or other frontend volumes owned by UID 1001 must be re-chowned to 1000 (or
  recreated). See `docs/UPGRADING.md`.
- The backend `api-runtime` image now ships compiled JavaScript
  (`node dist/index.js`) with pruned production dependencies instead of the full
  development tree plus `tsx`; the entrypoint still runs
  `npx prisma migrate deploy` via a locally reinstalled Prisma CLI.
- Backend and frontend runtime artifacts now use `COPY --chown` instead of a
  duplicated recursive `chown -R /app` layer.
- Docs/contract sync (refactor slice): `AGENTS.md` now scopes the "no raw SQL"
  rule to the three query classes Prisma cannot express (pgvector similarity/ANN,
  PostgreSQL full-text search, and row/advisory locking) with a parameterized-only
  constraint, records that the Subsonic `/rest` surface is contract-documented in
  `docs/OPENSUBSONIC_COMPATIBILITY.md` instead of per-endpoint OpenAPI, documents
  the `logger.child` scope and file naming/placement conventions, deprecates the
  source-scraping `*Contract` test pattern, and indexes the `components/vibe`
  location as a recognized (owner-decision-pending) exception in
  `frontend/features/README.md`. The two trivially-expressible profile-picture
  presence checks in `routes/settings.ts` (`$queryRaw COUNT(*)` → `prisma.user.count`)
  and `routes/social.ts` (two `$queryRaw SELECT id` → `prisma.user.findMany`) were
  migrated to Prisma with no behavior change (the profile-picture blob is still not
  loaded).
- Backend: introduced a single consolidated, typed Lidarr HTTP client
  (`backend/src/services/lidarr/lidarrHttpClient.ts`) as the standard boundary
  for outbound Lidarr calls. It wraps one reusable axios instance with bounded
  reliability the previous scattered call-sites lacked: a consistent request
  timeout, capped exponential-backoff retries (idempotent methods and classified
  transient failures only — 408/425/429/5xx/network/timeout; `POST` is not
  retried unless explicitly opted in; `Retry-After` is honored and capped), a
  concurrency limiter, a typed `LidarrHttpError` (status/method/path/attempts/
  isTransient) that never leaks the API key or host, connection resolution from
  system settings with `.env` fallback and URL validation, and the shared
  logger. The discovery album-lifecycle deletion path now routes through this
  client; remaining Lidarr consumers (the `lidarr.ts` queue/history helper
  functions, `downloadQueue`, `simpleDownloadManager`, `discoverWeekly`, and the
  discover/system-settings/onboarding routes) will be migrated onto it
  incrementally to keep each change no-regression.
- AIO analyzer tuning from `aio.env` is now passed through to the MusicCNN and
  CLAP runtimes instead of being dropped or overwritten by supervisord defaults.
- AIO image build/startup hygiene: apt update/install steps are consolidated,
  and the redundant frontend `sleep 10` startup delay is removed.
- Removed the non-functional `HF_TOKEN` BuildKit secret path from the AIO and
  CLAP image builds; the public model download remains SHA-256 verified.
- Backend: moved six `@types/*` packages from production dependencies to
  devDependencies and removed `@types/speakeasy`, slimming the pruned worker
  image's production `node_modules`.
- Frontend: removed the deprecated `@types/dompurify` stub; `dompurify` 3.x and
  later ship their own type definitions.
- Backend: the 13 curated daily "vibe" mixes (Sad Girl Sundays, Main Character
  Energy, Villain Era, 3AM Thoughts, Hot Girl Walk, Rage Cleaning, Golden Hour,
  Shower Karaoke, In My Feelings, Midnight Drive, Romanticize Your Life, That
  Girl Era, Unhinged) are now data-driven: their filters, names, descriptions,
  colors, pool sizes, and weekday gates live in a single declarative catalog
  (`backend/src/services/curatedVibeMixDefinitions.ts`) consumed by one shared
  generator, replacing ~13 near-identical hardcoded methods (net −433 lines in
  `programmaticPlaylists.ts`). Behavior, mix ids/types, and the public
  `generate*` method surface are unchanged; artist-diversity selection is
  preserved.
- Audio analyzer batch-timeout retry semantics (analyzer reliability slice):
  when an analysis batch hits `BATCH_ANALYSIS_TIMEOUT_SECONDS`, tracks that
  never started running are now re-queued as `pending` WITHOUT consuming any
  retry budget, and tracks that were genuinely in flight fail non-permanently
  (consuming exactly one retry unit, retried up to `MAX_RETRIES`). Previously
  every unfinished track in a timed-out batch was failed permanently — a single
  slow batch could silently and irreversibly shrink the analyzed library.
  Results that completed just as the timeout fired are now drained and saved
  instead of being dropped.

### Fixed

- The release-notes generator now supports the Accessibility changelog section.
- The all-in-one image builds again by copying the Prisma config's database-URL
  helper into every stage that runs the Prisma CLI, with a static CI guard
  covering both backend Dockerfiles.
- Compose deployments now construct `DATABASE_URL` from `POSTGRES_*`
  components in-app with percent-encoded credentials, so passwords containing
  URL-reserved characters work; explicit `DATABASE_URL` still wins.
- Queue auto-advance no longer pauses itself right after the next track starts:
  the ready-state transition no longer erases the advance's play intent, the
  deferred-play path re-asserts it explicitly, and load/play-intent decisions
  are now visible in server telemetry.
- Queue auto-advance now recovers when the browser blocks the next track's
  playback start in a background or unfocused window, using bounded automatic
  retries plus a retry on window focus, with blocked and recovery-attempt states
  visible in server telemetry.
- Admin “Test connection” failures for Audiobookshelf, Fanart.tv, Last.fm,
  Soulseek, Spotify, and TIDAL no longer log the user out: upstream credential
  failures now return 502 instead of 401, and the web client only treats
  explicitly marked authentication responses as session expiry.
- Queue auto-advance no longer stalls at track boundaries: engine listeners
  remain attached across playback state changes so end events cannot be dropped,
  a one-shot watchdog advances tracks if an end event is ever lost, and
  end-handling telemetry is now visible server-side.
- Cover art (browse thumbnails, native library covers, podcast/audiobook covers)
  and segmented-streaming files no longer return 404 when the configured cache
  path contains a dot-segment directory such as `/music/.soundspan`.
- Fixed the native audio engine treating the browser's spec-mandated
  end-of-stream pause as unexpected, which intermittently froze queue
  auto-advance at track boundaries, especially in hidden tabs; the Howler path
  is unaffected.
- Podcast cover-art fetches are size-bounded to prevent resource exhaustion
  (#369).
- Playlist reorder rejects duplicate-amplified database transactions (#366).
- OAuth logout is fenced against an in-flight lazy credential restore for TIDAL
  and YouTube Music (#371).
- Published OpenAPI marks anonymous operations and documents the login response
  shapes (#370).
- Soulseek UI search has bounded admission, rate limits, and session/result caps
  (#376).

- Podcast feeds and enclosures are size-bounded to prevent authenticated
  resource exhaustion (#352).
- YouTube Music metadata extraction is bounded by an overall deadline and a
  socket timeout so stalled extractions cannot retain worker threads (#355).
- Expired TIDAL stream manifests are evicted from a bounded LRU cache instead of
  accumulating indefinitely (#354).
- Audiobook cover-art fetch failures now cancel the upstream response body,
  preventing connection-pool exhaustion (#357).
- Helm: the AIO deployment consumes chart-managed internal and PostgreSQL
  secrets, analyzer deployments omit unused PostgreSQL keys under an external
  DATABASE_URL, and application images support opt-in digest pinning (#358).
- Build tooling (contract TypeScript, analyzer pip) is pinned instead of
  resolved live at build time (#359).
- Generic import jobs run durably on the worker queue with startup recovery and
  deduplication instead of an API-local timer (#361).
- The queue-cleaner maintenance loop no longer runs inside API replicas; it is
  dispatched as a claimed worker job (#363).
- Published OpenAPI playlist and play schemas document the supported
  remote-media (TIDAL, YouTube, mixed-source itemIds) request contracts (#360).

- Helm: the AIO entrypoint Service now selects only its own component's pods,
  so enabling a streaming sidecar no longer routes app/ingress traffic to the
  internal sidecar port; the chart render check asserts Service selector
  isolation across components. (#348)
- CI now actually runs the Dockerfile digest-pin/hygiene suite and the AIO
  image-hardening pytest suite, which previously existed but were never
  invoked. (#349)
- Audio engines can now re-synthesize a missed end-of-track on tab refocus,
  and Howler's preloaded-track promotion no longer depends on
  background-throttled timers. (#338)
- Listen Together hosts no longer snap back to the start when their own
  ready-gate `play-at` broadcast arrives, cross-resolved queue items preserve
  mid-track position, and event-driven ready reports let backgrounded hosts
  pass the gate promptly. (#340)
- Listen Together ready-gate votes now survive cross-replica snapshot
  rehydration (track changes start when everyone is buffered instead of always
  waiting out the 8s timeout), and the server clamps virtual position to track
  duration with a boundary watchdog so a stalled host can no longer silently
  diverge from guests. (#341)
- Persisted playback snapshots now window the queue around the current position
  instead of truncating to the first 100 items, so restored sessions with large
  queues resume at the real track and keep auto-advancing. (#342)
- Access tokens now refresh proactively before expiry (with a refocus
  catch-up), so long listening sessions no longer bake expired credentials into
  stream URLs and stall at the next track load. (#343)
- The playback error breaker now half-opens after a 60s cooldown, probing one
  advance instead of halting playback permanently until reload. (#344)
- Listen Together followers now estimate client-server clock offset and
  skew-correct their synchronized start positions, so a fast client clock no
  longer clips track intros. (#345)
- Playback no longer permanently stops at track boundaries in background tabs:
  autoplay rejection is no longer treated as a fatal track error, refocusing
  completes a missed advance, and the consecutive-error breaker self-heals on
  return.
- Soulseek: public disconnect() now destroys the client and removes its error listener before dropping the reference, closing a socket/listener leak on reconnect cycles (sibling of #331).
- Promoted the backend LIKE-pattern escaper to the shared
  `backend/src/utils/likePattern.ts` utility and applied it to the multi-seed
  radio builder's genre-expansion fallback, where user-editable `%` and `_`
  characters previously acted as wildcards and could flood the radio queue; all
  genre LIKE sites now use an explicit `ESCAPE '\'` clause.
- Dedicated Redis BLPOP connection is now closed when its initial connect fails,
  instead of leaking a reconnecting client.
- Worker health-check interval is now captured, unref'd, and cleared during
  graceful shutdown.
- Bounded every `/api/library/radio` candidate-pool query (discovery, favorites
  fallback, decade, mood, workout, vibe genre/random fallbacks, and the
  all-library default) with `ORDER BY random() LIMIT` sampling in SQL instead of
  materializing the full matching track-id set into memory, and escaped `%`/`_`
  LIKE wildcards in the genre-radio value so a wildcard query value can no
  longer match the entire library.
- Soulseek forced disconnects now destroy the underlying slsk-client, closing
  its server, listen, and peer sockets, and remove the attached error listener
  before dropping the reference. Previously each search-failure or empty-search
  reconnect cycle orphaned open sockets and EventEmitter listeners in the
  long-running backend.
- Audiobook cover proxy routes now cancel non-success upstream response bodies
  so undici can promptly return their sockets to the connection pool.
- Clamp `GET /api/enrichment/failures` `limit`/`offset` through the shared bounded-int parser so oversized or non-numeric values can no longer trigger whole-table loads or Prisma 500s.
- Podcast background downloads now abort after 2 minutes of stream inactivity,
  preventing leaked file handles/sockets and permanently stuck "already
  downloading" episodes when a host stalls mid-transfer.
- Offloaded the public YouTube Music album, artist, and song browse calls from
  the ytmusic-streamer event loop and bounded them with a
  `YTMUSIC_BROWSE_TIMEOUT` deadline (default: 30 seconds), so a slow or hung
  upstream no longer freezes the sidecar and its health endpoint.
- Bounded the missing-track health-record writes in the scanner and file
  validator so an unavailable music mount no longer fans out one concurrent
  upsert per track and exhausts the worker database pool (hardens the #319
  scan-reconciliation path).

- `GET /api/library/tracks/:id/stream` no longer leaks an
  `AudioStreamingService` eviction timer when streaming fails, and the FFmpeg
  fallback reuses a single service instance.
- `/api/library/recently-listened`, `/api/homepage/genres`, and
  `/api/homepage/top-podcasts` now clamp their `limit` query parameter (invalid
  input falls back to the default), preventing NaN 500s, unbounded database
  reads, and unbounded Redis cache-key cardinality.
- Vibe text search now runs its blocking Redis response wait on a dedicated
  connection, so a slow CLAP sidecar cannot stall the shared Redis client used
  by sessions and caches.
- The CLAP analyzer's PostgreSQL connections now run in autocommit mode, so
  pgvector type registration, liveness checks, and idle-queue polls no longer
  leave sessions `idle in transaction` holding relation locks — previously such
  sessions could block schema migrations needing an `AccessExclusiveLock` on
  `Track`, queueing all later queries behind the migration and exhausting the
  backend connection pools during upgrades. (#224)
- Library scans now reconcile the database with disk: whether or not the
  admin "Allow library deletion" checkbox is enabled, a scanned track that is
  missing from disk is removed from the database, counted in the scan's
  removed total, and orphaned albums and artists are cleaned up. That checkbox
  only prevents deletion of tracks-on-disk via the UI. As a safeguard, a scan
  that finds zero audio files while the database still has tracks (for
  example an unmounted music volume) skips removal and keeps the flag-only
  Library Health behavior
  ([#309](https://github.com/BonzTM/soundspan/issues/309)).
- The ytmusic-streamer playlist endpoint's public-browse and auth-fallback
  paths, and the debug search endpoint, now offload blocking ytmusicapi calls
  to the asyncio thread pool instead of stalling the event loop, and batch
  search now rejects requests with more than 50 queries.
- Clamp `limit` query params on plays, downloads, and listening-state list
  endpoints via the shared bounded-int parser (previously unbounded;
  non-numeric values caused 500s).
- Audiobook cover downloads now cancel non-success response bodies, podcast
  iTunes subscription lookups now use the shared 10-second timeout, and the
  optional Lidarr service image is pinned to a release digest.
- Outbound image fetches (external image proxy and podcast cover cache) now
  cancel undici response bodies on non-success, redirect, and retry paths so
  pooled connections are released promptly instead of waiting for GC.
- TIDAL logout is now authoritative against an in-flight token refresh:
  `/user/auth/clear` serializes with the per-user refresh lock and a refresh
  aborts its re-insert if the session was cleared during its awaited calls, so
  `/user/auth/status` can no longer report authenticated after an explicit logout.
- The discovery generation logger now closes any previously open log stream
  when a new generation starts, fixing a latent file-descriptor leak.
- Subsonic getPlaylists (and the root directory/starred count paths) no longer
  hydrate every playlist item/track/album row (or album-id/track-duration rows)
  just to compute songCount/duration/coverArt — they now use bounded Prisma
  aggregates; response shapes unchanged.
- YT Music sidecar: the stream-URL and search caches (plus the per-user and public YTMusic client maps) are now guarded by locks — concurrent playback/search could previously hit "dictionary changed size during iteration" on the lock-free caches shared across worker threads, surfacing as intermittent 500s on stream extraction and search.
- TIDAL stream proxying now handles upstream stream errors after headers are
  sent instead of crashing the entire backend via an uncaught exception; a
  mid-playback sidecar disconnect now ends only that response.
- TIDAL sidecar: album downloads and browse endpoints no longer block the event
  loop — album metadata/pagination and browse-session creation now run in worker
  threads, keeping streaming, search, and health responsive during large operations.
- Podcast cover downloads now time out after 15 seconds so an unresponsive
  image host can no longer stall the cover-sync loops.
- Fixed the tidal-downloader stream-URL cache race where concurrent mutation
  during invalidation iteration could raise `RuntimeError` and abort
  stream/refresh requests.
- Playlists list endpoint no longer hydrates every track of every visible playlist: it now paginates (limit/offset, clamped) and returns a database-side track count plus a bounded cover-art preview per playlist.
- Remote media proxy streams for Tidal, YouTube, YouTube Music, and artist
  previews now destroy the upstream connection when the client disconnects,
  preventing connection-pool exhaustion during seek and skip operations.
- **Sidecar event-loop offload for OAuth onboarding and search.** The
  `tidal-downloader` (`/auth/device`, `/auth/token`, `/auth/refresh`, `/search`)
  and `ytmusic-streamer` (`/auth/device-code`, `/auth/device-code/poll`) async
  handlers called blocking third-party `tiddl`/`ytmusicapi` methods directly on
  the event loop. During device-code onboarding the poll endpoint runs every few
  seconds, so a blocking call there serialized concurrent onboarding and
  streaming across all users. Each blocking call is now wrapped in
  `asyncio.to_thread`, matching the existing offload pattern already used for the
  per-user refresh path.
- **Sidecar event-loop offload for per-user session restore.** The
  `tidal-downloader` `/user/auth/restore` handler and its `/auth/session`
  verification path called the blocking `tiddl` `get_session()` (and, on the
  expired-token branch, `AuthAPI().refresh_token()`) directly on the event loop,
  stalling all concurrent onboarding and streaming while a single user's
  credentials were restored. These calls are now wrapped in `asyncio.to_thread`,
  completing the Phase-D offload coverage for the sidecar's auth surface.
- Aligned the mypy type-check target (`python_version`) to Python 3.11 to match
  the repo floor (Ruff `py311` and the audio-analyzer `python:3.11-slim` pin), so
  type checks run against the oldest interpreter the sidecars use.
- Frontend Helm pod no longer runs as the stale UID 1001; the chart frontend
  override was removed so the pod inherits the chart-wide UID/GID 1000 pod
  security context, matching the realigned frontend image (`USER node`) and
  fixing `.next/cache` write failures in individual deployment mode.
- Fixed the tidal-downloader cross-thread race where browse-session builds on
  worker threads could mutate `_browse_sessions` during event-loop invalidation
  iteration, aborting session refresh, restore, or logout with `RuntimeError`;
  browse-session caches and per-user auth state are now lock-guarded like the
  stream-URL cache.

- Lidarr queue/history helper HTTP calls are now bounded. The module-level
  `cleanStuckDownloads`, `getRecentCompletedDownloads`, `getQueueCount`,
  `getQueue`, and `isDownloadActive` helpers in `backend/src/services/lidarr.ts`
  previously issued bare `axios` requests with no `timeout`, inheriting axios's
  unbounded default (`0`). Because `QueueCleaner.runCleanup` only reschedules its
  30s reconcile/clean loop after its awaits resolve, a single hung Lidarr call
  could stall the loop indefinitely. Each call now carries an explicit
  `timeout: 30000`, matching the class client on the same module.
- AIO image builds no longer fail while removing the base image's `node` user:
  `userdel` and `groupdel` are now conditional, and existing uid/gid 1000
  holders are renamed and reused instead of failing `groupadd` or `useradd`.
- OpenAPI contract sync: the generated spec (`GET /api/docs.json`, `/api/docs`)
  no longer advertises 24 phantom endpoints. The `@openapi` path keys for the
  API-key, auth (`login`/`me`), library-scan, listen-together, lyrics, mixes,
  and search routes were documented without the mounted `/api` prefix, so the
  spec published paths such as `/auth/login` and `/mixes` that 404 on the server
  while the real `/api/...` URLs went undocumented. The keys now match the
  mounted routes. `openapiSupplement.ts` — previously a shim that re-documented
  those same endpoints under their correct prefixes — is reduced to the only
  endpoints defined directly in `index.ts` with no route module (the
  `/health`, `/api/health` liveness/readiness probes and `/api/docs.json`).
  Documentation only; no runtime route behavior changed.
- OpenAPI `info.version` is no longer frozen at `1.0.0`; it now resolves from
  `backend/package.json` at load time (currently `1.9.0`) so the published
  contract tracks the shipping release.
- MetadataEditor's "Reset to Original" action now uses the in-app
  `ConfirmDialog` instead of the browser's native confirmation prompt.
- Frontend token refresh is now single-flight, so simultaneous 401 responses
  share one `/auth/refresh` request instead of racing refresh-token rotation
  and forcing a logout.
- Audio-state polling now detects expired sessions from HTTP 401 status without
  permanently stopping after a transient failure, and audiobook/podcast
  restore failures are logged instead of surfacing as unhandled rejections.
- Backend reliability hardening (no behavior change for healthy paths):
  - Remote-track backfill (`remoteTrackBackfillService`) no longer spins
    forever when an album title cannot be resolved. The previous re-query
    pagination re-fetched the same `albumId: null` rows on every iteration
    (latching `isRunning` and inflating the processed counter without bound);
    both the Tidal and YouTube Music phases now use id-cursor pagination so
    each row is visited at most once, backed by a fixed `MAX_BACKFILL_ITERATIONS`
    safety bound.
  - An invalid/typo'd `LOG_LEVEL` (e.g. `verbose`) no longer silently disables
    **all** logging. Unrecognized values now fall back to the environment
    default (`warn` in production, `debug` otherwise) and emit a one-time
    startup warning; explicit `LOG_LEVEL=silent` still silences output. Level
    matching is also hardened against prototype keys (`constructor`, `toString`).
  - The music-library scanner's recursive directory walk was replaced with a
    bounded iterative traversal: it caps depth at `MAX_SCAN_DEPTH` (64) and
    skips symbolic links, preventing stack overflows and symlink-cycle hangs on
    pathological trees.
  - Added request timeouts (`AbortSignal.timeout(15000)`) to the previously
    unbounded Audiobookshelf cover fetches in `audiobookCache`, the library
    cover-art proxy, and the audiobooks cover proxy, so a stalled upstream can
    no longer hang a worker or request indefinitely.
  - Untracked module-scope cleanup intervals (Soulseek search-session and
    failed-user pruning) are now `unref()`'d so they never keep the process or a
    Jest worker alive, and the worker scheduler / discover-processor ioredis
    lock clients now connect lazily under Jest to stop background reconnect
    loops from logging after test teardown.
- Removed dead backend code: the test-only `utils/discoverLogger.ts` logger
  monkey-patch and the unreferenced `workers/cleanupDiscovery.ts` and
  `workers/dataIntegrityCli.ts` CLIs (the data-integrity check runs on the
  worker scheduler; discovery cleanup runs via `staleJobCleanup`).
- Python sidecar (tidal-downloader, ytmusic-streamer) HTTP error responses now
  use the backend-wide `{"error": ...}` body shape instead of FastAPI's default
  `{"detail": ...}`; unhandled sidecar exceptions return a generic 500 without
  leaking internals, and nested error payloads (e.g. `age_restricted`) keep
  their existing fields. The Node backend only branches on status codes, so no
  backend change was needed.
- ytmusic-streamer stream proxying no longer leaks an httpx connection when the
  upstream Range request fails before streaming starts, and the `/yt/proxy`
  route no longer forwards upstream `Content-Length` (which crashed the ASGI
  app with an h11 protocol error whenever the CDN dropped a stream mid-read);
  both proxy routes now share one hardened range/full-proxy helper.
- tidal-downloader album-track pagination can no longer loop forever when the
  TIDAL API echoes a zero/missing page `limit`; the loop advances by the real
  page length under a fixed hard cap.
- ytmusic-streamer rate pacing is now genuinely thread-safe (a shared
  monotonic-clock pacer replaces a never-acquired asyncio.Lock and racy global
  timestamp), the in-memory stream/search caches are bounded
  (`YTMUSIC_STREAM_CACHE_MAX` / `YTMUSIC_SEARCH_CACHE_MAX`, default 1024, oldest
  evicted), and the two near-duplicate yt-dlp extraction paths were merged into
  one shared core.
- ytmusic-streamer route handlers no longer run blocking ytmusicapi network
  calls on the asyncio event loop (a slow YouTube call stalled every concurrent
  request); search, album/artist/song, library, charts, moods, home, browse,
  and playlist handlers now offload to worker threads.
- ytmusic-streamer stream-URL extraction now has an overall per-request
  deadline (`YTMUSIC_EXTRACT_TIMEOUT`, default 60s, HTTP 504 on expiry) and a
  configurable yt-dlp socket timeout (`YTMUSIC_YTDLP_SOCKET_TIMEOUT`, default
  20s) covering extraction and downloads, so a stalled extraction can no longer
  hang a request or strand its worker thread forever.
- The `audio-analyzer` sidecar now measures its own elapsed durations and
  scheduling intervals (idle-model-unload timeout, worker-resize debounce, DB
  reconciliation cadence, batch-rate logging) with `time.monotonic()` instead
  of wall-clock `time.time()`, so an NTP step or manual clock change can no
  longer prematurely unload models, mis-fire a resize, or corrupt the reported
  throughput. The cross-process `audio:worker:heartbeat` timestamp remains
  wall-clock epoch milliseconds by design.
- `scripts/k8s-rollout-slo-check.sh` sampled SLO warning logs from only one pod
  per Deployment (`kubectl logs deploy/...`), so reconnect/scheduler SLO
  breaches emitted by other replicas in an HA deployment were missed and the
  gate could pass when it should fail. It now aggregates `--since` logs across
  every backend and backend-worker pod (by `app.kubernetes.io/component` label,
  with a name-prefix fallback).
- The three backend audio-analyzer source-contract suites
  (`audioAnalyzerQueueContract`, `audioAnalyzerPoolRecoveryContract`,
  `audioAnalyzerFailureResolutionContract`) were updated in step with the
  analyzer reliability refactor: the marker strings they scrape from
  `analyzer.py` moved into the new `_claim_tracks_for_processing` /
  `_consume_batch_results` helpers and the module-level
  `_RESOLVE_AUDIO_FAILURES_SQL` constant, so the tests now assert against
  those boundaries (and additionally prove `_save_results` executes the
  failure-resolution SQL).
- Audio analyzer sidecar no longer runs a PostgreSQL worker-count query at
  module import. Because the service uses multiprocessing spawn mode, every
  spawned worker process re-imported the module and re-executed that query;
  worker-count resolution now happens once, explicitly, at service startup in
  the parent process.
- CLAP sidecar idle monitor no longer leaks a new Redis connection pool on
  every idle-check iteration; it now reuses a single injected client that is
  deterministically closed on shutdown (as is the idle DB connection, which
  previously stayed open if the main loop exited via an exception).
- CLAP sidecar worker/text-embed/control daemon threads are now supervised:
  if any thread dies, the service logs a critical error, stops cleanly, and
  exits non-zero so the container orchestrator restarts it instead of leaving
  a zombie pod that consumes no work.
- CLAP model unload/inference race fixed: idle unloading and embedding
  inference now serialize on one re-entrant lock, and embedding calls reload
  the model under that lock if an idle unload wins the race — previously the
  race raised mid-call, spuriously failing the track and burning its vibe
  retry budget.
- Python sidecars no longer use deprecated `datetime.utcnow()`; analyzer
  timestamps are timezone-aware UTC (`datetime.now(timezone.utc)`).
- Backend Jest suites no longer leave Redis's live reconnect loop running in
  test workers: `utils/redis.ts` skips its eager module-load connection under
  Jest, preventing `Cannot log after tests are done` noise and flakiness, while
  tests continue to cover the production eager-connect behavior.
- Backend Jest's default `maxWorkers` is now 2 instead of 8, matching the
  documented low-memory constraint and the existing explicit CI limit.
- Sidecar requirement-lock tests now assert that the Uvicorn manifest floor is
  at least the 0.52.0 security baseline instead of requiring that stale exact
  literal, so Dependabot floor increases such as 0.52.1 remain valid.
- Two orphaned frontend player tests now live under `frontend/tests/unit`, so
  `test:unit` and `test:coverage` discover them; the frontend unit suite now
  runs 845 tests.
- Frontend test-script globs are now quoted so Node's test runner consistently
  expands them instead of relying on partial shell expansion.
- `playwright.config.ts` no longer duplicates its environment fallback
  expressions.
- The predeploy logout E2E test now follows the deterministic User-menu path
  instead of conditionally discovering a logout element.
- `scripts/ci/backend-coverage-summary.mjs` now exits non-zero when
  `ENFORCE_COVERAGE_GATE=true` and the coverage summary is missing, closing the
  previous fail-open path.
- Frontend polling hygiene: album/track preview playback no longer resumes the
  main player over an active preview (a cleanup effect fired on every state
  change, also destroying cached preview audio elements), and both preview
  hooks now share one behavior — when a preview ends, errors, or unmounts, the
  main player resumes only if the preview paused it.
- TIDAL device-code authentication (both settings sections) now runs through a
  shared `useDeviceAuthPolling` hook: re-clicking authenticate no longer leaks
  the previous poll interval, the expiry timer is tracked and cleared on
  success/cancel/unmount, and code expiry surfaces its error message instead
  of being hidden by a stale-state closure.
- Download status polling no longer forks a permanent extra poll chain each
  time a `download-status-changed` event fires; all scheduling now flows
  through a single tracked timer. `addPendingDownload` no longer performs side
  effects inside its React state updater (StrictMode-safe).
- Raw `setInterval` pollers (feature flags, presence heartbeat, active listen
  sessions, job status, listen-together lobby discovery, device-link status)
  now pause while the tab is hidden and refresh once on return to visibility
  via a shared `useVisibilityGatedInterval` hook. The features provider also
  no longer double-fetches on tab return (duplicate `focus` +
  `visibilitychange` listeners). Presence heartbeats stop while a tab is
  hidden, so backgrounded tabs no longer report the user as actively present.
- Dev tooling: repaired the broken local compose files — `docker-compose.local.yml`'s
  `audio-analysis` profile pointed its analyzers' `depends_on` and connection URLs
  at nonexistent `postgres`/`redis` services (the services are
  `postgres-local`/`redis-local`), and the `docker-compose.dev.yml` compatibility
  shim's `extends` targets referenced the same stale names, so
  `docker compose config` failed for both. `scripts/dev-setup.sh` now runs under
  `set -euo pipefail`, resolves the repo root from its own location, checks for
  `nc` and `.env.example` before using them, and references the correct
  `postgres-local`/`redis-local` service names.
- TIDAL admin credentials no longer travel in sidecar URL query strings: the backend now sends the access token as `Authorization: Bearer <token>` and the user ID/country code as `x-tidal-user-id`/`x-tidal-country-code` headers for `POST /search`, `/download/track`, and `/download/album`. The TIDAL sidecar accepts both the new headers and legacy query parameters for this release, logging a deprecation warning when query credentials are used; query-parameter support will be removed in the next release. Requests without an access token now return **401** with `access_token required`.
- The TIDAL and YouTube Music FastAPI sidecars no longer expose internal exception text in HTTP responses. Client-facing errors now use short generic messages while full exception details and tracebacks remain in service logs; this also changes TIDAL album downloads' per-track `errors[].error` value to `Download failed`, with the root cause available in the TIDAL sidecar logs.
- YouTube Music OAuth credential files (`/data/oauth_<user>.json` and `/data/client_creds_<user>.json`) are now written with owner-only mode `0600`; the next write also tightens permissions on pre-existing files with looser modes.
- The YouTube Music streamer image no longer makes `/data` world-writable with `chmod 777`. A new entrypoint repairs `/data` ownership and drops from root to the `ytmusic` user for plain Docker/Compose starts, while explicitly non-root deployments continue directly under their configured user and rely on existing volume permissions such as the Helm chart's unchanged `runAsUser: 1000`/`fsGroup: 1000` security context.
- YouTube Music streamer requests now strictly validate 11-character `video_id` path parameters and reject malformed values with **400** `Invalid video_id`; `/song`, `/stream`, `/proxy`, and `/yt/proxy` also accept only case-insensitive `LOW`, `MEDIUM`, `HIGH`, or `LOSSLESS` quality values and reject others with **400** `Invalid quality`. Lowercase quality values sent by the backend are now honored instead of silently falling back to `HIGH`.

### Security

- Playlist import links now require canonical HTTP(S) URLs, and audiobook
  preflight responses now use the central deny-by-default CORS policy.
- Account-management, 2FA, Subsonic-credential, admin queue-dashboard, and
  playback-state sync routes now have route-level rate limiting; playback-state
  uses a generous dedicated tier for its high-frequency cadence, and invite
  codes use unbiased cryptographic random character selection.
- Hardened external-metadata escaping for Deezer and Spotify; Soulseek and
  Lidarr delimited-content stripping now uses a single-pass linear scanner
  instead of regex rescans, while search normalization uses linear regex forms.
- Cover-image storage operations validate IDs and contain all filesystem paths
  under the type-specific covers directory.
- Account-management, 2FA, and Subsonic-credential routes now have dedicated
  route-level rate limiting, and invite codes use unbiased cryptographic random
  character selection.
- Playlist pending-track operations are scoped to both the playlist and
  pending-track ids, closing a cross-user IDOR (#366).
- API-key management and MFA setup/enable/disable now require an interactive
  session (X-API-Key callers are rejected), and API keys expire after 90 days.
  **BREAKING:** API keys older than 90 days must be re-issued (#370).
- The global enrichment-failure API is admin-only and returns a redacted
  response without raw errors or filesystem paths (#368).
- Library deletion validates every persisted track path for MUSIC_PATH
  containment before removal (#365).
- TIDAL/Soulseek download destinations are validated to stay within MUSIC_PATH
  (#367).
- The split-stack Compose deployment requires an explicit PostgreSQL password.
  **BREAKING:** startup fails on the published default (#372).
- Backend transcoding no longer selects the bundled obsolete FFmpeg build
  (CVE-2021-30123); a patched system binary is used and a minimum version is
  enforced (#374).
- Helm PostgreSQL credentials are URL-encoded in DATABASE_URL and passed to SQL
  as safely quoted parameters (#375).
- .env writes fail closed on non-ENOENT read errors and honor explicit secret
  clears instead of leaving stale credentials on disk (#373).

- Shared-library download routes (create, release lookup, grab, keep-track) now
  require admin, and keep-track is scoped to the owning DiscoveryAlbum, closing
  an authorization gap and a cross-user IDOR (#351).
- The Spotify import session-log endpoint is admin-only and no longer returns
  server filesystem paths (#353).
- Podcast episode cache paths are containment-checked and ownership-verified
  before any filesystem access, closing a path-traversal arbitrary-file delete
  (#352).
- TIDAL download output-template paths are validated to stay within MUSIC_PATH
  (#354).
- Encryption and internal-auth secrets now require a 32-character minimum,
  validated fail-closed at startup. **BREAKING:** deployments configured with
  weak secrets must strengthen them before upgrading (#356).
- Resolved pre-existing code-scanning alerts: log format-string handling,
  MusicBrainz identifier path validation, and session-cookie CSRF hardening
  (#362).

- Subsonic JSONP callback parameters are now validated against a strict
  JavaScript identifier pattern, with a nosniff plain-JSON fallback for missing
  or invalid callbacks.
- Soulseek and single-file-organizer session-log entries no longer include raw
  library error text or absolute server paths (details stay in server logs),
  and the raw-error leak ratchet now also scans backend workers, jobs, and
  middleware with frozen baselines. (#347)
- Retry endpoints for Soulseek-backed downloads (playlist pending-track retry
  and download-job retry) are now admin-only, closing the authorization bypass
  around the #216 direct-download admin boundary.
- YouTube Music browse home, mood-playlists, and mixes 4xx responses no longer
  echo raw sidecar error details to clients; they return static messages while
  retaining status and detail in server logs. The route-error leak ratchet now
  also detects ternary-consequent leaks, plural `.details`, and identifiers
  ending in `Err`.
- Operator-supplied `JWT_SECRET` values must now contain at least 32 characters;
  deployments that omit it continue to use the validated `SESSION_SECRET`.
- `.env` settings sync now rejects any value containing a line break, closing
  an env-line injection where an app admin could append arbitrary environment
  variables to the deployment `.env`; Lidarr and Audiobookshelf URL settings
  are now validated as URLs at the API boundary.
- Enforced media-root containment through the shared `safeResolvePath` helper
  for segmented-streaming session creation, self-heal, and playback repair;
  library audio-info probes; file-validator checks; and artist/discovery
  deletion fallbacks. Traversal or absolute database paths now use each flow's
  existing 404 or skip behavior instead of reaching the filesystem or ffmpeg.
- Share-link single-track streaming now confines resolved media paths to the
  configured music directory, matching the ZIP download branch's traversal
  defense.
- With `SECRETS_DB_ONLY=true`, decrypted integration API keys are no longer written to the on-disk `.env` file by the settings sync, reducing plaintext secret exposure on the host filesystem. The flag is off by default; enabling it requires the database to be initialized and readable before backend/worker services start.
- Audiobook cover sync/download now routes Audiobookshelf cover paths through
  the shared cover-path allowlist, so a traversal-bearing item id can no longer
  pivot the admin-token fetch onto arbitrary ABS API paths.

- POST `/api/podcasts/subscribe` now validates `feedUrl`/`itunesId` with a Zod
  schema before any outbound fetch; a previously accepted malformed `feedUrl`
  or non-string `itunesId` now returns **400** instead of reaching the RSS fetch
  path.
- Added connect-time IP re-validation to the outbound SSRF guard, closing the
  DNS-rebinding time-of-check/time-of-use window for vetted outbound requests;
  the shared outbound policy now also blocks RFC 6598 CGNAT/shared address space
  (`100.64.0.0/10`) and RFC 2544 benchmarking space (`198.18.0.0/15`).
- Confined the Audiobookshelf cover-art proxy to the ABS `items/` resource
  namespace, closing an authenticated SSRF and admin-credential-reuse class.
  The library `cover-art` handler (both the `?url=` and `:id` branches) and the
  audiobooks `:id/cover` fallback concatenated a caller/DB-supplied path segment
  raw into `${audiobookshelfBaseUrl}/api/<path>` and fetched it with the stored
  admin API key; a `..` segment (WHATWG-URL normalized) let any authenticated
  non-admin user reach arbitrary Audiobookshelf admin-API endpoints such as
  `/api/me`. The proxy now rejects traversal (`..`), backslashes, leading
  slashes, and any path outside the `items/` namespace before issuing the
  outbound request, while still allowing operator-configured internal/LAN ABS
  hosts.
- Required authentication on the audiobook cover endpoint like the rest of the
  audiobooks API, and validated and contained the cover-cache fallback path,
  closing an unauthenticated arbitrary-image read and path traversal; existing
  frontend cover URLs already include `?token=`, so no client change was needed.
  The endpoint also now uses the shared image rate limiter and defers CORS
  headers to the app-level origin allowlist instead of reflecting the request
  origin with credentials.
- Stopped forwarding raw download-failure text to clients from the playlist
  pending-track retry session log and the notifications download-retry
  response (static messages; raw detail stays in the server log), and widened
  the route error-canon leak ratchet to also catch `.error`/`.detail`
  property values (e.g. `result.error`, `err.response?.data?.detail`) outside
  logger calls, freezing and documenting the pre-existing instances in the
  baseline.
- Closed an SSRF class on outbound image fetches: the Subsonic `getCoverArt`
  remote fetch and the enrichment image downloader now use the shared
  DNS-resolving outbound URL policy with per-hop redirect revalidation
  (blocking loopback/private/link-local/metadata targets and unsafe redirects),
  replacing a string-only host check that missed 169.254.0.0/16, most of
  127.0.0.0/8, IPv6 link-local/ULA, and numeric IP encodings.
- Pinned the remaining mutable GitHub Actions tags in
  `image-security-scanning.yml` (`actions/checkout`, `docker/login-action`,
  `github/codeql-action/upload-sarif`) and `compose-config-check.yml`
  (`actions/checkout`) to the repo-standard full commit SHAs.
- Sanitized playback-state 500 responses and persisted download-job errors so
  raw failure details remain server-log only, and restricted
  `POST /api/downloads/clear-lidarr-queue` to administrators.
- Capped batch TIDAL search requests at 50 queries and limited concurrent
  searches against each shared per-user TIDAL session to 5.
- Sanitized the TIDAL device-code poll 500 response to a static message (raw
  failure detail is now server-log only), widened the route error-canon leak
  ratchet to catch bare `err`/`e`/`ex` catch-variable leaks across routes and
  top-level services (freezing pre-existing instances in the baseline), and
  chunked TIDAL batch match-search calls to at most 25 queries per sidecar
  request.
- Sanitized the scan-queue failure message written to the client-readable Spotify
  import session log, keeping raw detail in the server log only, and widened the
  route error-canon leak ratchet to catch suffixed error identifiers
  (`scanError.message`, etc.) and `as`-cast property access, with new frozen,
  documented baselines for `auth.ts` (Zod validation detail) and `streaming.ts`
  (typed `SegmentedSessionError` messages).
- Stopped returning raw caught-error text to clients from the playlist
  pending-track retry path and podcast refresh-all: the retry handler wrote
  `error.message` into the session log (returned verbatim to any authenticated
  caller via `GET /api/spotify/import/session-log`) and into the stored
  `downloadJob.error` field (returned via `GET /api/downloads`), and
  `refreshAllPodcastFeeds` echoed per-feed `error.message` in the
  `POST /api/podcasts/refresh-all` response. All three now use static client
  messages with raw detail kept in server-side logs only, and the
  `check-route-error-canon` leak-ratchet baselines were lowered
  (`playlists.ts` 4→1, `podcasts.ts` 3→2); the remaining counts are
  server-side-only or code-owned validation text, documented in the checker.
- Closed a `discover.ts` follow-up gap left by the route error-disclosure
  hardening: the legacy `POST /api/discover/cleanup-lidarr` handler built a
  per-artist failure string via a template literal
  (`Failed to process ${name}: ${error.message}`) and returned it verbatim in
  the response `errors[]`, leaking raw axios/Lidarr/Prisma text (connection
  strings, hosts/ports, API-key-bearing URLs, 401 bodies) to any authenticated
  caller since the router is `requireAuthOrToken`, not admin-only. The handler
  now pushes a static `Failed to process <artist>` message, logs the raw detail
  server-side only, and guards non-`Error` throws. The `check-route-error-canon`
  leak ratchet was extended to also detect template-literal interpolations and
  intermediate-const assignments of `error.message`/`error.stack` (previously it
  only matched the `: error.message` object-property form), while exempting
  raw errors written to the server-side `logger`; `discover.ts` is ratcheted to
  zero and the newly surfaced pre-existing counts in `playlists`/`podcasts` are
  frozen as follow-up.
- Route error-message disclosure hardening (OWASP): the `discover`,
  `enrichment`, and `library` routers no longer echo raw caught-error text
  (`error.message` / `error.stack` / a `details` field carrying it) to clients.
  Every affected handler now returns a static, curated `{ error: "…" }` message
  and logs the raw error server-side only. This also fixes a latent bug in
  `enrichment.ts` where a non-object throw (e.g. `null`) made the catch block
  dereference `error.message` and throw again, leaving the request with no
  response. The `check-route-error-canon` CI script gains a second,
  independent ratchet that flags raw `error.message` / `error.stack` echoed
  into response bodies (baseline can only decrease); the three fixed routers
  are ratcheted to zero. Remaining routers with the pattern
  (`downloads`, `listenTogether`, `notifications`, `playbackState`,
  `playlists`, `podcasts`) are frozen at their current counts and tracked as
  follow-up.
- Digest-pinned the two remaining unpinned base images and closed the gap in the
  Dockerfile digest-pin ratchet. The root AIO `Dockerfile` (`node:24-bookworm-slim`)
  and `services/audio-analyzer/Dockerfile` (`python:3.11-slim`) were both unpinned
  and excluded from `scripts/ci/dockerfile-hygiene.test.mjs`, while every sibling
  service Dockerfile was pinned and gated. Both bases are now pinned by `@sha256:`
  (tag kept inline for dependabot), and both paths were added to the gate's
  `dockerfilePaths` so the ratchet enforces digest pinning across all repo
  Dockerfiles.
- Path containment on native audio streaming: the `GET /api/library/tracks/:id/stream`
  handler now resolves the DB-sourced `track.filePath` through `safeResolvePath`
  and returns `404 Track not available` when the resolved path escapes the
  configured music root (via `../` traversal or an absolute path), instead of
  joining it under the root with a bare `path.join`. The containment check runs
  once, before the streaming service is constructed, and covers both the primary
  and FFmpeg-fallback branches. This brings the route in line with the sibling
  Subsonic and share-link streaming paths, which already enforce containment.
- **Cover-art hardening (Subsonic dimensions change):** the OpenSubsonic
  `getCoverArt` endpoint no longer resizes with an inline `sharp` pipeline that
  dropped the shared service's guards. It now delegates to the hardened
  `coverArtResize` service, gaining the ~50MP decode ceiling (decompression-bomb
  protection) and `Accept: image/webp` format negotiation, and it snaps the
  requested `size` to the cover-art allowlist (`64/128/192/320/512/768`) instead
  of honouring arbitrary `16..2048` values. Requested sizes that fall between
  allowlist entries now return the next larger bounding box (e.g. `size=300`
  returns a 320px-bounded image); clients that display cover art scaled to their
  own layout are unaffected.
- At-rest secret hygiene for the `.env` sync: `writeEnvFile` now writes the
  secrets-bearing `.env` (which holds `SETTINGS_ENCRYPTION_KEY` and decrypted
  integration API keys) with owner-only `0600` permissions and **atomically**
  (write to a same-directory temp file, `chmod 0600`, then `rename` over the
  target, with the temp file cleaned up and the original error re-thrown on
  failure). Previously the file was created world-readable under the process
  umask and written in place, so a crash mid-write could leave a truncated
  secrets file. Nothing about which keys are synced changed.
- **BREAKING (Subsonic token-auth clients re-authenticate once):** the OpenSubsonic
  auth middleware no longer silently persists a user's **primary account
  password** as reversible ciphertext. Previously, a successful password-auth
  request stored `encrypt(accountPassword)` in `user.subsonicPassword` so that
  MD5 token auth would work — converting a bcrypt-only account password into a
  key-reversible value at rest. Password auth now authenticates via bcrypt and
  persists nothing. Subsonic **token** auth (`t`+`s`) validates against the
  dedicated per-user Subsonic secret set explicitly via
  `POST /api/auth/subsonic-password`. Changing the account password (self-service
  `POST /api/auth/change-password` and admin user updates) now also clears
  `subsonicPassword`. Clients using token auth with the account password must set
  a dedicated Subsonic password once, or switch to password auth. See
  `docs/UPGRADING.md`.
- Legacy (pre-GCM) at-rest decryption can now fail **closed** behind the opt-in
  `SETTINGS_DECRYPT_FAIL_CLOSED` flag. The legacy AES-256-CBC path previously
  returned unrecognized/plaintext values verbatim (fail-open passthrough),
  keeping unauthenticated ciphertext and plaintext-passthrough alive
  indefinitely. With the flag enabled, any stored value that is not an
  authenticated `v2:` envelope throws instead of being returned. The Tidal
  credential reader honours the same flag (it no longer falls back to using raw
  stored ciphertext as a bearer token when fail-closed). Enable the flag only
  after `GET /api/admin/secrets-status` reports zero legacy rows; authenticated
  `v2` ciphertext always fails closed regardless. See `docs/UPGRADING.md`.
- The standalone `audio-analyzer` (Essentia/MusiCNN) sidecar now builds on
  `python:3.11-slim` instead of EOL Ubuntu 20.04 / Python 3.8, restoring OS and
  interpreter security updates and satisfying the repo's Python 3.11+ contract
  (roadmap F51). Its hash-pinned `requirements.lock` was recompiled for Python
  3.11 and now shares the AIO image's TensorFlow 2.15.1 / essentia-tensorflow
  2.1b6.dev1389 / numpy 1.26.4 stack, so both analyzers produce identical model
  output; `essentia-tensorflow` is pinned exactly because it publishes only
  pre-release builds. The blocking pip-audit lane now audits this lock on Python
  3.11 with the TensorFlow 2.15 exception set (`docs/SECURITY.md`). No runtime
  behavior change; the analysis pipeline and MusiCNN classification heads are
  unchanged.
- Helm chart pod hardening: all chart-managed workloads now set
  `seccompProfile: RuntimeDefault`, drop all Linux capabilities on the
  application containers, and set `automountServiceAccountToken: false` (no
  chart workload calls the Kubernetes API). Postgres and Redis keep their
  existing user-switching entrypoints (seccomp added, capabilities untouched).
- Helm chart no longer renders third-party API keys/tokens (`LIDARR_API_KEY`,
  `AUDIOBOOKSHELF_TOKEN`, `LASTFM_API_KEY`, `FANART_API_KEY`, `OPENAI_API_KEY`)
  as plaintext `value:` env in pod specs. When the chart manages its own Secret
  (default), they are injected via `secretKeyRef` from that Secret. Deployments
  using `secrets.existingSecret` keep the legacy plaintext behavior for
  backward compatibility unless `secrets.apiKeysInExistingSecret=true`, which
  reads the keys from the existing Secret via `secretKeyRef`. See
  `docs/UPGRADING.md`.
- All-in-One (AIO) backend, frontend, and analyzer processes now run under
  supervisord as the fixed `soundspan` user (uid/gid 1000). Existing writable
  volume paths are chowned automatically on every boot; see
  `docs/UPGRADING.md` for bind-mount requirements.
- AIO backend `.env` and persisted master-secret files are now owner-only
  (`0600`, uid 1000), and `/data/secrets` is mode `0700`.
- AIO now honors operator-supplied `SESSION_SECRET`,
  `SETTINGS_ENCRYPTION_KEY`, and `INTERNAL_API_SECRET`, with precedence env →
  persisted file → generated value and write-through persistence. Published
  defaults and short `SESSION_SECRET` values fail startup; `docker-compose.aio.yml`
  now forwards all three secrets. See `docs/UPGRADING.md`.
- Embedded AIO Postgres now uses a generated or operator-supplied password
  persisted under `/data/secrets`, synchronizes existing databases
  automatically, listens only on loopback, and permits only loopback clients
  authenticated with `scram-sha-256`.
- AIO health checks now require both frontend health and backend readiness.
  Helm AIO pods use shared exec liveness/readiness probes plus a generous
  `startupProbe`, so backend or database failure is no longer reported healthy.
- Replaced the unmaintained `speakeasy` TOTP library (last released in 2016) on
  the 2FA path with actively maintained `otplib` v13 and its audited
  `@noble/hashes` and `@scure/base` cryptography. Existing enrolled 2FA secrets
  remain compatible: verification is still RFC 6238 TOTP over the same base32
  secrets with the same effective validity window (`epochTolerance: 60` seconds,
  equivalent to the former Speakeasy `window: 2`), verified by a behavioral test
  using real Speakeasy-generated tokens. Malformed tokens and secrets now fail
  closed with 401 responses, never 500 errors.
- Long-lived (30-day) refresh tokens carrying `type: "refresh"` were accepted
  anywhere an access token was, including Bearer headers, streaming `?token=`
  query parameters, and the Listen Together socket. JWT verification is now
  consolidated in a single `verifyAccessToken` accessor that pins HS256,
  requires a well-formed payload, and rejects any token carrying a `type` claim,
  while `/api/auth/refresh` continues to accept refresh tokens for exchange
  only.
- SSRF: podcast episode audio (stream + background download) is now validated by the DNS-resolving outbound-safety guard at fetch time, with every redirect hop re-validated (public CDN redirects and HTTP Range streaming preserved); attacker-controlled enclosure URLs can no longer reach private/loopback/link-local/metadata addresses.
- CORS: the authenticated podcast stream and cover routes no longer reflect an arbitrary request Origin together with credentials; credentialed CORS is owned solely by the allowlist-enforcing global middleware.
- **BREAKING (opt-out available):** CORS is now deny-by-default in production. Previously, when `ALLOWED_ORIGINS` was unset, the backend reflected ANY request origin with `credentials: true`, letting arbitrary websites make cookie-authenticated cross-origin requests. Now an unset allowlist denies cross-origin browser requests in production (same-origin deployments — the standard frontend-proxy setup — are unaffected; requests without an `Origin` header and development mode remain allowed). Restore the legacy behavior with `CORS_ALLOW_ALL=true`, or better, set `ALLOWED_ORIGINS` to your frontend origin(s). See `docs/UPGRADING.md`.
- **BREAKING (opt-out available):** the Lidarr webhook (`POST /api/webhooks/lidarr`) now fails closed. Previously, when no webhook secret was configured in System Settings, the endpoint accepted unauthenticated requests (which could drive download-state mutations and queue library scans). Now it rejects them with 401 until a secret is configured; `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` restores the legacy behavior for deployments that cannot set a secret yet. See `docs/UPGRADING.md`.
- Ending a Listen Together group now enforces host authorization even when the group is not hydrated in local memory (post-restart / multi-pod): `POST /api/listen-together/:groupId/end` verifies `hostUserId` against the database instead of skipping the check.
- Library-wide enrichment triggers `POST /api/enrichment/sync` and `POST /api/enrichment/start` now require admin, matching their admin-gated siblings (`/full`, `/pause`, `/resume`, `/stop`, resets). Per-user enrichment settings and the user-facing metadata editor routes are unchanged.
- Artist discovery/preview endpoints (`GET /api/artists/discover/:nameOrMbid`, `GET /api/artists/album/:mbid`, `GET /api/artists/preview/:artistName/:trackTitle`) now require authentication (`requireAuthOrToken`, same guard as the existing preview stream) instead of proxying MusicBrainz/Last.fm/Deezer/fanart/YouTube Music lookups unauthenticated.
- Fixed the `ADMIN_RESET_PASSWORD` emergency recovery: it queried `role: "ADMIN"` while roles are stored lowercase, so the reset silently never matched an admin user. It now works as documented.
- Added a route-mount contract test asserting every `/api/*` (and `/rest`) prefix is mounted behind its expected rate-limiter tier and router, so silently dropping a limiter or mounting an unreviewed prefix fails CI.
- **BREAKING:** The split-stack deploy no longer ships default secrets, and secret
  bootstrap now fails fast (migration steps in `docs/UPGRADING.md`).
  `docker-compose.yml` requires `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, and
  `INTERNAL_API_SECRET` (each generated with `openssl rand -base64 32`) instead of
  falling back to published values, and the backend image's entrypoint exits with an
  actionable error instead of generating an ephemeral per-boot `SESSION_SECRET`
  (which invalidated JWTs and stranded API-key hashes on every restart) or exporting
  the insecure `default-encryption-key-change-me` encryption key (which the backend
  rejected at module load — a guaranteed crash-loop with a misleading message).
  The unreachable onboarding first-registration encryption-key generation path was
  removed; the key must exist before boot.
- **BREAKING:** The `tidal-downloader` and `ytmusic-streamer` sidecars now reject the
  old repo-published `INTERNAL_API_SECRET` default value
  (`soundspan-internal-secret-change-me`) as unconfigured (403 fail-closed), and
  `docker-compose.local.yml` no longer injects it as the local CLAP default.
- **BREAKING:** `docker-compose.yml` now binds the Postgres and Redis host ports to
  `127.0.0.1` only — they were previously published on **all host interfaces** with
  weak/no credentials. Same-host tooling keeps working; `docs/UPGRADING.md` documents
  a compose-override escape hatch for re-publishing.
- The backend image's `REDIS_FLUSH_ON_STARTUP` entrypoint fallback is now the safe
  `false` (matching every shipped compose file and the Helm chart) instead of a
  destructive default `FLUSHALL` on startup.
- `GET /api/onboarding/status` no longer accepts refresh tokens as bearer tokens:
  a token carrying `type: "refresh"` is treated like an invalid token and receives
  only the basic user-count status (verified via the shared
  `verifyAccessToken` accessor).
- The `/api/onboarding` routes are now rate-limited: `/register` (which mints the
  first admin account) sits on the strict auth limiter like `/api/auth/register`,
  and the rest of the onboarding wizard uses the general API limiter.
- Internal-secret auth now fails closed on the published default sentinel: the
  `requireInternalSecret` middleware (`x-internal-secret` guard on backend→sidecar
  callbacks) previously rejected only when `INTERNAL_API_SECRET` was unset, so a
  deployment left on the repo-published default `soundspan-internal-secret-change-me`
  would accept forged internal calls. It now rejects (403) when the secret is unset
  **or** equal to that known default, restoring parity with the FastAPI sidecar guard
  (`sidecar_runtime_utils.py`) and the fail-fast-on-default posture of
  `encryption.ts`.

- Every third-party GitHub Action across the six CI workflows is pinned to a full
  commit SHA with a `# vX.Y.Z` comment; Dependabot still bumps those pins.
- The gitleaks scanner image is pinned to v8.30.1 by version and digest instead
  of `:latest`.
- The `HF_TOKEN` build secret now passes directly from the secrets context to
  the Docker build-secret mount instead of transiting a step output.
- The gitleaks secret-scan gate is now blocking on pull requests.
- Dependency Review and Trivy remain non-blocking; the recommended ratchet —
  Dependency Review with `fail-on-severity: high` first, then Trivy — is
  documented in-workflow as a deliberate owner decision.
- Require admin on `POST /api/enrichment/artist/:id` and
  `POST /api/enrichment/album/:id` — single-item enrichment applies results
  library-wide and makes outbound metadata API calls; removed the unused
  `enrichArtist`/`enrichAlbum` frontend client methods.

- Segmented-streaming DASH build failures no longer include raw ffmpeg stderr
  (absolute library/cache paths and errno detail) in 502 responses; clients now
  receive a static message and error code while full detail is logged
  server-side only. The route-error leak ratchet now recurses into
  `backend/src/services/` subdirectories. Retry semantics are preserved by
  carrying the server-computed transient-vs-permanent build-failure
  classification as a flag instead of deriving it from the previously
  detail-bearing client message.

### Accessibility

- The player seek slider now exposes screen-reader slider semantics and supports
  Arrow, Page Up/Down, Home, and End keyboard seeking without changing pointer
  or touch seeking behavior.
- The shared Modal now exposes labelled dialog semantics, traps and initializes
  focus, and restores focus on close; ConfirmDialog now composes that hardened
  Modal instead of maintaining a separate overlay implementation.
- Track lists now support keyboard reordering from labelled grip buttons,
  clickable track rows expose button semantics with Enter/Space activation,
  queue icon controls have accessible labels, and scoped jsx-a11y lint guards
  protect the hardened accessibility components.
- The vibe map canvas now exposes an application role, an accessible name and a
  live text summary of its node count and focused track, and supports keyboard
  navigation (Arrow/Home/End to move focus between visible tracks, Enter/Space
  to explore the focused track) alongside the existing pointer interactions.

## [1.9.0] - 2026-08-08

### Added

- The Vibe Map is now an interactive navigator instead of a static scatter plot (slice 6 of the interactive vibe map rebuild, #203 — integrates the reviewed slices into the UI). The Map tab renders full-bleed (no more 60vh box) with a floating Explore/Map switcher; fullscreen layers above the player bar; on mobile every bottom-floating surface lifts clear of the mini player. On the map itself: a pulsing beacon + locate button for the currently playing track, a session trail with On/Fade/Off display modes and a clear action, per-mood show/hide chips (shift-click to solo, including the previously-invisible "Neutral" bucket), dual-thumb Energy/Mood range sliders, an animated "Spread" layout toggle, zoom-scaled dots, and a spotlight pill that finds tracks/artists in-memory (picking one flies the camera to the dot) with semantic vibe search as the fallback row. Four interaction modes: **Travel** (click a dot to walk the similarity graph with a mood compass and per-neighbour "why this match" breakdowns), **Journey** (route to a destination track or mood as a numbered on-map path, playable as a queue), **Drift** (one-click 12-step mood slide), and **Alchemy** (ctrl-click 2–10 tracks into a weighted blending tray). Plus **Sweep** — shift-drag (or an armed touch brush) paints a stroke that collects up to 100 visible dots into a Play/Queue/Save chip — a dashed **flight plan** through the next 10 on-map queue tracks, a Queue panel with drag-to-reorder (sharing the `/queue` page's primitives and Listen Together guards), one-click save-as-playlist for journeys/sweeps/history (partial saves surface as warnings naming the miss count, never false success), library-calibrated match percentages ("closer than N% of random pairs in your library") on every match surface with edge width/opacity encoding true similarity, an "About this map" explainer popover, a dismissable hint chip teaching each mode's modifier verbs, and one eased camera owner coalescing wheel/drag/pinch input per frame (native non-passive wheel — the page no longer scrolls or browser-zooms underneath). Shift-click queues a dot in every mode; Esc unwinds sweep chip → open panel → active mode → fullscreen in that order.
- Vibe journey + moods API (slice 3 of the interactive vibe map rebuild, #203): `POST /api/vibe/journey` interpolates through CLAP embedding space from a starting track toward either a destination track (`toTrackId`) or the centroid of a mood bucket (`mood`), returning 2–20 ordered waypoint tracks with nullable `audioFeatures` (energy/valence/danceability/arousal); track-mode journeys always end at the literal destination track, and `excludeTrackIds` (≤200 non-empty IDs) keeps chosen tracks out of the walk. `GET /api/vibe/moods` lists each canonical mood with its count of qualifying embedded tracks so clients can enable/disable mood targets. Both endpoints follow the Prisma data boundary — the mood pool is a relational `moodBucket` query and the only vector reads go through the new service-layer `fetchEmbeddingsByTrackIds` (`services/trackEmbeddings.ts`); request validation lives in focused helpers in `routes/vibeJourneyRequest.ts`, and route orchestration stays within the repository function-size gate. The `/api/vibe/similar` and `/api/vibe/path` nearest-track payloads now also carry the same nullable `audioFeatures` block.
- CI safety net: `quality-visibility.yml` gained a "Run frontend component tests" step (`npm run test:component`) in the frontend job, plus two standalone typecheck jobs — `backend-typecheck` and `frontend-typecheck`, each a `tsc --noEmit` run against their respective package. Like the existing quality-visibility jobs, both are non-blocking until an admin flips the `CI_NON_BLOCKING_TEST_VISIBILITY` repo variable to `'false'`.
- CI now runs security scanning and weekly dependency automation (#59 WS2.4, roadmap F45): Trivy filesystem + image scans (`CRITICAL,HIGH`, `ignore-unfixed`, findings triaged in `.trivyignore`), a gitleaks secret scan via the OSS binary directly (not the licensed `gitleaks-action`), CodeQL (`javascript-typescript` + `python`), `dependency-review-action` on PRs, and a `pip-audit` sweep of the four sidecar services' requirements files. `.github/dependabot.yml` opens weekly, grouped minor/patch PRs across the 4 npm manifests, 4 pip services, 7 Dockerfile directories, and GitHub Actions (`open-pull-requests-limit: 5` per ecosystem; yt-dlp/ytmusicapi are deliberately never excluded). `pip-audit` now blocks unexpected advisories; the two legacy TensorFlow lanes carry explicit, documented compatibility exceptions. Trivy and gitleaks remain visibility-only until the broader 1.10.0 ratchet.
- 15-second skip back/forward buttons in the player transport controls (#20), for scrubbing past commercials/recaps during podcast and audiobook playback. Added to `FullPlayer` (desktop bottom bar) and `OverlayPlayer`'s mobile full-screen transport row, flanking the existing Previous/Next-track buttons (which are unchanged in behavior and in their adjacency to Play/Pause); `MiniPlayer`'s compact bar was deliberately left alone to avoid crowding an already-minimal control set. Wired to the existing `skipBackward`/`skipForward` actions on the audio-controls context (`lib/audio-controls-context.tsx`), called with a fixed 15s regardless of the functions' own 30s default; new `RotateCcw`/`RotateCw` icons with `aria-label`s "Skip back 15 seconds" / "Skip forward 15 seconds". Because these are seeks, both buttons respect the existing `canSeek` gate and disable — like the seek slider — while an uncached podcast episode is still caching.
- Vibe calibration API (slice 4 of the interactive vibe map rebuild, #203): `GET /api/vibe/calibration` returns the p0–p100 percentiles (101 values) of pairwise CLAP cosine distance over a bounded random sample of embedded tracks, so clients can express match strength as "closer than N% of random pairs in your library" instead of the fixed `1 - distance/2` mapping. The sample is drawn without any full-table `ORDER BY random()` work — an id-only indexed Prisma scan (capped at 50k ids) plus a Fisher–Yates pick and one primary-key fetch in the service layer (`services/vibeCalibration.ts`); results are cached in Redis for 24h keyed on the embedded-track count (self-invalidating as the library grows), cached payloads are validated before use, concurrent cold-cache requests collapse into a single compute via an in-process single-flight, and libraries with fewer than 10 embedded tracks get `{ sampleSize: 0, quantiles: [] }` so clients fall back to the linear mapping. If embeddings disappear during the count/sample race, the request fails explicitly and remains immediately retryable instead of returning a null-filled quantile ladder.

### Changed

- Vibe-map journey, alchemy, and spotlight requests now invalidate in-flight
  work when their inputs change or their mode closes, so a late response cannot
  overwrite newer choices. Sweep saves only dismiss the result they started
  from, preserving any newer stroke completed while a save was pending.
  The slice-5 map controls and hooks were also split into focused functions to
  satisfy the repository's 60-line review gate without changing their public
  behavior.
- YouTube Music streamer Uvicorn raised from 0.51.0 to 0.52.1, with the
  hash-pinned runtime lock regenerated alongside its `>=0.52.0` manifest floor.
- TIDAL downloader Uvicorn raised from 0.51.0 to 0.52.1, with the hash-pinned
  runtime lock regenerated alongside its `>=0.52.0` manifest floor.
- The CLAP sidecar and all-in-one hash locks now satisfy the CLAP manifest's
  redis-py 8.1.0 floor. Regenerating the shared lock also corrects its stale
  transformers 5.13.1 pin to the manifest's existing 5.14.1 floor, and a
  focused regression test keeps both deployed locks synchronized with future
  Redis floor changes.
- The CLAP analyzer image now runs Python 3.12 instead of 3.10. Its hash-pinned
  dependency lock is resolved for the same interpreter, removing the
  Python-3.10-only `async-timeout` and `exceptiongroup` backports.
- `dotenv.config()` in `backend/src/config.ts` now passes `{ quiet: true }`: a no-op on the current dotenv 16, and it pre-silences the per-boot `◇ injected env (N) from .env // tip: …` line dotenv 17 (Dependabot #182) prints on every process start and every jest suite boot. Env loading behavior is unchanged.
- The Prisma 7 pg adapter now receives the decoded `schema` query parameter
  from `DATABASE_URL`, preserving custom-schema deployments after the
  driver-adapter migration.
- Sidecar dependency floors bumped and hash-locks regenerated together (supersedes Dependabot's floor-only PRs #166/#168/#169/#170/#171/#172/#173/#174/#176/#191/#192, which never reach a built image because all four sidecar images install exclusively from uv `--generate-hashes` locks). Movements: fastapi 0.139.0 → 0.141.1 (ytmusic-streamer + tidal-downloader locks, py3.14 targets), transformers 5.13.1 → 5.14.1 and GitPython 3.1.50 → 3.1.58 (audio-analyzer-clap lock, py3.12 target). The GitPython patch clears the advisories reported against 3.1.50, and the TIDAL lock now carries patched aiohttp 3.14.3. The requests / numpy / psycopg2-binary floors now match versions their locks already pin, and the anyio test floor rises to 4.14.2. audio-analyzer is deliberately untouched: its Ubuntu 20.04 / Python 3.8 / essentia-tensorflow (TF 2.13–2.15 ABI) stack makes Dependabot's redis>=8.0.1 (requires Python ≥3.10) and tensorflow>=2.21 (no cp38 wheels) proposals unresolvable.
- The frontend standalone TypeScript check now passes across application and test sources, burning down the 92-error test-fixture backlog and returning the `Frontend Typecheck` job to the shared `CI_NON_BLOCKING_TEST_VISIBILITY` ratchet. The fix aligns fixtures with their current component/domain contracts, explicitly permits TypeScript-extension imports in this no-emit/tsx project, and augments the lagging `@types/node` declaration with Node 24's supported `mock.module({ exports })` option. `npm run verify:frontend` now includes component tests and a clean-cache `typecheck` step so the documented local gate matches CI.
- Backend `archiver` bumped 7.x → 8.x with `@types/archiver` ^8 (supersedes Dependabot #179, whose dependency-only bump fails typecheck). v8 ships ESM-only with named class exports — the `archiver("zip", …)` default-export factory is gone — so the share-link zip route now constructs `new ZipArchive({ zlib: { level: 0 } })` from the same dynamic `import("archiver")`, loaded under the Node 24 images' `require(esm)` interop. The archive surface used (`.file`/`.pipe`/`.finalize()`/`on("error" | "warning")`) and the store-only (level 0) zip behavior are unchanged; the typed v8 event overloads also remove two implicitly-`any` error-handler params.
- Backend TypeScript bumped `^5.3.3` → `^6.0.3`, matching the frontend's existing TS 6 line and staying inside ts-jest's `>=4.3 <7` peer range (TS 7 itself is un-installable until ts-jest supports it — Dependabot #180). One migration was needed: TS 6 no longer auto-includes ambient globals from every `node_modules/@types` package, which silently dropped jest's `describe`/`it`/`expect` globals across all ~300 test suites (`tsc --noEmit` reported ~30k cascade errors, every one in test files); `backend/tsconfig.json` now declares `"types": ["node", "jest"]` explicitly. Import-based `@types` resolution (express, multer, …) is unaffected by the `types` allowlist, and `src/` proper compiled unchanged — `tsc --noEmit` is back to exit 0 with zero source edits.
- Prisma upgraded 6 → 7 (`@prisma/client` + `prisma` CLI together, both `^7.8.0`), adopting the Rust-free client architecture. The query engine binary is gone — the client now runs a bundled WASM query compiler over a real `pg` connection pool via the new `@prisma/adapter-pg` driver adapter (required in v7: the `datasources`/`datasourceUrl` constructor options were removed). A new `backend/src/utils/prismaClientFactory.ts` is the single construction point for the adapter-backed client (API/worker singleton, scripts, seeds), and the datasource URL moved from `schema.prisma` to the new `backend/prisma.config.ts` (Prisma 7 rejects `url =` in the schema; the config only wires `datasource` when `DATABASE_URL` is set so build-time `prisma generate` works without a database). Operational notes: pool sizing moved from `DATABASE_URL` query params (`connection_limit`/`pool_timeout`, a Rust-engine concept) to pg pool options (`max`/`connectionTimeoutMillis`) fed by the same `DATABASE_POOL_SIZE`/`DATABASE_POOL_TIMEOUT` envs and role-aware defaults; `binaryTargets` was removed from the generator (no engine binaries exist to pin against the container's OpenSSL anymore); Prisma 7 no longer auto-generates the client on `npm install`, so CI typecheck/test jobs gained explicit `npx prisma generate` steps; both Dockerfiles now copy `prisma.config.ts`, and the AIO image keeps a local (not global) `prisma` CLI after prune because `prisma.config.ts`'s `import "prisma/config"` must resolve from the app's `node_modules`. A `backend/package.json` `overrides` entry forces `@hono/node-server` to `^1.19.13` (the Prisma 7 CLI's `@prisma/dev` pins the vulnerable `1.19.11`; GHSA-92pp-h63x-v22m, a moderate serveStatic middleware-bypass) — dev-CLI-only tooling, never in the `@prisma/client` runtime, but pinned patched to keep Dependency Review green.
- Backend `zod` upgraded 3.25 → 4.4 (#154), migrating all usage: `ZodError.errors` (removed in v4) → `.issues` at every route/config site that serializes validation failures, and `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` (v4 requires an explicit key schema). Validation-error response envelopes are unchanged — still `{ error, details: [...issues] }` with the same status codes, and `details` carries the same issue array (`path`/`code`/`message`) it always did, since v3's `.errors` was already an alias of `.issues`. Only the issue *internals* follow zod 4's format (e.g. default message text like `"Required"` is now `"Invalid input: expected string, received undefined"`, and `invalid_type` issues no longer carry a `received` field) — no consumer in this repo asserts on those internals.
- Backend session store `connect-redis` bumped 7.x → 9.x (#153), migrating the express-session wiring to the v8+ API: the store is now imported as the named export `RedisStore` instead of the v7 default export (v8 dropped the default export; the constructor and its options — `client`, `ttl` — are unchanged, so the `new RedisStore({...})` call site in `index.ts` is untouched). connect-redis 9's hard peer dependency `redis@>=5` is satisfied by the node-redis 6.x client the backend already ships (#149/#158), so no client change rides along; the store's session get/set/destroy/touch path over that client is unchanged from v7's.
- Backend `redis` (node-redis) client bumped 4.x → 6.x (#149), migrating the app off APIs the new major changed or deprecated: graceful shutdown now calls `client.close()` instead of the deprecated `quit()`; the social-presence key scan iterates `scanIterator()`'s new per-page key *arrays* (under v6 the old per-key loop would have silently collected zero presence keys, emptying the online roster); `set(..., { EX })` TTL options moved to the v6 `expiration: { type: "EX", value }` form; and the Redis lifecycle logging listens for the `end` event the client actually emits (the previous `"disconnect"` listener matched no node-redis event and never fired). Bull (ioredis) and `connect-redis` session wiring are untouched — connect-redis v7's session get/set/destroy/touch path is compatible with the v6 client, and the app never calls the store's scan-based `all`/`clear`/`length` methods.
- Backend `@bull-board/api` and `@bull-board/express` upgraded 6.16.4 → 8.1.2 (#151). No code changes required: the v7 basePath/prefix rework and v8 `dateFormats` `Intl.DateTimeFormatOptions` breaking changes don't touch this codebase's usage (`createBullBoard` + `BullAdapter` + `ExpressAdapter.setBasePath` at `/api/admin/queues`), and the adapter import paths are unchanged. The admin queues dashboard renders as before behind `requireAuth`/`requireAdmin`.
- Frontend toolchain bumps (#148, #99, #98): TypeScript `^5` → `^6.0.3`, ESLint `^9` → `^10.7.0`, and `lucide-react` `^0.577.0` → `^1.24.0`. ESLint 10 removed the deprecated `context.getFilename()` API that `eslint-config-next` 16.2.10's bundled `eslint-plugin-react` 7.37.5 still calls, so `eslint.config.mjs` now wraps the Next configs in `fixupConfigRules` from the official `@eslint/compat` shim (new devDependency, `^2.1.0`) — to be dropped once `eslint-config-next` supports ESLint 10 natively. The install also floated `eslint-plugin-react-hooks` 7.0 → 7.1, whose new `react-hooks/purity` compiler rule joins the existing warn-level debt-control block (one pre-existing `Date.now()`-in-`useMemo` finding in `app/discover/page.tsx`). lucide-react 1.0 removed brand icons, so the YouTube Music settings card's `Youtube` icon is replaced with `SquarePlay`, the closest generic stand-in.
- The frontend's custom streaming proxy (`frontend/server.js` + `frontend/server-proxy.js`, the path every `/api`, `/rest`, and Listen Together socket request takes in production) now runs `http-proxy-middleware` 4.x (from ^3.0.5, #152). v4 ships as ESM (loaded via Node's `require(esm)` — fine on the Node 24 images/CI) and swaps the underlying proxy from the unmaintained `http-proxy` to `httpxy`; the options surface used here (`target`/`changeOrigin`/`ws`/`xfwd`/`timeout`/`proxyTimeout`, `on.error`, `on.proxyReq`, `.upgrade`) is unchanged, so no code migration was needed — verified by the `serverBackendProxy` unit suite plus a live smoke of plain, chunked-streaming, 503 `API_PROXY_UNAVAILABLE`, and 504 `UPSTREAM_TIMEOUT` responses through the real server. Note: hpm v4's `engines` floor is Node `^22.15 || ^24 || >=26`, so the custom server no longer supports Node 20/21 hosts; the package declarations now require Node `>=24.0.0` to match.
- 31 of the 33 `/api/library` error tails now delegate unexpected failures to the shared `errorHandler` middleware via a new `asyncHandler` wrapper (roadmap F1, first tranche). Client-visible change: on an unexpected server failure, these routes' 500 response body is now the error handler's shape — `{"error": "Internal server error"}` in production (previously a route-specific string such as `{"error": "Failed to fetch tracks"}`), message + stack outside production. The status code is unchanged (500), as are all intentional 4xx/2xx responses and the two streaming-related tails (`/tracks/:id/stream`, `/tracks/:id/audio-info`), which keep their previous bodies. `AppError` also gained an optional explicit HTTP status honored by `errorHandler` (explicit status wins over the category map), a generic `ErrorCode.INTERNAL` exists for route 500s, and the handler's unhandled-error log line now includes `req.method` + `req.path` — replacing the per-route catch log context the migration removes, so failing routes remain identifiable in logs. The unused `safeError` helper (a third, parallel error path with zero callers) is removed.
- The backend now runs Express 5 (4.22 → 5.2.1, with `@types/express` ^5; roadmap F49, previously-declined Dependabot #103) as a compatibility-only migration — no error-path or middleware behavior changes. Three route patterns moved to path-to-regexp v8 syntax: the Subsonic catch-all `router.all("*")` → `"/{*splat}"`, the optional cover-art param `"/cover-art/:id?"` → `"/cover-art{/:id}"`, and the streaming shorthand segment route's inline regex constraint `":segmentName([A-Za-z0-9_.-]+\.(?:m4s|webm))"` (syntax removed in v8) → plain `:segmentName` plus a pre-auth guard that `next("route")`s on a pattern mismatch, keeping Express 4's 404-without-auth-check behavior for non-segment paths. Two Express 4 defaults are explicitly restored in `index.ts`: the `extended` query parser (Express 5 flipped the default to `simple`) and `req.body` defaulting to `{}` when no body parser matched (Express 5 leaves it `undefined`, which would have turned ~100 handlers' validation 400s into destructuring 500s). Express 5's `@types` widen `req.params` values to `string | string[]` (splat params), so ~45 route registrations across 19 route files gained explicit param typings (`Request<{ id: string }>` / `router.get<{ id: string }>(…)`) — type-only, named params are always strings at runtime. All Express-adjacent middleware was verified Express-5-compatible without source changes (`@bull-board/express` 6.16.4 itself depends on express ^5.2, `express-session` 1.19, `express-rate-limit` 8.5 peer `>= 4.11`, `swagger-ui-express` 5.0.1); helmet deliberately stays on 7 — the v8 + CSP/HSTS hardening is separate work per the roadmap.
- `GET /api/library/tracks/shuffle`'s large-library path no longer runs a full-table `ORDER BY RANDOM()` scan+sort per request (roadmap F15). It now samples via a new indexed `Track.random` column: pick a uniform pivot in `[0, 1)`, take the next `limit` rows by `random` ascending from that pivot, and top up with a wrap-around query (`random < pivot`) on shortfall — removing the endpoint's raw-SQL site entirely. On the local 15,230-track corpus: `LIMIT 100` p50 ~2.0ms → ~0.7ms, p95 ~4.1ms → ~1.5ms; `LIMIT 1000` p50 ~2.7ms → ~2.0ms, p95 ~3.3ms → ~2.4ms. The old query's cost is dominated by sorting the whole table and stays roughly flat regardless of `limit`; the new query's cost scales with `limit` via the index, so the win is largest at typical shuffle sizes and grows further as the library grows (the old query gets linearly slower with table size; the new one doesn't).
- Spotify/Deezer playlist-import preview matches tracks against the library
  roughly 2.5x faster on a 50-track playlist (≈130ms → ≈52ms median wall-clock
  on a 15,230-track dev corpus), by running the per-track library lookups
  through a bounded-concurrency queue (`p-queue`, concurrency 4) instead of
  one at a time. Discover Weekly's tier-based artist recommendations also
  check library membership via one batched query per generation run instead
  of up to 2 Prisma round trips per candidate artist across the similar-artist
  pool (F13).
- All Node-based Docker images, CI jobs, and package engine declarations now use Node 24 (`node:24-bookworm-slim` for backend/frontend/root-AIO images), replacing the previous 20/24 split. `@types/node` is bumped to `^24` in backend and frontend to match, and the backend `tsconfig` `lib` is raised `ES2020` → `ES2022` alongside, keeping `tsc` clean under `@types/node` 24 (which dropped the legacy compat declarations for post-ES2020 built-ins like `.at()` that the v20 types carried) — the declared lib now matches what the Node 24 runtime actually implements; type declarations only, emitted code and `target` unchanged.
- Similar-tracks and vibe search now surface genuinely related neighbours instead of near-random ones: every pgvector ANN query now applies a configurable `ivfflat.probes` on the same pooled connection (a transaction-scoped `set_config`), fixing recall that was silently stuck at Postgres' default of scanning 1 of the index's 224 lists. New `IVFFLAT_PROBES` env var, default `32` — benchmark-chosen on the local 15,230-track corpus, where it lifts recall@10 from ≈0.26 (probes=1) to ≈0.96 at ~6 ms p95.
- Every Python sidecar image (`ytmusic-streamer`, `tidal-downloader`,
  `audio-analyzer-clap`, `audio-analyzer`) and the all-in-one image now installs
  its dependencies from a committed, hash-pinned lock (`requirements.lock` per
  service; `requirements-aio.lock` for the AIO) via
  `pip install --require-hashes`, so rebuilding a given commit resolves the
  identical transitive dependency tree instead of whatever floated on PyPI that
  day (roadmap F50). Locks are generated per-interpreter with
  `uv pip compile --generate-hashes` (py3.14 for ytmusic/tidal, py3.12 for CLAP,
  py3.8 for the Essentia analyzer; one merged py3.11 lock resolving the analyzer
  and CLAP manifests jointly for the AIO's shared site-packages). The Essentia
  analyzer's `requirements.txt` became its real manifest (it now carries the
  TensorFlow/essentia/numpy pins the Dockerfile previously installed inline), and
  the AIO gained a build-time import smoke. `yt-dlp` and `ytmusicapi` are
  deliberately kept as loose floors (installed after the lock from
  `requirements-exempt.txt`) so a YouTube-side breakage stays a same-day floor
  bump. The `pip-audit` CI lanes now audit the locks (plus a new AIO-lock lane)
  alongside the unchanged loose test-manifest lanes.
- `image-builds.yml` cache exports (`cache-to: type=gha`) no longer fail a leg whose image already pushed. Self-hosted legs (AIO, CLAP) run cache exports for an hour-plus, which can outlive the GHA cache backend's ~1-hour SAS token and die with an Azure Blob 403 (`Signature not valid in the specified time frame`) after the image build itself already succeeded and pushed — turning a green push into a red job. Both `cache-to` sites now set `ignore-error=true`, so a cache-write failure is a warning instead of a job failure (#66).

### Fixed

- The vibe map's `/api/vibe/map` projection worker now loads under tsx dev mode: tsx's loader hooks don't propagate into `worker_threads`, so the `.ts` UMAP worker registers tsx in its own `execArgv` (compiled `dist/` deployments are unaffected).
- Direct Soulseek downloads now require an administrator, matching the existing
  server-side authorization on YouTube acquisition and preventing ordinary
  authenticated users from writing downloaded files into the shared library.
- Backend and frontend transitive dependencies with published same-major
  security fixes are now constrained to patched releases. The overrides cover
  the active YAML/glob/URI/IP/WebSocket/Socket.IO/parser utility advisories
  without forcing breaking direct-dependency downgrades.
- `POST /api/vibe/alchemy` now rejects weight arrays that sum to zero (e.g. all-zero or all-negative weights, which are floored to 0) with a 400 instead of letting a NaN-filled blended vector reach pgvector and surface as an opaque 500.
- The MusicCNN audio analyzer now lets its normal 30-second Redis queue poll finish instead of failing after redis-py's shorter socket deadline. Its socket timeout defaults to 35 seconds, stays at least five seconds above `BRPOP_TIMEOUT`, and can be tuned with `AUDIO_REDIS_SOCKET_TIMEOUT` (#183).
- The frontend proxy no longer adds a new timeout listener to a reused browser connection for every API request. This removes the repeated `MaxListenersExceededWarning` messages while preserving the existing backend response deadlines and streaming behavior (#183).
- The AIO frontend now starts after its build-only dependencies are pruned. `next.config.ts` no longer imports the development-only `@next/bundle-analyzer` package during normal production startup; it loads the plugin only for explicit `ANALYZE=true` builds. The AIO image build now reloads the production Next.js config after pruning so missing runtime config dependencies fail the image build instead of causing a restart loop after deployment (#183).
- CLAP workers no longer spam `Timeout reading from socket` while an empty Redis queue completes its normal blocking poll (#183). redis-py 8 introduced a five-second default socket timeout, which raced soundspan's five-second `BLPOP`; the queue connection now uses a bounded 10-second read timeout with a five-second safety margin above `SLEEP_INTERVAL`. Operators can tune it with `CLAP_REDIS_SOCKET_TIMEOUT`; unsafe lower values are clamped to `SLEEP_INTERVAL + 5`.
- The animated player UI (the mini/overlay/full-player shell) no longer
  re-renders 4×/second during playback — smoother UI with less battery drain and
  jank on mobile. The player render root now subscribes to the granular playback
  *state* context instead of the merged clock hook, and the engine clock is
  published to React state at display-second granularity while a full-precision
  clock is preserved for seek-lock and resume/progress persistence (roadmap F12
  items A+B).
- Documentation and agent-context truth pass from the 2026-07-10 drift audit (#58).
  The modernization roadmap header no longer claims long-merged PRs are awaiting
  merge (the nine Wave-1 continuation PRs merged 2026-07-08; F53 flipped to 🟡
  partial with the Node 20-vs-24 split documented), and its links to a
  never-committed standalone audit-findings file are gone. `ARCHITECTURE.md` now
  states the real auth model (Bearer JWT + `X-API-Key`, not a JWT cookie), the
  real local-stream route (`GET /api/library/tracks/:id/stream`), Bull v4 (not
  BullMQ), and the sidecars' actual no-inbound-auth posture. `TEST_MATRIX.md`'s
  pattern command runs as pasted on Jest 30 (`--testPathPatterns`); `TESTING.md`
  documents the 141 real sidecar pytest functions; `DATA_MODEL.md` says 57
  models / 1248 lines; `CONFIGURATION_AND_SECURITY.md` says `sameSite=lax` and
  `/api/admin/queues`. `ENVIRONMENT_VARIABLES.md` gains `STREAMING_ENGINE_MODE`,
  `FANART_API_KEY` (with its env-only enrichment-path caveat), `YT_DOWNLOAD_DIR`,
  `YT_DOWNLOAD_CONCURRENCY`, `YTMUSIC_LANGUAGE`, and
  `YTMUSIC_HOME_FILTERED_SHELVES`, and corrects `REDIS_FLUSH_ON_STARTUP`'s
  raw-image default (`true` — FLUSHALL on boot — vs the `false` the compose
  files and Helm chart pass explicitly). `UPGRADING.md` gains the 1.8.0
  native-engine-default entry (set `STREAMING_ENGINE_MODE=howler` to stay on
  the legacy engine). `FEATURE_INDEX.json` catches up to 1.8.0 (YouTube
  downloads, native audio engine, queue and playlist reordering);
  `docs/README.md` indexes five previously unlisted docs; the kima-hub adoption
  report is bannered ADOPTED with code evidence; and the remaining phantom file
  references (the `.awm/awm-work-loop.md` feature-plans link, CLAUDE.md's
  assets note, two never-committed ADR links) point at real files or say so.
- A duplicate or concurrent Lidarr `Grab` webhook (the same download delivered
  or retried twice) no longer 500s at `POST /api/webhooks/lidarr`.
  `onDownloadGrabbed` now catches the partial-unique-index violation
  (`DownloadJob_targetMbid_active_unique`) that a racing grab triggers on
  either the matched-job update or the tracking-job create, and resolves with
  the winning job's id instead of throwing — Lidarr sees an idempotent
  success instead of an error and stops retrying the webhook (roadmap F23).

### Security

- `/api/releases` (`GET /radar`, `/upcoming`, `/recent`, `POST /download/:albumMbid`) now requires authentication end-to-end (`router.use(requireAuth)`), matching what its own `@openapi` docs already claimed (`sessionAuth`/`apiKeyAuth` + a `401` response) but the code never enforced — any anonymous caller could previously read Lidarr/library release-radar data. One frontend consumer exists — `app/releases/page.tsx` calls this router via raw `api.request()` (`/releases/radar`, `/releases/download/:albumMbid`) — and is unaffected: the page only mounts inside `AuthenticatedLayout` (`/releases` is not a public path, so its fetch never fires unauthenticated), and `ApiClient.request()` always attaches the stored Bearer token, with the shared 401 refresh-and-retry fallback behind it.
- Offline downloads/cache and listening-state ("Continue Listening") endpoints no longer run with an undefined user id — which, on three of them, meant no per-user scoping at all. All 8 handlers across `offline.ts` (`:53,196,252,337,387`) and `listeningState.ts` (`:59,127,181`) read `req.session.userId!` as their only source of the user id — always `undefined` in practice, since both routers authenticate via `requireAuth`, which populates `req.user`, never `req.session`. Five of the eight fed the undefined id into unique-keyed Prisma lookups, which reject an undefined selector, so those endpoints simply 500'd. The other three passed it into non-unique `where` filters, and Prisma silently drops `undefined` filter keys: `GET /api/offline/albums` listed **every** user's cached tracks, `DELETE /api/offline/albums/:id` deleted **every** user's cached tracks for the album, and `GET /api/listening-state/recent` returned **every** user's listening states. All 8 now read `req.user!.id`, restoring per-user scoping (roadmap F11 step 1; the dead session-auth branch itself and the rest of the auth-resolver consolidation remain open). Calibration: on the typical single-operator deployment the visible symptom was the five 500s; on multi-user instances the three filter endpoints were cross-user data exposure and cross-user deletion.

### Admin/Operations

- `.github/dependabot.yml` now suppresses only the two proven Node toolchain ceilings from the 2026-07 dependency review: `@types/node` majors in both backend and frontend stay aligned with the Node 24 runtime images (#181/#198), and backend TypeScript 7 stays deferred while ts-jest 29.4.12 peers `typescript >=4.3 <7` (#180). Python analyzer and CLAP updates remain visible so runtime-and-lock modernization paths are not silently closed; the header's yt-dlp/ytmusicapi never-ignore rule is untouched.

- Database migration `20260711012100_add_track_random_sample_column` (roadmap F15) now adds `Track.random` nullable, installs the `random()` default, backfills existing rows, validates nullability, and creates the btree index `CONCURRENTLY`. This avoids the original volatile-default table rewrite and write-blocking index build while preserving the final `NOT NULL` column, generated default, and index.

### Security

- The two HTTP sidecars (`ytmusic-streamer`, `tidal-downloader`) now require inbound authentication (roadmap F31, ⚠️ breaking). Both mount an app-wide FastAPI dependency that rejects any request without the matching `x-internal-secret` header and **fails closed** when `INTERNAL_API_SECRET` is unset (403), mirroring the backend's F30 internal-auth guard; `/health` stays exempt so k8s probes and the backend's own health checks keep working, while the FastAPI schema/docs routes (`/docs`, `/redoc`, `/openapi.json`) — registered outside the auth dependency's reach — are disabled outright (404) so they can't disclose the API schema unauthenticated. `ytmusic-streamer` additionally validates the `user_id` query param (`[A-Za-z0-9_-]{1,64}`, else 400) before building any credential-file path, closing a path-traversal hole in `/auth/restore` and `/auth/clear`. The backend now sends the shared secret (sourced via `config.ts`) on all four sidecar clients plus the previously-bare TIDAL `/user/auth/status` probe. `docker-compose.yml` and the Helm chart wire `INTERNAL_API_SECRET` into both sidecars automatically; custom deployments must set it to the same value on the backend and both sidecars or sidecar calls fail closed — see `docs/UPGRADING.md`.
- Every build-time ML model download now verifies a pinned sha256 digest and fails the build on mismatch, across all three Dockerfiles that fetch models (`services/audio-analyzer/Dockerfile`, `services/audio-analyzer-clap/Dockerfile`, and the root AIO `Dockerfile`, which duplicates both) — a compromised, MITM'd, or silently re-published upstream artifact can no longer be baked in as model weights undetected (roadmap F38). The CLAP checkpoint download (per-service + AIO) also switched from the mutable `resolve/main` Hugging Face ref to an immutable pinned repo commit. Corrected two stale size comments discovered while measuring the digests: the CLAP checkpoint is actually 2,352,471,003 bytes (~2.35 GB), not the repo's previous "~600MB" comment; the 10 Essentia `.pb` models total ~4MB, not "~200MB".

## [1.8.0] - 2026-07-10

### Added

- Queue ("Now Playing") drag-and-drop reordering (#51): the grip handle on each upcoming queue row — previously decorative — now actually drags, with the same hover-reveal handle, drop-indicator line, and pure drop math as playlist reordering. Podcast episode rows in the queue gained the same handle. Reorders route through a new `moveQueueItem` primitive shared with the Move up/down actions, which also fixes a latent bug: the old move handlers didn't remap the shuffle order, so moving tracks while shuffle was on silently corrupted which tracks would play next. Upcoming items only (the playing row and history stay fixed) and disabled in Listen Together sessions, matching the existing move semantics.

### Fixed

- Queue auto-advance can no longer land on a silently paused next track (#53). Track-end advancement now *declares* play intent — the end handler stamps a bounded (30s) intent that the next load consumes for its autoplay decision — instead of inferring it from transient UI playing state, which raced the element's `pause`→`ended` event pair under the native engine (the element's pause fires before ended, so both the isPlaying mirror and `engine.isPlaying()` could read false by load time). And when autoplay is rejected with `NotAllowedError` in a hidden tab (auto-advance while tabbed away), the native engine now retries `play()` once on the hidden→visible transition instead of sitting silent until a user gesture; the one-shot gesture retry stays armed as the fallback, and a user pause in between is respected.
- Clearing the queue actually sticks now (#52). `DELETE /api/playback-state` removed only the caller's device row, while `GET /api/playback-state` still fell back to the shared pre-device `legacy` row and opportunistically re-migrated it onto the device — so the next playback-state poll resurrected the entire cleared queue within a minute. An explicit clear now deletes the legacy row along with the device row; the GET fallback's legacy migration for genuinely new devices is unchanged.
- Repaired the five backend radio test failures that shipped silently with 1.7.0's generation-diversity work (#46): the library route tests' config mock lacked the new `generationDiversity` block, their mock chains didn't account for the diversify stage's artist lookup query, and the vibe random-filler matcher still required the `take` parameter that #46 replaced with uniform sampling. The backend "Tests + Coverage" job is a non-blocking visibility job, so the failures never turned a run red — worth revisiting alongside the CI gating gap tracked in #54.

### Changed

- The native `<audio>`-element engine is now the **default** playback engine for everyone (`DEFAULT_STREAMING_ENGINE_MODE = "native"`), after soaking as the 1.7.0 opt-in. Deployments with no `STREAMING_ENGINE_MODE` set switch to the native engine on upgrade; set `STREAMING_ENGINE_MODE=howler` to stay on the legacy engine (it remains fully supported as the gated fallback, and Android WebView deployments are still pinned to it automatically). The container entrypoints and docs now report `native` as the primary default.

## [1.7.0] - 2026-07-10

### Added

- Contributor toolchain baseline (#8): a root `package.json` provides one-command orchestration — `npm run setup` (contract build + both app installs, in the right order), `npm run verify` (reproduces every CI gate: backend coverage, frontend lint/build/coverage, helm render) — and the required Node version is now declared everywhere (`engines: >=20.9.0` in all three packages, `.nvmrc` pinned to 24). The root package is deliberately not an npm workspace so per-package lockfiles, Docker image layer caching, and CI stay untouched; full workspace conversion remains open under #8.
- Playlist reordering (#27): playlist owners can drag tracks by the grip handle that appears on row hover (desktop), or use the Move up / Move down / Move to top actions in each row's overflow menu (all devices, and the accessible path). Reorders apply optimistically and persist through the existing `PUT /api/playlists/:id/items/reorder` endpoint.
- Native `<audio>`-element playback engine as a fourth pluggable backend (#42), opt-in via `STREAMING_ENGINE_MODE=native` (Howler remains the default and the gated fallback). The engine owns a single audio element for its whole life — assigning `src` synchronously stops the old stream before the new one exists, which makes double-play structurally impossible within the engine — and keeps all playback decisions in a pure, unit-tested state machine (`nativeAudioElementPolicy`). It uses native `ended` for end detection (works under background timer throttling), queues seeks issued before readiness (podcast/audiobook resume-at-position), suppresses stale positions with a 300 ms seek mark instead of lock timers, bounds all automatic retries so they exhaust into an explicit error, arms exactly one gesture retry on autoplay `NotAllowedError`, classifies stale-token errors after a long pause separately from genuine network failures (recovering by reloading the source at position), and preserves media on background network errors so the existing foreground recovery can retry. Engine selection precedence is explicit and tested: Android WebView stays pinned to Howler (crackling fix), and the Tauri auto-upgrade never fires while native mode is active. The one sanctioned `AudioContext` path is a lazily-established bridge gated to iOS standalone PWAs only (WebKit bug 261858); desktop/Android/iOS-Safari keep the bare-element hi-res pipeline. Listen Together followers no longer autoplay track loads from local playing state — follower playback starts exclusively via the synchronized play-at/delta resume, eliminating an audible blip of track-start audio before the ready gate paused it on every follower track change. All playback client metrics are now tagged with `engineMode` (the deployment flag / rollout cohort) and `activeEngine` (the engine actually driving playback at the moment of the event — the two legitimately diverge under platform pins, the Tauri upgrade, and per-source videojs routing), so the two engines are comparable during soak and selection-policy anomalies are visible. See `docs/NATIVE_AUDIO_ENGINE.md`.
- Worker event-loop stall watchdog (#43), with two attribution paths. Stalls the loop recovers from: the worker samples `monitorEventLoopDelay` and, when a stall exceeds the warn threshold (default 1s, `WORKER_EVENT_LOOP_WARN_MS`), logs the Bull jobs active at that moment. Stalls that end in a liveness kill: the watchdog's interval can never fire while the loop is pegged, so the heavy queues (`worker-scheduler`, `library-scan`) log an unconditional `job-start` breadcrumb — the last log line before the kill names the culprit. Sample cadence is configurable via `WORKER_EVENT_LOOP_SAMPLE_MS` (default 5s).

### Fixed

- Genre radio, auto-mixes, and every other generated queue are no longer dominated by the same 1-3 artists (#46). All generation surfaces now select through one shared damped-proportional artist allocator (each artist weighs `n^alpha`, default alpha `0.5`, under a hard per-artist ceiling, default 30% of queue size — both env-tunable via `GENERATION_ARTIST_WEIGHT_ALPHA` / `GENERATION_ARTIST_SHARE_CEILING`), so large discographies still carry more weight than one-hit wonders without ever being a majority. Pool construction biases fixed everywhere: genre radio prefers track-level genre evidence (Last.fm track tags, Essentia) over whole-discography artist tags and samples pools uniformly instead of taking a deterministic unordered slice (decade/mood/workout/discovery/favorites radio and the vibe fallbacks likewise); the mix artist-cap's refill-after-relaxation no longer un-caps itself (a shorter diverse playlist beats a full-length dominated one); mood buckets sample a 500-track quality band instead of a deterministic top-100; the Subsonic `getSongsByGenre` alphabetical slice became a day-stable seeded shuffle (pagination stays coherent within a day); and the frontend's no-op client-side "diversifier" was removed (diversity is enforced server-side). Daily/weekly mixes remain deterministic per seed. The playlist-diversity baseline script now also asserts the weighting bound on its artist-skewed stratum.

### Changed

- The Helm chart's backend-worker liveness probe gets busy-loop headroom: `timeoutSeconds` 10 → 25 and `failureThreshold` 3 → 4 (~2 minutes of sustained event-loop saturation before a kill, up from ~90 seconds). `/health/live` answers unconditionally, so probe timeouts indicate a busy single-threaded worker, not a dead one; true deadlocks still get killed.

## [1.6.1] - 2026-07-08

### Fixed

- The empty-string overwrite hazard is closed for **all** stored secrets, not just TIDAL. `POST /api/system-settings` now treats every encrypted secret field (`lidarrApiKey`, `lidarrWebhookSecret`, `openaiApiKey`, `fanartApiKey`, `lastfmApiKey`, `audiobookshelfApiKey`, `soulseekPassword`, `spotifyClientSecret`, `ytMusicClientSecret`) as write-only with explicit semantics: a non-empty value replaces the secret, an empty string is a no-op (so a settings-form round-trip can never wipe a stored credential), and `null` explicitly clears it. The guard iterates the canonical `ENCRYPTED_SETTINGS_COLUMNS` list, so future secret columns are covered automatically, and the post-save consumers (`.env` file sync, Lidarr webhook auto-configuration) resolve the same effective values — previously the `.env` sync wrote `null` over `LIDARR_API_KEY`/`FANART_API_KEY`/`OPENAI_API_KEY`/`AUDIOBOOKSHELF_API_KEY` on the identical empty-string round-trip. Note: clearing a secret from the settings UI (by emptying the field) is no longer possible — disable the service instead, or send an explicit `null` via the API. The Soulseek connection is also no longer bounced when the settings form round-trips an empty password.
- Library scans no longer starve the worker's event loop and get the worker killed. The 1.6.0 opus-duration fix made every file pay for a full-file `duration: true` parse; with the scanner's 10-way concurrency a large scan pegged the single Node thread for minutes, so Bull couldn't renew job locks ("Missing lock"/"job stalled" errors, scans endlessly re-queued) and the liveness probe timed out until the kubelet killed the worker — on repeat, on both replicas. The scanner now does a cheap header-only parse first and pays for the full-file parse only when the header lacks a duration (ogg/opus, e.g. YouTube downloads), preserving the 1.6.0 fix at a fraction of the cost.
- "Remove from playlist" works again (#34). The playlist page reads through the React Query cache, but the remove handler never updated or invalidated it after the DELETE succeeded, so the track stayed visible with no feedback (its sibling pending-track handler invalidated correctly, which is why only regular removals appeared broken). The removed row now disappears from the cache immediately (matching the backend's item-id-first/track-id-fallback semantics), the playlist is refetched for authoritative state, and a failed removal now shows an error toast instead of being logged silently.
- The "When Primary Source Fails: Skip" setting is now honored when the primary download source is unavailable *before* dispatch. Previously the album download processor silently rerouted to any other available source (which is how downloads configured TIDAL-primary-with-Skip ended up in Lidarr); now an unavailable primary with Skip fails the job with a clear error, an explicitly configured fallback is dispatched only if that fallback service is itself available (failing the job otherwise, even when a third source is up), and only legacy settings rows with no stored fallback preference keep the old auto-detect rerouting. Pre-existing limitation, unchanged by this fix: manual album downloads have two dispatch pipelines (TIDAL, and the Lidarr-backed download manager), so a non-TIDAL selection — including a `soulseek` fallback — is still executed by the Lidarr-backed manager.
- Saving system settings can no longer silently wipe the admin TIDAL download connection. `POST /api/system-settings` previously accepted `tidalAccessToken`/`tidalRefreshToken`/`tidalUserId` and wrote whatever the settings form round-tripped — so any Save from a page loaded before (or without) the device auth overwrote the stored tokens with empty values, after which downloads silently rerouted away from TIDAL. These credential fields are now ignored by the general settings save and are managed exclusively by the `/api/system-settings/tidal-auth` device flow.

### Security

- `GET /api/system-settings` no longer returns decrypted TIDAL access/refresh tokens to the browser. The response now carries a `tidalConnected` boolean instead, and the settings UI derives TIDAL connection status from it (previously it inferred "connected" from `tidalUserId`, which survives a token wipe and could show a connected state with no working credentials).

## [1.6.0] - 2026-07-08

### Added

- YouTube URL paste support on the search page: paste any YouTube link to stream it instantly or — as an admin — download the audio into your music library for offline listening (great for long DJ sets). Downloads run as background jobs with live progress on the preview card; the server watches each job and imports the file with a library scan when it finishes, even if you navigate away mid-download. Pasted-video playback survives queue restore and cross-device resume. Requires the ytmusic-streamer sidecar with the shared music volume mounted (`/music`, configurable via `YT_DOWNLOAD_DIR`); Helm deployments need an RWX music volume in multi-node clusters.
- Coarse feature flags for the ML/recommendation subsystems, all defaulting ON: `AUDIO_ANALYSIS_ENABLED` (audio analysis queueing, mood buckets, `/api/analysis`, `/api/vibe`), `DISCOVERY_ENABLED` (Discover Weekly cron/processors, `/api/discover`, `/api/recommendations`), and `AUTO_PLAYLISTS_ENABLED` (Made For You mixes, `/api/mixes`). Disabled prefixes stay rate limited and return `404` with `code: FEATURE_DISABLED`, the matching background workers are not registered, and enrichment completion ignores audio/CLAP work while audio analysis is off. The CLAP analyzer machine callbacks (`/api/analysis/vibe/failure`, `/api/analysis/vibe/success`) remain mounted so in-flight analysis work can still report results.
- `GET /api/system/features` now reports the configured `audioAnalysis`, `discovery`, and `autoPlaylists` flags alongside the detection-based fields; the frontend hides the corresponding home and Explore sections (Recommended, Discover Weekly, mixes, mood pills, mix Refresh actions), pages (`/discover`, `/mix/[id]`, `/vibe`), and TV Discovery nav link when a flag is off.
- Helm chart values `config.features.audioAnalysis` / `config.features.discovery` / `config.features.autoPlaylists` (default `true`) that render the new env vars on the backend, backend-worker, and AIO workloads.
- Mixed-media play queue: podcast episodes and music tracks now coexist in one queue. Queue music behind a playing episode (or queue episodes behind music) without interrupting what is playing; next/previous and auto-advance walk the queue across media types.
- "Play next" and "Add to queue" actions for podcast episodes via a new episode overflow menu on the podcast page (blocked inside Listen Together sessions, which remain music-only).
- Player queue panels (overlay player and `/queue` page) render episode entries with podcast cover art and show titles, and can play or remove them like tracks.
- Persisted playback state (server and local) round-trips mixed queues; queues saved by older clients are migrated as music tracks automatically.

### Fixed

- Invite-code registration is now race-safe. The use-count check and increment were separated (check read before the transaction, increment unconditional), so two concurrent registrations on a single-use code could both succeed and push `useCount` past `maxUses`. Consumption is now an atomic conditional update (`useCount < maxUses`) inside the registration transaction; if no use remains the transaction aborts and no account is created.
- The `library-scan` queue no longer grows Redis unbounded. Most enqueue sites added scan jobs without retention options, so completed/failed records accumulated forever. The queue now defaults to keeping the last 100 completed (still enough for the recent-job status lookup) and 200 failed jobs.
- Discover Weekly generation failures are no longer recorded as success. The job processor swallowed exceptions (Last.fm/MusicBrainz outage, no seeds, DB error) into a resolved `{ success: false }` payload, so Bull marked the job `COMPLETED`, never retried it, and it was invisible in bull-board. The processor now re-throws, and the `discover-weekly` queue retries up to 3× with exponential backoff. The default recommendation path is idempotent per (user, week), so a retry replaces rather than duplicates the batch.
- Auto-generated mixes (High Energy, Late Night, Happy, Melancholy, Dance Floor, Acoustic, Instrumental, mood, Road Trip, Key Journey) now shuffle with a seeded Fisher-Yates instead of a biased `Array.sort()` comparator that returned a stateful value — a non-transitive comparator V8 evaluates into a skewed, non-uniform ordering. Mixes stay deterministic per day; Key Journey now seeds each musical key independently so per-key picks aren't correlated.
- Audio file streaming uses `stream.pipeline()` instead of a raw `pipe()` with hand-rolled teardown, so read errors and client disconnects propagate and destroy both streams cleanly (a client aborting mid-stream is no longer logged as a server error). Soulseek download timeout cleanup and post-download verification no longer block the event loop with synchronous `fs` calls (`existsSync`/`unlinkSync`/`statSync` → async `rm`/`stat`).
- Bulk YouTube downloads (paste a channel/playlist → "Download all") now land coherently instead of scattering. A **channel** download is collapsed under one artist (the channel) — its videos no longer fragment across per-DJ artists or "Unknown Artist" — by stamping the channel as artist/album-artist/album. A **playlist** download keeps each track's native artist, since playlists are commonly multi-artist collections, so the real artists are preserved. Either way the tags are written with ffmpeg (stream copy, no re-encode) rather than mutagen, because mutagen-written Vorbis tags were silently unreadable by the library scanner's metadata parser and kept those files from importing at all.
- The library scanner now reads opus/ogg track durations (`parseFile` is called with `{ duration: true }`), fixing YouTube-downloaded (and other opus) tracks that imported with a 0:00 run-time.
- Service-worker image cache keys no longer include the rotating auth token, so cached cover art survives the daily token rotation instead of being re-downloaded every 24 hours.
- Pausing playback while the lazy-loaded Video.js engine chunk is still downloading now completes the pending track load with autoplay suppressed (instead of silently dropping it), and pressing play during the download starts the queued track once ready rather than restarting the previous source from position 0; stopping still cancels the pending load, and the previously playing track is halted immediately when a segmented stream is selected.
- The custom server's backend proxies (`/api`, `/rest`, Listen Together socket) now register their error handlers through the http-proxy-middleware v3 `on.error` API, restoring the structured 503 JSON response (`{ error, code }`) when the backend is unreachable — the previous v2-style `onError` option was silently ignored, so clients received hpm's plain-text default error instead.
- Playing an episode from the podcast page while a queue is active now merges the episode (plus its not-yet-queued newer episodes) into the queue after the current item instead of replacing the whole queue, so queued music survives.
- Skipping away from an episode before its saved-progress lookup finishes no longer seeks (and seek-locks) the newly playing item to that episode's resume position.
- Skipping away from a playing episode (next/previous, play-now, queue jump, or picking another episode) now saves its listening position first, so manual skips no longer silently lose up to ~30s of podcast progress.
- Advancing the queue into a partially-listened episode now waits for the saved-progress lookup (bounded by a 2s budget) and starts the stream at the resume position, instead of starting at 0:00 and racing a post-load seek that could be dropped.
- Completed YouTube downloads no longer enqueue one full-library scan **each**: scans are coalesced so a bulk playlist/channel download triggers at most one queued scan at a time, plus exactly one follow-up scan for files that finish while a scan is already running (previously a 200-item "Download all" queued ~200 serial full-library rescans).
- Albums are now resolved by **release-group MBID first** during scans, so two different albums that share a title (e.g. two self-titled albums by different artists in a compilation-heavy library) no longer merge into one. Albums wrongly merged by the 1.5.0-and-earlier logic do not separate on a routine rescan (unchanged files are skipped) — force a full re-scan (or touch the files) to apply the corrected grouping retroactively.
- The library scanner no longer crashes (and no longer flags files `UNREADABLE_METADATA` on every rescan) when a tagged file's release group already exists under a different artist row — common for compilations without `albumartist` or inconsistent "A & B"/"B & A" artist tags. The artist-scoped album lookup now falls back to the global release-group MBID lookup, and album creation recovers from unique-constraint races the same way artist creation already did.
- Untagged files in a folder whose tagged siblings created a real album no longer split into a duplicate same-titled album; they now title-match the artist's existing albums. The same forced-full-re-scan note as above applies for retroactive fixes.
- Disabled ML subsystems answer with their documented contract again: with `AUDIO_ANALYSIS_ENABLED=false`, `/api/analysis/*` returns `404` with `code: FEATURE_DISABLED` instead of `403` (the internal-secret guard is now scoped to the two CLAP callback routes rather than the whole router).
- Removing the currently-playing last queue item no longer silently discards the playing episode's listening position; the next item starts through the shared resume path (partially-listened episodes resume instead of restarting at 0:00).
- Queueing an album while a podcast episode is playing with shuffle on now actually shuffles the seeded queue (it previously seeded sequential play order).
- Rapidly pressing next past a podcast episode now works: the queue index advances immediately instead of blocking on the episode's saved-progress lookup (which could hold the skip for up to 2s and re-land on the same episode), and two rapid "Add to queue" actions no longer produce a shuffle order that skips one of the added items.

### Changed

- Cover art is now resized server-side to the requested size (snapped to a 64–768px allowlist, never upscaled) and served as WebP when the browser supports it, instead of shipping multi-megapixel originals to thumbnail-sized renders. Resized variants are cached in Redis per size+format for both external and native (on-disk) covers — native variants are keyed by file identity (path, mtime, size) so conditional revalidations are answered without re-decoding.
- All `/api` traffic is now streamed through the custom server's proxy (like `/rest` and the Listen Together socket) instead of being buffered by a Next.js route handler, preserving backend gzip compression and response streaming. The route handler remains as a fallback.
- The Video.js segmented-playback engine is lazy-loaded only when a DASH/segmented stream is selected, removing ~730 kB of JavaScript from every page's first load (home route JS: 2065 kB → 1336 kB).
- Social presence and notification/download polling now pause while the app tab is hidden and refetch immediately when it becomes visible again, cutting background network chatter on mobile.
- Docker Compose (split-stack `backend`/`backend-worker` and AIO) now forwards the `AUDIO_ANALYSIS_ENABLED`, `DISCOVERY_ENABLED`, and `AUTO_PLAYLISTS_ENABLED` feature flags from `.env` (default `true`), so setting them actually reaches the containers — previously only Helm deployments could use the flags advertised in `.env.example`.
- The custom server's streaming `/api` proxy honors the configurable time-to-first-byte timeouts again: `PROXY_REQUEST_TIMEOUT_MS` (default 20s) and `PROXY_IMPORT_PREVIEW_TIMEOUT_MS` (default 90s), answering `504` with `code: UPSTREAM_TIMEOUT` like the previous route handler — the proxy migration had silently replaced them with a fixed 120s inactivity timeout and a `503`.

### Security

- The `ALLOWED_ORIGINS` allowlist is now **enforced**. When it is configured, a cross-origin request from an unlisted origin is denied instead of being logged and reflected back anyway (which, combined with `credentials: true`, silently made the knob a no-op). Behavior is unchanged for the self-hosted default: with no `ALLOWED_ORIGINS` set, all origins are still allowed. The origin decision is now a unit-tested `isOriginAllowed` helper.
  - **Upgrade note:** `docker-compose.yml` ships `ALLOWED_ORIGINS` with a localhost-only default (`http://localhost:3000,http://localhost:3030`). Deployments using the default same-origin `/api` proxy are unaffected, but if your browser talks to the backend on a **different origin** (`NEXT_PUBLIC_API_URL` set, or `NEXT_PUBLIC_API_PATH_MODE=direct`) and you access the app from a LAN IP or reverse-proxy domain, you must set `ALLOWED_ORIGINS` to include that origin or API requests will fail CORS preflight after upgrading.
- `ALLOWED_ORIGINS` enforcement now also covers the credentialed CORS paths that reflected any request origin: audio stream responses (`audioStreaming`), cover art responses (`/api/library/cover-art`), and the Listen Together socket.io HTTP long-polling transport. Unset-`ALLOWED_ORIGINS` (self-hosted default) behavior is unchanged: all origins allowed. In all three paths, "denied" means the CORS response headers are omitted — the request itself is still served, so same-origin traffic and requests proxied through the frontend server are unaffected by the allowlist; only genuinely cross-origin browser access from an unlisted origin is blocked (by the browser). Note that WebSocket connections are not subject to CORS at all; the Listen Together socket does not rely on origin checks there — its handshake requires a JWT supplied by application JavaScript (`handshake.auth.token`, never a cookie), which cross-site pages cannot obtain.
- YouTube downloads are now **admin-only, enforced server-side**: `POST /api/youtube/download`, the download status/list endpoints, and cancel all require the admin role (streaming and URL preview remain available to every authenticated user), matching the app's existing downloads model. The download buttons, "Download all", and the YouTube downloads view are hidden for non-admin users, and non-admins no longer poll the downloads endpoints.
- The ytmusic-streamer sidecar no longer accepts a caller-supplied `output_dir` on `/yt/download`; files are always written under the configured `YT_DOWNLOAD_DIR`. The backend additionally validates the YouTube `videoId` format (`[A-Za-z0-9_-]{11}`) before contacting the sidecar.
- External cover art fetching now caps the response size (15 MB) while streaming and decodes with an explicit sharp `limitInputPixels` (50 MP), so an oversized or decompression-bomb image fails fast instead of exhausting pod memory.
- Internal CLAP analyzer callbacks (`/api/analysis/vibe/failure`, `/api/analysis/vibe/success`) now **fail closed**. The shared-secret check is enforced by a dedicated `requireInternalSecret` middleware that rejects every request when `INTERNAL_API_SECRET` is unset — previously an unset secret combined with a missing header satisfied `undefined !== undefined` and bypassed authentication entirely — and compares the provided secret in constant time.
- Device linking (`POST /api/device-link/verify`) is now race-safe and rate-limited on the stricter tier. The unauthenticated endpoint checked `usedAt`, created a full-privilege API key, then separately marked the code used — with no transaction, so two concurrent verifies of one code could both pass the check and both mint a key (TOCTOU). The code is now claimed with an atomic conditional update (`usedAt: null`) inside a transaction before any key is minted; only the request that wins the claim issues a key, and a lost claim rolls back and returns `400` without creating one. The route also moved from the lenient general `apiLimiter` to `authLimiter`, matching its sensitivity as an unauthenticated credential mint.
- The Helm chart no longer regenerates secrets on every upgrade. `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and `POSTGRES_PASSWORD` used a bare `default (randAlphaNum …)`, which re-rolls on every `helm upgrade` — a routine upgrade invalidated all sessions/JWTs, made every AES-encrypted setting (Lidarr/OAuth/Subsonic/2FA) undecryptable, and desynced the Postgres password from an initialized data dir. The chart now looks up the existing in-cluster Secret and reuses its values, generating only on first install (precedence: explicit `secrets.*` → live Secret value → generated). Installs using `secrets.existingSecret` or pinned `secrets.*` are unchanged. See `docs/UPGRADING.md` for recovery steps if a prior upgrade already rotated your keys.
- Stored settings (integration API keys, OAuth tokens, 2FA/Subsonic secrets) are now encrypted with **authenticated AES-256-GCM** behind a versioned envelope (`v2:…`) and a per-value scrypt key derivation that uses the full key entropy. Decryption of a `v2` value now **fails closed**: a tampered or forged ciphertext throws instead of being returned as cleartext, and the previous CBC format silently truncated the documented 44-char key to 32 chars. Existing legacy (`v1`/AES-CBC) data still decrypts unchanged, and every save re-writes a value as `v2`, so the migration is transparent. A new admin endpoint `GET /api/admin/secrets-status` reports how many values are still on the legacy cipher, and `scripts/migrate-settings-to-gcm.ts` re-encrypts them in bulk (forward-only, dry-run by default). See `docs/UPGRADING.md`.
- The Lidarr webhook (`POST /api/webhooks/lidarr`) is now **rate-limited** (it was completely unthrottled) and **no longer triggers an unconditional full-library scan per event** when a download doesn't match a known job — previously a stream of unmatched webhooks could spam expensive full scans on an unauthenticated, reachable endpoint. Unmatched (external) imports still get scanned, but through a **coalesced** scan: a stable queue job id collapses any burst of webhooks into a single queued scan (there is no periodic scan to fall back on, so dropping the scan entirely would strand external imports). The webhook secret check stays fail-closed when a secret is configured; when none is set the request is still accepted (to avoid silently breaking existing Lidarr integrations) but is now rate-limited and logs a loud warning urging you to configure one. See `docs/UPGRADING.md`. (Making secret auth the hard default — which requires auto-generating the secret and reconfiguring Lidarr — is tracked as a follow-up.)
- The outbound-URL (SSRF) guard now **resolves DNS and range-checks every resolved IP** at the points the backend fetches an untrusted URL: podcast/RSS feed fetches (each redirect hop is followed manually and re-validated), the image proxy and its redirect hops, and podcast cover downloads (redirects disabled). The previous check was string-only, so a public-looking hostname whose DNS records point at a private/loopback/link-local address sailed through. The blocked ranges now cover all of `127.0.0.0/8` and `0.0.0.0/8` (previously only the exact literals `127.0.0.1`/`0.0.0.0` were rejected, so e.g. a DNS answer of `127.0.0.53` passed). Admin connection tests (Lidarr, Audiobookshelf, etc.) intentionally keep the string-only check so Docker-network and LAN hostnames keep working — those endpoints are admin-only. Residual: resolution happens at check time (DNS-rebinding window); pinning the resolved IP into the request agent is a tracked follow-up.
- Session cookies are now **`secure` by default in production**, and the reverse-proxy trust level is configurable. The cookie `secure` flag was opt-in via a raw `process.env.SECURE_COOKIES === "true"` (defaulting off), so a production deploy that forgot the flag silently shipped non-secure cookies; it now defaults to `true` when `NODE_ENV=production` and is resolved through `config.ts` (set `SECURE_COOKIES=false` for an HTTP-only local-network deploy). `trust proxy` was hardcoded to `true` (trust every hop), which let a client spoof `X-Forwarded-For` to evade per-IP rate limits; set `TRUST_PROXY_HOPS` to your real reverse-proxy depth (usually `1`) for spoof-resistant client-IP resolution. The default remains trust-all to preserve existing multi-hop setups. (Helmet already ships CSP and HSTS by default — unchanged.)
- JWT verification now **pins the algorithm** to `HS256`. All auth-class `jwt.verify` call sites (auth middleware, the `/api/auth/refresh` route, onboarding, and the Listen Together socket) pass `algorithms: ["HS256"]` so a token can never be accepted under a different or `none` algorithm. (The segmented-streaming session-token verifies use a separate `SESSION_TOKEN_SECRET` and are tracked under F37.) The `/refresh` route previously re-read the secret inline as `process.env.JWT_SECRET || process.env.SESSION_SECRET!` and cast the result to `any`; it now goes through a shared `verifyAuthToken` helper that resolves the secret from one validated source and returns a typed payload. Existing tokens (already HS256) are unaffected.
- API keys are now stored as a **keyed hash (HMAC-SHA256) at rest** instead of verbatim, so a read-only database exposure (a dump, a replica, a raw-query slip) yields only hashes, not working credentials. Validation hashes the presented key and looks it up by hash; **existing device keys keep working with no re-pairing** thanks to a transitional plaintext-lookup fallback. New keys are hashed before insert and the raw value is shown only once at creation. `GET /api/admin/secrets-status` also reports hashed-vs-plaintext key counts, and `scripts/hash-existing-api-keys.ts` migrates legacy rows in bulk (forward-only, dry-run by default). The hash pepper resolves from `API_KEY_PEPPER` → `SETTINGS_ENCRYPTION_KEY` → `ENCRYPTION_KEY` (compat alias) → `SESSION_SECRET`, and `secrets-status` exposes an `apiKeys.pepperFingerprint` (an 8-hex identifier of the pepper *value*) that must match the migration script's logged fingerprint before running it with `--apply`. See `docs/UPGRADING.md`.

## [1.5.0] - 2026-03-27

### Added

- Share links for tracks, albums, and playlists: generate tokenized links from the 3-dot track menu or album header. Links support optional expiry dates and max-play limits. Anyone with the link can listen without an account.
- Public share pages with a two-panel overlay-player layout — large album art on the left, live queue on the right — matching the authenticated player experience.
- Share pages auto-load and play the first track immediately on open; the bottom mini-player is always visible.
- Cover art and track title/artist in the share page left panel update as the queue advances, reflecting the currently playing track.
- Play-count limits work per page load (one count per visit) rather than per individual stream, so albums and playlists with max-play limits behave as expected.
- Per-track download buttons and a "Download All" action that streams the entire share as a single ZIP archive.
- Playlist shares additionally offer JSON and M3U export.
- Share-link modal lists all active links for the current resource and lets users revoke them inline.
- Admin enrichment repair endpoint (`POST /api/enrichment/repair-covers`) clears stale Cover Art Archive `NOT_FOUND` cache entries for albums with missing covers.
- Full-text search stop-word fallback: queries made up entirely of common words (e.g. "the", "a") now fall back to partial matching instead of returning empty results.
- Health endpoint now includes `version`, `uptimeSeconds`, and per-dependency `latencyMs` for operator diagnostics.
- Backend branch coverage improved from ~80% to ~83% across a broad set of routes and services.

## [1.4.0] - 2026-03-15

### Added

- Exploratory alternate playback-backend work for environments where browser audio output is limited, including a Rust playback path for true hi-res output where Chromium caps audio at 48 kHz.
- Audio engine factory that selects the best playback backend at runtime while keeping standard web audio as the default browser experience.
- Vibe map page (`/vibe` Map tab) with an interactive 2D scatter plot of the library's CLAP embedding projections, color-coded by dominant mood, backed by a cached `/api/vibe/map` UMAP worker with a circular fallback for very small libraries.
- Vibe discovery endpoints: song-path (`GET /api/vibe/path`) for interpolated musical journeys between two tracks, and alchemy (`POST /api/vibe/alchemy`) for blending multiple track embeddings into new vibe discoveries.
- M3U and M3U8 file import with deterministic local-library matching (file path, filename, exact metadata, fuzzy metadata tiers) and a preview endpoint (`POST /api/import/m3u/preview`, 2 MB limit).
- Generic background import jobs with dedicated persistence, lifecycle APIs (`/api/import/jobs` for submit, dedup/reconnect, status, list, cancel), and detached execution — independent of the existing Spotify-specific import flow.
- Activity panel Imports tab showing background import job progress, cancellation, and playlist links for completed jobs.
- Admin Library Health section showing tracks flagged as missing from disk or having unreadable metadata during library scans.
- Podcast bulk refresh (`POST /api/podcasts/refresh-all`) processing all subscribed feeds with conditional-GET and per-feed error isolation.
- OpenSubsonic bookmark persistence: `getBookmarks`, `createBookmark`, and `deleteBookmark` now store per-user track positions and return real bookmark payloads instead of no-op responses.
- Sleep timer hook with preset durations (15/30/45/60/90/120 min) and formatted countdown for upcoming player control integration.
- Architecture overview, data model reference, and feature index added to project documentation.

### Changed

- Import page now supports both streaming-service URL imports and local M3U/M3U8 file uploads with a tabbed input interface, and offers a "Run in Background" option for URL imports.
- Add-to-playlist picker now supports multi-select mode for adding a track to multiple playlists in one action.
- Podcast subscriptions now persist feed `ETag` and `Last-Modified` validators, and refresh reuses them for conditional GETs so 304 responses skip unnecessary episode rewrites.
- Last.fm no longer ships with a bundled fallback application key; operators must provide `LASTFM_API_KEY` via environment or System Settings.
- Outbound URL safety checks centralized through a shared validator, newly blocking IPv6 loopback, link-local, and unique-local redirect targets.
- README architecture diagram updated to reflect current system layout.

### Fixed

- Admin Library Health now loads and dismisses health records through dedicated `/api/admin/library-health` endpoints instead of failing on a missing backend route.
- Library validation no longer deletes unrelated health records (e.g. `UNREADABLE_METADATA`) when clearing `MISSING_FROM_DISK` entries for tracks that reappear on disk.
- Generic import job cancellation now uses an intermediate `cancelling` state so late cancellations after playlist creation record the completed playlist instead of discarding it.
- Vibe map mood colors now match the actual mood keys emitted by the backend projection payload.
- Listen Together connection indicators no longer flicker grey during brief network reconnects; a 2-second grace period absorbs transient disconnects before updating the UI.
- Volume slider popup in the full player is narrower with better spacing between the slider track and percentage label.
- UMAP projection worker entrypoint now resolves correctly in both tsx source runtime and compiled dist builds.
- AWM cross-review now takes its Codex sandbox mode from workflow/script arguments instead of hardcoding `read-only` in the script.
- AWM cross-LLM review now sends an untrimmed scoped review packet into the nested Codex reviewer so the read-only sandbox no longer depends on inner shell access.

## [1.3.4] - 2026-03-09

### Added

### Changed

- Maintainer verification now runs through repo-local AWM review and feature-plan validation scripts, adds a semantic targeted frontend coverage check, and standardizes pytest scaffolds across Python sidecars.

### Fixed

- Frontend queued-track ID memoization now stays stable when queue membership is unchanged, reducing queue-derived state churn across local playback and Listen Together sessions.
- Remote liked-track metadata now repairs itself when placeholder-only TIDAL or YouTube entries are liked or replayed, and the background TIDAL repair job no longer depends on whichever unrelated authenticated user happens to sort first in the database.
- Listen Together queue creation and shared-queue additions once again truncate overflow beyond the 500-track cap instead of rejecting oversized requests outright.

## [1.3.3] - 2026-03-07

### Added

### Changed

- Audio session management (auto-unlock, auto-suspend prevention, and navigator audio session type) is now always active on all platforms. The `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED` environment variable has been removed — no configuration is needed for lock-screen playback on iOS or Android.
- Foreground recovery now detects tracks that finished while the screen was locked and advances to the next track instead of replaying the same one.

### Fixed

- Fixed playback not advancing to the next queued track when the phone screen is locked (Android PWA and background tabs). Browsers throttle JavaScript timers when the page is hidden, preventing the audio engine from detecting track completion. The player now listens for the native HTML5 audio `ended` event as a fallback, and foreground recovery on unlock advances to the next track when the current one finished while backgrounded.

## [1.3.2] - 2026-03-06

### Added

- Overlay icons on My Liked and Discover Weekly cards on the Home and Explore pages for clearer visual identity.

### Changed

- Discover Weekly icon changed from compass to lightning bolt across Home, Explore, and Discover hero.
- Discover Weekly and My Liked hero sections now show actual cover art from their first track instead of a placeholder icon.
- My Liked page header simplified to a single cover image instead of a mosaic grid.
- CI image builds consolidated from 8 separate workflows into a single unified pipeline with shared release-tag validation.
- Project tooling migrated from custom agent-config scripts to the AWM control plane, removing ~30k lines of legacy governance scaffolding.
- PR checks updated to use AWM-driven verification for backend coverage, frontend lint/build/coverage, and Helm chart rendering.
- Developer documentation reorganized under `docs/maintainers/` and streamlined across README, CONTRIBUTING, and TESTING guides.
- Backend runtime tests aligned with current API response shapes and behavior.

### Fixed

- Listen Together: fixed a guest recovery race where follower-side stall/handoff recovery could run in parallel with session resync after mid-track buffering, causing doubled playback or unintended stops.
- Library scan now promotes preexisting remote album rows into owned library albums when local files arrive, preventing downloaded albums from staying hidden behind `REMOTE` state.
- Track-mapping reconciliation now sweeps forward through the backlog instead of retrying the same oldest skipped rows forever, so imported provider tracks can switch over to local copies after scan.

## [1.3.1] - 2026-03-05

### Added

### Changed

- Listen Together queue hard-capped at 500 tracks: group creation silently truncates oversized queues to the first 500, and add/insert-next operations are rejected when the cap would be exceeded. The cap is also enforced when restoring groups from the database and when syncing state across backend pods, preventing pre-existing oversized groups from causing issues.
- Listen Together queue inputs are now validated only after truncation, avoiding unnecessary database work for tracks that would be discarded.
- Concurrent audio transcodes for the same track and quality now share a single ffmpeg job instead of spawning duplicates, and the transcoded file cache uses upsert to prevent duplicate-record races.

### Fixed

- Listen Together: fixed a race condition where hard-refreshing the page with a large queue could disconnect the user from the session due to the Socket.IO payload exceeding the buffer limit.
- Listen Together: fixed duplicate resume and recovery races in the playback orchestrator, including follower pause recovery and reconnect delta suppression that could cause playback state to flicker.

## [1.3.0] - 2026-03-04

### Added

- Cross-provider track mapping layer: new `TrackTidal`, `TrackYtMusic`, and `TrackMapping` tables link local library tracks to TIDAL and YouTube Music equivalents with confidence scores and staleness tracking. Active-linkage uniqueness is enforced at the database level.
- Remote track likes: users can now like/unlike TIDAL and YouTube Music tracks. Liked remote tracks appear alongside local likes on the My Liked page with provider badges.
- Remote track playback logging: plays of TIDAL and YouTube Music tracks are now recorded with full metadata, provider source, and the appropriate listen-source type.
- Unified playlist import: the `/import` page now accepts Spotify, Deezer, YouTube Music, and TIDAL playlist URLs in a single flow. A preview step shows per-track resolution status (local match, TIDAL, YouTube, or unresolved) with confidence scores before creating the playlist.
- Remote tracks in playlists: playlist items can now reference TIDAL or YouTube Music tracks directly. Playlist detail pages show provider badges and playability indicators for each track.
- Explore page: merged Home, Browse, Radio, and Discovery into a single `/explore` landing page with For You content (liked summary, Discover Weekly, Made For You mixes), library radio stations, and a provider content section with YouTube Music and TIDAL tabs.
- TIDAL browse surface: full TIDAL discovery with home shelves, explore picks, genres, moods, mixes, playlist detail, and mix detail pages — all accessible from the Explore provider tabs.
- YouTube Music browse surface: home shelves, charts, and mood/genre category browsing with playlist and album detail drill-down pages.
- Per-user provider visibility toggles: new `showYtMusicExplore` and `showTidalExplore` settings control which provider tabs appear on the Explore page.
- Public YouTube Music streaming: new unauthenticated stream and stream-info endpoints allow playback of YouTube Music tracks without per-user OAuth, using the sidecar's public search client.
- Track preview migrated to YouTube Music: artist track previews now return a YouTube Music video ID instead of a Deezer preview URL, with Redis caching.
- Auto-creation of TrackMapping on like/play: `ensureRemoteTrack` now automatically creates a remote-only TrackMapping for every provider row, enabling union-find deduplication without waiting for the background reconciler.
- Orphan reconciliation: a new `reconcileOrphans()` pass finds TrackTidal/TrackYtMusic rows with no active TrackMapping and creates gap-fill mappings for them, running before the existing reconcile pass.
- Background metadata refresh worker: periodically re-fetches metadata from TIDAL/YouTube Music APIs for provider rows that still have placeholder ("Unknown") titles or artists, updating only fields with real values.
- Background reconciliation service: periodically attempts to match remote-only track mappings back to local library tracks using ISRC and artist/title/duration similarity.
- Provider-upgrade reconciliation pass: the track-mapping reconciler now retries YT-only mappings against TIDAL and upgrades successful matches so TIDAL can be preferred in later playback resolution.
- Remote track backfill service: resolves artist and album entities for existing remote tracks that were persisted before the universal artist/album linking was added.
- Listen Together remote track support: queue inputs now accept TIDAL and YouTube Music tracks with full metadata. Playback source resolution picks the best available provider per user based on their OAuth connectivity.
- Multi-seed radio engine: radio generation from multiple seed tracks now computes a centroid feature vector and scores candidates against it, improving variety for artist/album radio.
- Reusable track list components: new shared `TrackList`, `TrackRow`, and `TrackListHeader` components replace per-page inline track tables across playlists, liked tracks, and album pages.
- Cover mosaic component: new `CoverMosaic` renders 2x2 or 3x2 cover art grids, used for playlist headers, radio station cards, and the My Liked hero.
- Radio station cards: extracted radio stations into reusable `RadioStationCard` components with daily-seeded mosaic artwork.
- Browse image caching: TIDAL and YouTube Music browse thumbnails are now cached to disk, reducing repeated external image fetches.
- iOS foreground recovery: automatic playback retry when returning to the app after iOS reclaims the audio session.
- Next-track eager preload: loads the next track before the UI state update cycle, eliminating inter-track silence gaps on iOS.
- Consecutive error circuit breaker: stops auto-advancing after 3 consecutive track failures with a user-facing toast.
- Collection-level like button: playlists and albums now have a heart button that likes/unlikes all tracks in one action.
- Inline playlist rename: playlist owners can click the title on the detail page to rename it directly. Keyboard-accessible with Enter to save, Escape to cancel.

### Security

- Timing-safe secret comparisons: Subsonic token, Lidarr webhook secret, and 2FA recovery codes now use constant-time comparison to prevent timing side-channel attacks.
- Anti-enumeration auth timing: failed login and token auth paths run a dummy bcrypt round to equalize response timing, preventing username enumeration.
- Cryptographic device link codes: link code generation now uses `crypto.randomInt()` instead of `Math.random()`.
- Safe error responses: internal exception details stripped from all API error responses across 13 route files.
- SSRF protection for podcast cover downloads: URL validation blocks private IPs, localhost, and non-HTTP(S) schemes; redirect-based bypass rejected.

### Changed

- Sidebar navigation simplified from 8 items to 5 (Home, Explore, Library, Listen Together, Audiobooks/Podcasts). Browse, Radio, Discovery, and My Liked moved into the Explore page or promoted as sidebar pins.
- My Liked pinned as a top-level sidebar link with a heart icon when the user has liked tracks.
- Home page refocused as a library-centric landing with liked summary, Discover Weekly, and community playlists. External browse content moved to Explore.
- Spotify import is now resolution-only and no longer triggers the downloader/indexer acquisition path.
- Playlist import runs inside a database transaction with duplicate-safe item writes.
- Plays table now supports remote-only entries — `trackId` is nullable with new foreign keys for TIDAL and YouTube Music tracks.
- Playlist items now support remote-only entries — `trackId` is nullable with new foreign keys for TIDAL and YouTube Music tracks.
- Playlist detail responses now resolve each item to the viewer's best available source (`local` > `TIDAL` > `YouTube`) using shared per-user mapping logic, and explicitly mark items unplayable when no connected provider can play them.
- Artist filtering expanded: library artist lists now support `remote` (artists with remote-only tracks) and `all` (library + discovery + remote) filter modes.
- TIDAL user quality cache is now invalidated immediately when the streaming quality setting is changed.
- AIO Docker image optimized: added `.dockerignore` (~1.9 GB build context reduction), production dependency pruning, and `.next/cache` cleanup for smaller images and faster rebuilds.
- Silent exception paths replaced with scoped debug logging across auth middleware, track-mapping reconciliation, and metadata refresh workers.
- Listen Together enforces a 500-track queue limit with a clear error message when starting or updating a session that exceeds it.
- Queue and track lists now use virtualized rendering for smoother scrolling with large collections.
- Polling intervals staggered with random jitter to prevent simultaneous network requests across open pages.
- YouTube Music album, artist, song, and playlist browse no longer require per-user OAuth — content endpoints fall back to public browse automatically when the user has no linked account.
- TIDAL playlist import now tries public browse when the user has no TIDAL account, so imports from shared TIDAL playlist URLs work without authentication.
- YouTube Music playlist import uses authenticated browse when available, falling back to public browse on failure.
- Listen Together now falls back across providers via TrackMapping: if a listener lacks the track's native provider, resolution checks for an equivalent on their connected provider (e.g. a TIDAL-only track can play via YouTube Music, and vice versa).
- Playlist track resolution skips mappings with no usable provider for the current user, allowing cross-provider fallback paths to activate correctly.
- YouTube Music OAuth status checks now cache negative results with a shorter TTL, reducing repeated sidecar calls for users without linked accounts.
- YouTube Music admin settings collapse the OAuth credentials section by default when no credentials are configured.

### Fixed

- Fixed remote stream duration display where TIDAL HI_RES_LOSSLESS fragmented MP4 streams reported only the first fragment's duration (~4 seconds) instead of the full track length.
- Fixed playlist and Subsonic serializers to handle nullable track references safely after the remote-track schema changes.
- Fixed track-mapping batch validation to reject payloads missing all linkage keys.
- Fixed nondeterministic mapping selection by enforcing active-linkage uniqueness and source-priority ranking at the database level.
- Fixed Listen Together to only pause/resume when the remote track actually changes, preventing unnecessary playback interruptions during sync.
- Fixed Listen Together to sync the active group reference and clamp playback indices to valid bounds.
- Fixed TIDAL sidecar DASH MPD parsing and stream segmentation, including prepending the initialization segment and detecting codec from the manifest.
- Fixed remote playback format hints: removed forced format overrides that could interfere with provider stream negotiation, and skip empty TIDAL browse shelves.
- Fixed zero-duration remote track metadata to be accepted as valid instead of failing validation.
- Fixed `/api/docs` trailing-slash handling to prevent redirect loops in the Swagger UI proxy.
- Fixed playlist cursor pagination for liked tracks and hardened playlist URL parsing edge cases.
- Fixed Spotify playlist import resilience when anonymous token endpoints fail by adding embed-row fallback parsing and enforcing local → TIDAL → YouTube resolution priority during import matching.
- Fixed remote track metadata loss on like/play where `ensureRemoteTrack` could overwrite real metadata with placeholders. Incoming placeholder values are now preserved against existing real metadata.
- Fixed reconcile unique-constraint violation where linking an orphan mapping to a local track could conflict with an existing linked mapping for the same provider row. Conflicting orphans are now marked stale instead.
- Fixed playlist import preview client timeout behavior by extending `/api/import/preview` request timeout to 60 seconds for large/slow provider resolution passes.
- Fixed YT metadata refresh to use unauthenticated `__public__` lookups instead of requiring a user OAuth session, so placeholder YT rows can still be backfilled.
- Fixed playlist import TIDAL matching to proactively restore the user’s sidecar session from saved OAuth credentials, so imports no longer depend on visiting another TIDAL surface first.
- Fixed cover mosaic single-image layout where the image could overflow its container bounds.

## [1.2.1] - 2026-02-28

### Security

- Closed an open registration vulnerability where unauthenticated users could create accounts via `/onboarding/register` after the initial admin was set up. Registration is now locked to first-user-only; all subsequent accounts require an admin-issued invite code.
- Removed the dead open-registration page and replaced it with an invite-code-gated registration flow.
- Library deletion and Lidarr integration now default to disabled in new installations, preventing accidental data loss before an admin explicitly opts in.

### Added

- Invite code system: admins can generate time-limited, usage-capped invite codes (1h to 30d, or no expiry). New users register with an invite code, display name, and email. Full CRUD for codes in the admin panel with copy-to-clipboard and revoke.
- Dedicated admin settings page at `/admin` — system configuration is now separate from user settings at `/settings`. Each page has its own sidebar, state, and save button. Non-admins are redirected away from `/admin`.
- Admin navigation links in both the desktop avatar dropdown and mobile sidebar (admin-only visibility).
- User management enhancements: admins can edit usernames, emails, passwords, and roles for existing users directly from the Users section.
- Profile pictures: upload, preview, and remove in Settings > Social. Images are automatically resized to 512x512 JPEG via Sharp. Pictures display in the avatar menu, social activity tab, and settings.
- Playback stats overlay ("stats for nerds") showing real-time codec, bitrate, sample rate, and streaming source during playback.
- API Keys section exposed in user settings so all users can generate and manage personal API keys for programmatic access.
- Show version toggle: admin setting to display the app version in the player bar.
- Library scan shortcut in the avatar dropdown menu, available without navigating to admin settings.
- Login with email: users can now sign in with either username or email address.
- OpenAPI documentation for all 338 non-subsonic backend endpoints via `swagger-jsdoc` annotations. Interactive Swagger UI at `/api/docs`.
- Deployment guide (`docs/DEPLOYMENT.md`) covering Docker Compose configuration, scaling, and production setup.
- Docker Bake file (`docker-bake.json`) for parallel multi-service image builds.
- Playlist `updatedAt` timestamp with backfill migration for existing playlists.

### Changed

- Register page fully redesigned with galaxy background, branded logo/wordmark, and invite code field. Redirects to onboarding if no users exist yet.
- Standardized action button styling across all settings sections — 12 buttons in 7 files changed from gray `bg-[#333]` to the standard white pill style used elsewhere.
- API Keys section restyled to use `SettingsSection` wrapper and standard button conventions instead of the `Button` component with brand-colored variants.
- Subsonic section layout changed from vertical right-aligned to horizontal inline, matching the email/display name row pattern.
- Save status indicator below the floating save button now has a dark backdrop pill for readability over scrolled content.
- Made For You playlist mosaics changed from circular to square with rounded corners, matching album art style everywhere else.
- Sidebar navigation link spacing adjusted to balanced `py-2` / `space-y-1` after earlier over-compression.
- Desktop logo/wordmark bumped 15% larger while maintaining 4:3 ratio. Mobile sidebar wordmark fills available space proportionally.
- Swagger UI is now accessible without authentication; auth is only required for the raw JSON spec endpoint.

### Fixed

- Profile picture serving returned JSON-serialized byte arrays (`{"0":255,"1":216,...}`) instead of binary image data because Express `res.send()` doesn't handle `Uint8Array` from Prisma. Fixed by wrapping with `Buffer.from()`.
- Profile picture avatar never recovered from initial 404 — once `imgError` was set (no picture uploaded yet), it stayed true permanently even after uploading. Added cross-component event dispatch and cache-busting query parameter.
- Library could appear empty in the UI due to the Next.js API proxy double-decompressing gzip responses. Node.js `fetch` auto-decompresses but preserves `Content-Encoding` headers, causing the browser to attempt a second decompression. Fixed by stripping compression-related headers in the proxy.
- Swagger UI returned 401 because `requireAuth` middleware blocked HTML/CSS/JS asset loading on the `/api/docs` route.
- Albums could auto-add to queue on mobile due to pointer event handling on touch devices.
- Settings save could overwrite backend-managed database fields; added guards to prevent this.

### Database Migrations

- `20260227000000` — Add `profilePicture` (BYTEA) column to User table.
- `20260227100000` — Add `updatedAt` timestamp to Playlist table with backfill from `createdAt`.
- `20260228000000` — Add `email` to User (unique), create InviteCode and InviteCodeUsage tables with indexes and foreign keys.
- `20260228100000` — Add `showVersion` boolean to SystemSettings.

## [1.2.0] - 2026-02-27

### Added

- Added experimental segmented streaming across backend/frontend, including `/api/streaming/v1/sessions` routes for create/manifest/segment/heartbeat/handoff.
- Added segmented startup diagnostics capture (`POST /api/streaming/v1/client-metrics`) plus startup baseline tooling (`backend/scripts/measure-segmented-startup-baseline.ts`) and rollout guidance.
- Added a dedicated `My Liked` playlist at `/playlist/my-liked`, backed by `GET /api/library/liked`.
- Added a shared `@soundspan/media-metadata-contract` package so backend/frontend playback, search, and socket payloads use one canonical media-source schema.
- Added push-driven social presence refresh (`social:presence-updated`) so Social activity updates immediately after playback/presence changes.
- Added `YTMUSIC_SEARCH_MODE` (`auto`, `native`, `tv`) with per-user fallback from native search to TV-parser search.
- Added segmented representation quarantine with per-representation cooldown timers and automatic re-enable for recovery.
- Added provider gap-fill loading UX: unresolved tracks show `LOADING` and stay non-interactive while provider matching is still in flight.
- Added optional iOS Howler lock-screen compatibility workarounds behind `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED` (default `false`).

### Changed

- Streaming engine selection is runtime-controlled via `STREAMING_ENGINE_MODE`; `howler` is the default direct/primary mode and `videojs` is segmented experimental mode.
- Segmented playback in active Listen Together groups is runtime-gated by `LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED` (default `false`), and segmented operator guidance moved to `docs/EXPERIMENTAL_SEGMENTED_STREAMING.md`.
- Segmented startup/handoff now uses direct-first startup, bounded staged retries, prewarm reuse, and asynchronous asset readiness in place of prior promotion-heavy startup paths.
- Segmented startup timeout is runtime-configurable via `/runtime-config` with `SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS` (1500-22000ms, default `20000`).
- Segmented readiness now emphasizes selected-representation startup readiness and requires startup segment availability before manifest promotion.
- Segmented cache storage now supports `SEGMENTED_STREAMING_CACHE_PATH` (defaulting to `TRANSCODE_CACHE_PATH`), and DASH cache keys now include schema/version suffixing.
- Playback quality now defaults to saved user quality when not explicitly requested by the client.
- Playback quality badges now come from one shared resolver used by Mini Player, Full Player, and Overlay Player, with segmented profiles surfacing canonical bitrate/codec metadata.
- The player coordinator was renamed to `AudioPlaybackOrchestrator`.
- Video.js segmented requests now use per-player VHS hooks (instead of a global hook) and disable native media tracks for consistent DASH behavior.
- Segmented startup API failures now include machine-readable `startupHint` metadata, and startup retries in `AudioPlaybackOrchestrator` now prefer backend retry hints over message-only heuristics.
- Segmented manifest/segment readiness waits now coalesce concurrent in-flight requests by session key to reduce duplicate startup work.
- `My Liked` is playlist-only (removed from Home/Radio generation), with direct sidebar/mobile navigation links.
- Track preference controls were simplified to a single heart-like action across player and list surfaces.
- Playback-state persistence writes now treat queue/index/time/shuffle as patch fields so omitted values are preserved instead of reset.
- YouTube Music `/search` and `/match` no longer require per-user OAuth restore and now run through public sidecar search clients (browse/library/stream endpoints remain OAuth-protected).
- Dynamic playlist/queue generation now spreads artist distribution more evenly to reduce clustering.
- Deezer album-cover lookup now uses multi-variant title matching (stripping bracketed descriptors/common edition suffixes) with fuzzy-scored candidate selection.

### Fixed

- Fixed transient Listen Together socket conflicts for `seek()`/`reportReady()` with bounded retry, backoff, and jitter.
- Fixed segmented-playback recovery so local player state remains authoritative for resume position and play/pause intent after disruptions.
- Fixed long buffering/spinner stalls by keeping heartbeat checks active during buffering and retrying segmented startup within bounded stage/window budgets before surfacing timeout errors.
- Fixed Listen Together cold-start stalls where play could time out before initial DASH assets were ready; startup retry windows now account for build-in-progress sessions.
- Fixed repeated handoff/reseek churn with per-track cooldowns, bounded retries, and explicit handoff skip diagnostics.
- Fixed token/session race cases during in-flight handoff so manifest/segment validation tolerates session ID swaps without intermittent 403 stalls.
- Fixed segmented cache lock races across backend pods and improved cross-pod segmented readiness behavior.
- Fixed segmented `sendFile` and manifest-relative chunk path handling so `.m4s`/`.webm` requests remain stable across route variations.
- Fixed ffmpeg compatibility across builds by probing DASH flag support at startup and retrying generation without unsupported flags when needed.
- Fixed low-latency DASH muxing gaps by using capability-aware `-ldash`/fragment-duration tuning and UTC timing fallbacks.
- Fixed Video.js DASH startup behavior to use a low-latency startup buffer target (~0.4s for 0.2s fragments) while restoring steady-state buffering for VOD after startup.
- Fixed local original-quality segmented output to generate lossless FLAC-in-fMP4 segments when supported, with controlled fallback when unsupported by client/runtime.
- Fixed remote-provider segmented generation flakiness (including short TIDAL starts) by adding ffmpeg reconnect/read-timeout input flags for remote sources.
- Fixed segmented storage growth with periodic `segmented-dash` pruning, active-session protection, minimum-age guardrails, and configurable size/interval thresholds.
- Fixed silent mid-track pauses by adding unexpected-pause telemetry and running segmented/transient recovery attempts before hard stop.
- Fixed stale resume-time regressions and same-source reset loops that could cause wrong start offsets, mid-track starts, unexpected skips/stops, or restart loops.
- Fixed overlay player control geometry (`+` alignment) and Up Next opening so current-track centering settles correctly after panel/layout animation.
- Fixed social presence rows to correctly distinguish `Playing`, `Paused`, and idle states (including long-paused idle behavior), with direct artist/song links where available.
- Fixed Discover state transitions so recently generated playlists stay in resolving/loading states (with short retries) instead of flashing "Generate Now."
- Fixed Related-tab recommendations by correcting Last.fm similar-artist cache keying/name lookup and adding local-library fallback paths when Last.fm is sparse.
- Fixed noisy frontend `EACCES` image-cache write errors in read-only filesystems by disabling on-disk ISR/image cache flushing.
- Fixed missing-cover regressions by expanding native cover healing to Cover Art Archive, provider-chain lookup, and Deezer fallback with in-flight dedupe/cache refresh.
- Fixed CLAP rerun stalls where progress could remain "running" with idle workers by resetting queued/retry tracks to pending and hardening Redis enqueue retry behavior.
- Fixed `My Liked` row actions to reflect canonical liked state reliably.
- Fixed duplicate Listen Together host next/previous socket emits by debouncing host transport controls.
- Fixed split-stack and AIO Docker builds that could miss the shared media metadata contract in build contexts.
- Fixed library scan pollution from hidden dotfiles (including transcode artifacts) by omitting dotfile paths.
- Fixed segmented chunk 404 handling to trigger fresh transcode creation instead of waiting for full failure paths.

## [1.1.2] - 2026-02-20

### Added

- Album pages now include one-click thumbs-up/thumbs-down actions that apply to every track on the album in a single batch update.

### Changed

- Home data loading now uses bounded featured-playlist and audiobook queries, reducing homepage overfetch.
- Frontend API routing now supports explicit `NEXT_PUBLIC_API_PATH_MODE` (`auto`, `proxy`, `direct`) for clearer proxy/direct deployment behavior.
- Settings now code-splits heavy/admin sections, reducing initial settings page JavaScript payload.
- Streaming sidecar checks now use keep-alive and short-lived dedupe caching to reduce repeated provider/auth status calls.
- Deployment docs now clarify frontend build-time vs runtime environment behavior and include centralized container-by-container environment variable references.
- Backend scale defaults were raised for DB and auth throughput, and related deployment command examples were refreshed.
- Additional governance/process updates tightened agent documentation, policy checks, and release-note workflow enforcement.
- Volume startup normalization now uses one shared parsing/clamping policy so reloads restore the same effective player volume more consistently.
- Playback-state persistence now stores explicit play/pause intent so reload behavior can restore whether playback should resume or remain paused.

### Fixed

- Reduced unnecessary client API traffic by removing render-phase state writes and consolidating overlapping polling ownership in activity/download/playback flows.
- Added backend response compression for compressible API responses while excluding stream/media and `no-transform` responses.
- Added missing `next/image` `sizes` attributes across fixed-size image callsites to improve responsive image selection.
- Fixed frontend API auto-mode to default to same-origin proxy routing (instead of inferring direct `:3006` calls on non-canonical ports), preventing empty library views when inferred backend origin is wrong.
- Thumbs up/down interactions now apply optimistic state immediately without waiting on in-flight preference-query cancellation, reducing visible click latency.
- CLAP enrichment progress now stays below 100% while work remains and derives failed counts from track status, preventing “1 remaining at 100%” and phantom-running enrichment states.
- Vibe embedding queue writes now mark tracks as `processing` only after successful Redis enqueue, preventing false processing status when enqueue fails.
- Fixed analyzer/reconciliation edge cases (including empty-result loop handling) that could leave enrichment status appearing active longer than expected.
- Lyrics requests no longer cache timeout/service failures as immediate “no lyrics” results; failed lookups now surface retriable errors and empty `source=none` lyric responses refresh quickly.
- Settings page hydration now blocks default-value rendering until saved settings load, and failed settings loads retry on focus/online recovery.
- TIDAL status checks now lazily restore user OAuth from saved credentials, reducing false “not authenticated” states after sidecar restarts.
- Album gap-fill provider status caching now expires negative availability quickly, so transient status failures stop suppressing matching for long windows.
- Missing native album covers now self-heal by downloading and storing a fresh local image immediately, then routing follow-up requests back to the local cover path.

## [1.1.1] - 2026-02-20

### Added

- Added a shared track overflow menu across player, queue, and list surfaces with quick actions like Play Now, Play Next, Add to Queue/Playlist, and context-specific remove actions.
- Added broader playback controls in key surfaces, including Save Queue as Playlist, queue-end controls in the mini player, and thumbs actions in more track lists.
- Added clearer action affordances across discovery/playlist/artist views with consolidated action rows and Play All/Radio pill-style controls.

### Changed

- Rolled out additional UI polish in player/list surfaces, including consistent electric-blue accent usage and control/layout refinements.
- Removed Copy Link actions from overflow menus and overlay player to simplify action menus and reduce clutter.

### Fixed

- Fixed queue insertion behavior so Add to Queue appends to the queue tail instead of being inserted after the current track.
- Fixed overlay player layering so playlist picker/menus render inside the correct z-index context.
- Fixed mobile track-row spacing and control sizing on small screens.
- Fixed track-overflow menu typing mismatches that could break queue actions in some views.

## [1.1.0] - 2026-02-19

### Added

- Added a canonical release notes template and generator workflow for repeatable release publishing.
- Added queue-end auto Match Vibe continuation so playback can extend automatically when repeat is off and Listen Together is not active.
- Added shared thumbs preference controls and supporting tests across player/list surfaces (`trackPreferenceSignals`, shared button component, and regression coverage).

### Changed

- Clarified product direction and branding language across docs/UI.
- Extended thumbs preference actions to the playback and list surfaces where users triage tracks (overlay, full player, album tracks, and playlist rows).
- Updated thumbs visuals to icon-only controls with solid white active state and removed the overlay thumbs pill/container chrome.
- Strengthened local agent governance for shared `.agents/**` concurrency handling and documented/enforced release-notes process policy.

### Fixed

- Reduced repeated-artist clustering across radio/vibe/discovery recommendation paths and applied light thumbs weighting.
- Fixed repeated thumbs taps so active thumbs-up/down cleanly toggle back to neutral; opposite action now cleanly overrides prior state.
- Fixed intermittent UI navigation stalls by re-enabling sidebar route prefetch and bypassing Next.js route-transition requests in the service worker.

## [1.0.1]

### Added

- Added a one-command maintainer release-prep flow (`npm run release:prepare -- --version X.Y.Z`) that synchronizes frontend/backend package versions, Helm chart version/appVersion, and release image tags, with hard-coded package-name validation.
- Helm chart release workflow now waits for release-tagged GHCR images before publishing chart artifacts to `gh-pages`.

### Changed

- Refreshed the home experience with a larger layout footprint, updated title-bar presentation, and updated home imagery.
- Hardened release automation by ensuring Node prerequisites are available for workflow steps that execute Node commands.
- Updated preflight/index validation flow to rebuild indexes before strict verification, reducing stale-index blocking during release checks.

### Fixed

- Activity Social tab no longer flickers to "Social status unavailable" during transient refresh failures when cached online users are already available.
- Fixed off-theme discover play controls so they match the active UI color system.
- Fixed weekly playlist state handling so generated playlists no longer disappear during follow-up refreshes.
- Fixed recommendation diversity regression where radio/mix outputs could over-concentrate on a small set of artists.

## [1.0.0]

### Added

- Rebrand baseline initialized for soundspan.
