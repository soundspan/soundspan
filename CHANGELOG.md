# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI safety net: `quality-visibility.yml` gained a "Run frontend component tests" step (`npm run test:component`) in the frontend job, plus two standalone typecheck jobs — `backend-typecheck` and `frontend-typecheck`, each a `tsc --noEmit` run against their respective package. Like the existing quality-visibility jobs, both are non-blocking until an admin flips the `CI_NON_BLOCKING_TEST_VISIBILITY` repo variable to `'false'`.
- CI now runs non-blocking security scanning and weekly dependency automation (#59 WS2.4, roadmap F45): Trivy filesystem + image scans (`CRITICAL,HIGH`, `ignore-unfixed`, findings triaged in `.trivyignore`), a gitleaks secret scan via the OSS binary directly (not the licensed `gitleaks-action`), CodeQL (`javascript-typescript` + `python`), `dependency-review-action` on PRs, and a `pip-audit` sweep of the four sidecar services' requirements files. `.github/dependabot.yml` opens weekly, grouped minor/patch PRs across the 4 npm manifests, 4 pip services, 7 Dockerfile directories, and GitHub Actions (`open-pull-requests-limit: 5` per ecosystem; yt-dlp/ytmusicapi are deliberately never excluded). Every check runs `continue-on-error: true` day one so findings are visible without blocking a PR; the blocking ratchet and Dependabot security-updates (separate from the version-updates this ships) are tracked for 1.10.0.

### Changed

- `GET /api/library/tracks/shuffle`'s large-library path no longer runs a full-table `ORDER BY RANDOM()` scan+sort per request (roadmap F15). It now samples via a new indexed `Track.random` column: pick a uniform pivot in `[0, 1)`, take the next `limit` rows by `random` ascending from that pivot, and top up with a wrap-around query (`random < pivot`) on shortfall — removing the endpoint's raw-SQL site entirely. On the local 15,230-track corpus: `LIMIT 100` p50 ~2.0ms → ~0.7ms, p95 ~4.1ms → ~1.5ms; `LIMIT 1000` p50 ~2.7ms → ~2.0ms, p95 ~3.3ms → ~2.4ms. The old query's cost is dominated by sorting the whole table and stays roughly flat regardless of `limit`; the new query's cost scales with `limit` via the index, so the win is largest at typical shuffle sizes and grows further as the library grows (the old query gets linearly slower with table size; the new one doesn't).
- Spotify/Deezer playlist-import preview matches tracks against the library
  roughly 2.5x faster on a 50-track playlist (≈130ms → ≈52ms median wall-clock
  on a 15,230-track dev corpus), by running the per-track library lookups
  through a bounded-concurrency queue (`p-queue`, concurrency 4) instead of
  one at a time. Discover Weekly's tier-based artist recommendations also
  check library membership via one batched query per generation run instead
  of up to 2 Prisma round trips per candidate artist across the similar-artist
  pool (F13).
- All Node-based Docker images and CI jobs now run Node 24 (`node:24-bookworm-slim` for backend/frontend/root-AIO images), replacing the previous 20/24 split. `@types/node` is bumped to `^24` in backend and frontend to match, and the backend `tsconfig` `lib` is raised `ES2020` → `ES2022` alongside, keeping `tsc` clean under `@types/node` 24 (which dropped the legacy compat declarations for post-ES2020 built-ins like `.at()` that the v20 types carried) — the declared lib now matches what the Node ≥ 20 runtime actually implements; type declarations only, emitted code and `target` unchanged.
- Similar-tracks and vibe search now surface genuinely related neighbours instead of near-random ones: every pgvector ANN query now applies a configurable `ivfflat.probes` on the same pooled connection (a transaction-scoped `set_config`), fixing recall that was silently stuck at Postgres' default of scanning 1 of the index's 224 lists. New `IVFFLAT_PROBES` env var, default `32` — benchmark-chosen on the local 15,230-track corpus, where it lifts recall@10 from ≈0.26 (probes=1) to ≈0.96 at ~6 ms p95.

### Fixed

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

### Security

- `/api/releases` (`GET /radar`, `/upcoming`, `/recent`, `POST /download/:albumMbid`) now requires authentication end-to-end (`router.use(requireAuth)`), matching what its own `@openapi` docs already claimed (`sessionAuth`/`apiKeyAuth` + a `401` response) but the code never enforced — any anonymous caller could previously read Lidarr/library release-radar data. One frontend consumer exists — `app/releases/page.tsx` calls this router via raw `api.request()` (`/releases/radar`, `/releases/download/:albumMbid`) — and is unaffected: the page only mounts inside `AuthenticatedLayout` (`/releases` is not a public path, so its fetch never fires unauthenticated), and `ApiClient.request()` always attaches the stored Bearer token, with the shared 401 refresh-and-retry fallback behind it.
- Offline downloads/cache and listening-state ("Continue Listening") endpoints no longer run with an undefined user id — which, on three of them, meant no per-user scoping at all. All 8 handlers across `offline.ts` (`:53,196,252,337,387`) and `listeningState.ts` (`:59,127,181`) read `req.session.userId!` as their only source of the user id — always `undefined` in practice, since both routers authenticate via `requireAuth`, which populates `req.user`, never `req.session`. Five of the eight fed the undefined id into unique-keyed Prisma lookups, which reject an undefined selector, so those endpoints simply 500'd. The other three passed it into non-unique `where` filters, and Prisma silently drops `undefined` filter keys: `GET /api/offline/albums` listed **every** user's cached tracks, `DELETE /api/offline/albums/:id` deleted **every** user's cached tracks for the album, and `GET /api/listening-state/recent` returned **every** user's listening states. All 8 now read `req.user!.id`, restoring per-user scoping (roadmap F11 step 1; the dead session-auth branch itself and the rest of the auth-resolver consolidation remain open). Calibration: on the typical single-operator deployment the visible symptom was the five 500s; on multi-user instances the three filter endpoints were cross-user data exposure and cross-user deletion.

### Admin/Operations

- Database migration `20260711012100_add_track_random_sample_column` (roadmap F15) adds `Track.random double precision` (DB-generated `random()` default) plus a btree index, backing the new `/tracks/shuffle` sampling query above. Because the default is volatile, this `ADD COLUMN` rewrites the whole table in PostgreSQL 16 (not the metadata-only fast path constant defaults get) — milliseconds at the current 15,230-row corpus. Every writer (Prisma upserts in the scanner, any future inserts) gets a value automatically with zero app-code changes; the Python analyzer sidecars only `UPDATE` existing `Track` rows, so they need no changes either. The `CREATE INDEX` is non-`CONCURRENT` (repo migration convention), so it briefly locks writes to `Track` while it builds — negligible at homelab scale.

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
