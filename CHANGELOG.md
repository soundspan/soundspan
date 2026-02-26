# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a new segmented streaming path across backend and frontend, with Video.js as the default segmented player.
- Added backend segmented-streaming APIs for session create, manifest, segment delivery, heartbeat, and handoff under `/api/streaming/v1/sessions`.
- Added playback diagnostics capture for segmented sessions (`POST /api/streaming/v1/client-metrics`) plus a baseline capture script for before/after startup comparisons.
- Added a hard-wired `My Liked` playlist surface at `/playlist/my-liked`, backed by a dedicated liked-tracks API (`GET /api/library/liked`).
- Added a shared `@soundspan/media-metadata-contract` package so backend/frontend playback, search, and socket payloads use one canonical media-source schema.
- Added push-driven social presence refresh (`social:presence-updated` over the Listen Together socket namespace) so Social activity refreshes immediately after heartbeat/playback updates.
- Added `YTMUSIC_SEARCH_MODE` (`auto`, `native`, `tv`) in the ytmusic sidecar, including per-user fallback from native search to TV-parser search when upstream native calls fail.

### Changed

- Streaming engine selection is now runtime-controlled with `STREAMING_ENGINE_MODE`: `videojs` by default, with non-default `howler-rollback` for rollback without rebuilding images.
- Segmented cache storage now supports `SEGMENTED_STREAMING_CACHE_PATH` and defaults to `TRANSCODE_CACHE_PATH` when not set.
- Segmented DASH cache keys now include a schema/version suffix, and segmented session routing now accepts both `.m4s` and `.webm` segment variants.
- Segmented startup timeout is now runtime-configurable with `SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS` (1500-15000ms, default 5000ms) through `/runtime-config`, and now controls segmented startup retry timing.
- Session creation now returns quickly while segment assets build in the background, and startup reuses prewarmed/startup segmented sessions when available.
- Track transitions now prewarm upcoming segmented sessions and reuse prewarmed manifests/tokens when possible.
- Playback quality now defaults to the user’s saved quality when the client does not pass one explicitly.
- Playback quality badges now come from one shared resolver used by Mini Player, Full Player, and Overlay Player, with segmented profiles surfacing canonical bitrate/codec metadata.
- The player coordinator was renamed to `AudioPlaybackOrchestrator` to match its current role.
- Video.js segmented requests now use per-player VHS hooks (instead of a global hook) and explicitly disable native media tracks to keep DASH behavior consistent across browsers.
- `My Liked` is now playlist-only (removed from Home/Radio station generation), with direct navigation links in sidebar and mobile quick links.
- Album-wide thumbs-up/down actions no longer render inside a shared pill container; they now use standalone icon controls.
- Playback-state persistence writes now treat queue/index/time/shuffle as patch fields so omitted values are preserved instead of being reset.
- YouTube Music `/search` and `/match` no longer require per-user OAuth restore and now run through public sidecar search clients (browse/library/stream endpoints remain OAuth-protected).
- Segmented playback in active Listen Together groups is now runtime-gated by `LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED` (default `false` for conservative LT behavior).

### Fixed

- Fixed segmented-playback recovery so local player state stays authoritative for resume position and play/pause intent after disruptions.
- Fixed long buffering/spinner stalls by keeping heartbeat checks active during buffering and retrying segmented startup within bounded stage/window budgets before surfacing timeout errors.
- Fixed repeated handoff/reseek churn with per-track cooldowns, bounded retries, and explicit handoff skip diagnostics.
- Fixed token/session race cases during in-flight handoff so manifest/segment validation tolerates session ID swaps without producing intermittent 403 stalls.
- Fixed compatibility issues across ffmpeg builds by probing supported DASH flags at startup and retrying generation without unsupported flags when needed.
- Fixed local original-quality segmented output to generate lossless FLAC-in-fMP4 segments when supported, with automatic direct-play fallback when not supported by client/runtime.
- Fixed client path compatibility for manifest-relative `.m4s` segment requests so chunk URLs continue working across route variations.
- Fixed segmented storage growth by adding periodic `segmented-dash` pruning with active-session protection, minimum-age guardrails, and configurable size/interval thresholds.
- Fixed remote-provider segmented generation flakiness (including short TIDAL starts) by adding ffmpeg reconnect/read-timeout input flags for remote sources.
- Fixed silent mid-track pauses by adding explicit unexpected-pause telemetry and running segmented/transient recovery attempts before hard stop.
- Fixed occasional wrong start offsets on newly selected tracks by preventing stale prior-track resume time from being applied during track switches.
- Fixed overlay player control geometry so the `+` action aligns with the play/pause centerline, and fixed Up Next opening so current-track centering settles correctly after panel/layout animation.
- Fixed social presence rows to distinguish `Playing`, `Paused`, and idle/not-playing states (including paused-for-more-than-five-minutes idle behavior) and added direct artist/song navigation links where available.
- Fixed startup reliability regressions where stale persisted queue/time snapshots could cause mid-track starts, unexpected skips/stops, or volume mismatch at queue start by hardening playback-state reconciliation and reapplying runtime output state at load/play boundaries.
- Fixed playback intent drift during transitional machine states and removed same-source forced `seek(0)` resets that could trigger restart loops.
- Fixed Discover page state transitions so recently generated playlists stay in a resolving/loading state (with short retries) instead of flashing the "Generate Now" empty state while track data is still arriving.
- Fixed Related-tab recommendations by correcting Last.fm similar-artist cache keying/name lookup and adding local-library fallbacks for both similar tracks and similar artists when Last.fm is sparse.
- Fixed noisy frontend `EACCES` image-cache write errors in read-only container filesystems by disabling on-disk ISR/image cache flushing.
- Fixed missing-cover regressions by expanding native cover healing to use Cover Art Archive, provider-chain lookup, and Deezer fallback with in-flight dedupe and cache refreshes.
- Fixed CLAP rerun stalls where progress could remain "running" with idle workers by resetting queued/retry tracks back to pending and ensuring Redis enqueue retries use a fresh client after reconnect.
- Fixed `My Liked` row actions so thumbs-up rendering reflects canonical liked state (active white icon) instead of an unbound local control.
- Fixed duplicate Listen Together host next/previous socket emits by debouncing host transport controls.
- Fixed split-stack and AIO Docker builds that could miss the shared media metadata contract in build contexts.

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
