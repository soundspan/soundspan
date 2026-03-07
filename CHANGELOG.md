# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

### Added

### Changed

### Fixed

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
- Project tooling migrated from custom agent-config scripts to the ACM control plane, removing ~30k lines of legacy governance scaffolding.
- PR checks updated to use ACM-driven verification for backend coverage, frontend lint/build/coverage, and Helm chart rendering.
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
