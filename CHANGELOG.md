# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

### Added

- Persistent cross-provider track mapping support (`TrackMapping`, `TrackTidal`, `TrackYtMusic`) with deterministic selection rules and migration coverage.
- New backend import and mapping APIs:
  - `POST /api/import/preview`
  - `POST /api/import/execute`
  - `GET /api/track-mappings/album/:albumId`
  - `POST /api/track-mappings/batch`
- New playlist import runtime service (`PlaylistImportService`) with batched provider matching and persisted mapping upserts.
- New reconciliation worker/service to refresh provider mappings after scans and on periodic schedule.
- New frontend `/import` page for direct multi-provider preview + execute workflow with per-track provider resolution badges.
- New browse provider tabs with optional TIDAL browse surface and explicit disconnected CTA state.
- New mixed-provider playlist detail contract and UI indicators for provider source and playability.
- New route-level integration coverage for import, mapping, YT browse, and public YT streaming endpoints.

### Changed

- Spotify import execution path is now resolution-only and no longer triggers downloader/indexer acquisition runtime while preserving URL parse/preview behavior.
- Playlist import execution now runs inside a transaction with duplicate-safe item writes.
- Home featured browse sourcing moved off deprecated Deezer browse endpoints to YouTube Music-backed data.
- Browse and playlist flows now provide actionable drill-down/detail navigation for chart and category content.
- Refreshed repository and integration docs plus generated governance artifacts (route map, OpenAPI coverage, JSDoc coverage, and domain READMEs).

### Fixed

- Fixed null-safety regressions for nullable `PlaylistItem.trackId` / `item.track` in playlist and Subsonic serializers.
- Fixed track-mapping batch validation to reject orphan payloads without linkage keys.
- Fixed nondeterministic mapping selection by enforcing active-linkage uniqueness and deterministic mapping ranking.
- Fixed frontend TypeScript narrowing regressions in mixed-provider playlist handling and YT chart artist union handling.
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

- Added a canonical release notes template (`.agents-config/docs/RELEASE_NOTES_TEMPLATE.md`) and generator workflow (`npm run release:notes`) for repeatable release publishing.
- Added queue-end auto Match Vibe continuation so playback can extend automatically when repeat is off and Listen Together is not active.
- Added shared thumbs preference controls and supporting tests across player/list surfaces (`trackPreferenceSignals`, shared button component, and regression coverage).

### Changed

- Clarified product direction and branding language across docs/UI: soundspan is PWA-first for first-party mobile, with Subsonic-compatible apps as native mobile clients.
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
