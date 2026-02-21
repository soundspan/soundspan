# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added segmented streaming session/DASH delivery architecture across backend and frontend, including Video.js-based segmented playback with direct-stream compatibility fallback.
- Added segmented playback baseline capture tooling (`tools/streaming/capture-playback-baseline.mjs`) for reliability/latency before-vs-after reporting.
- Added segmented streaming session lifecycle API routes: session create, manifest, segment, heartbeat, and handoff endpoints under `/api/streaming/v1/sessions`.
- Added segmented client-signal ingestion (`POST /api/streaming/v1/client-metrics`) for live stall/rebuffer diagnostics from browser playback telemetry.

### Changed

- Segmented streaming engine control now uses runtime `STREAMING_ENGINE_MODE` injection (`videojs` default, explicit `howler-rollback` opt-in) so prebuilt images can roll back without rebuilds.
- Segmented streaming cache location now supports `SEGMENTED_STREAMING_CACHE_PATH` and defaults to `TRANSCODE_CACHE_PATH` when unset.
- Segmented startup fallback timeout is now runtime-configurable via `SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS` (clamped to 1500-15000ms, default 2500ms) through `/runtime-config`.
- Segmented session creation now returns immediately and continues DASH asset generation in the background, with manifest/segment routes waiting for asset readiness instead of failing fast on startup races.
- Segmented playback session quality now defaults to each user’s saved playback-quality setting when the frontend does not explicitly pass a quality value.
- Next-track segmented playback now prewarms immediately and reuses prewarmed session manifests/tokens on track handoff.
- Track startup now uses segmented delivery only when a usable prewarmed session already exists; otherwise playback starts direct immediately while segmented session prewarm continues asynchronously in the background.
- Playback quality badge resolution is now centralized in a single shared resolver and applied consistently across Mini Player, Full Player, and Overlay Player.
- Player orchestration component naming now reflects current runtime responsibility (`AudioPlaybackOrchestrator`), replacing the legacy `HowlerAudioElement` naming.

### Fixed

- Recovery after segmented playback disruption now keeps local player state authoritative for resume position and play/pause intent.
- Heartbeat stall detection now stays active while buffering so stalled tracks do not get stuck in an indefinite spinner state.
- Local `original` segmented sessions now chunk lossless sources as FLAC fMP4-DASH assets, with client capability checks that fall back to direct playback when lossless segmented playback is unsupported.
- Segmented manifest-relative `.m4s` segment requests are now served through a compatibility route, preventing session stalls when clients request chunk URLs outside the `/segments/` path prefix.
- Segmented fMP4 generation now auto-retries without unsupported ffmpeg DASH flags (`-ldash`, then `-streaming` when needed), preventing hard failures on older ffmpeg builds.
- Segmented playback now fails over to direct stream when DASH startup stalls past the runtime timeout, preventing long spinner waits before first audio.
- Backend startup now probes ffmpeg DASH muxer capabilities once and suppresses unsupported flags proactively to reduce repeated startup failures/noise.
- Local segmented sessions now signal cold/in-flight asset generation so frontend starts on direct playback immediately while DASH assets continue warming in the background.
- Segmented handoff recovery now enforces a per-track cooldown to prevent rapid session churn/reseek loops during repeated transient playback errors.
- Next-track segmented prewarm now performs bounded retries when assets are still warming, preventing repeated direct-only track transitions caused by one-shot prewarm skips.
- Direct-start track playback now performs proactive segmented handoff once prewarmed sessions become ready (with bounded retries/cooldown), instead of waiting for a playback-error-triggered recovery path.
- Proactive direct-to-segmented promotion now logs explicit skip reasons and executes the handoff API path directly, making handoff behavior observable and deterministic per-track during startup warmup.
- Manifest and segment token validation now tolerates in-flight session ID swaps during handoff while still enforcing user/track/quality/source scope, preventing intermittent 403 buffering stalls.
- Heartbeat stall recovery now force-reconciles playback state-machine and UI playback/buffering flags after event-race transitions, preventing persistent spinning states when playback resumes.
- Heartbeat buffer timeouts now attempt segmented handoff/transient reload recovery before hard-failing playback, reducing red-circle stopouts after brief segmented stalls.

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

- Added a canonical release notes template (`docs/RELEASE_NOTES_TEMPLATE.md`) and generator workflow (`npm run release:notes`) for repeatable release publishing.
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
