# OpenSubsonic Compatibility

## Scope

This document defines the `/rest` compatibility contract implemented in this fork and captures the readiness evidence behind it.

> **Contract authority / OpenAPI exemption.** This document is the authoritative contract for the Subsonic-compatible `/rest` surface (`backend/src/routes/subsonic/index.ts`). Those endpoints follow the published OpenSubsonic/Subsonic API rather than soundspan's own REST shape, so they are **intentionally exempt** from per-endpoint OpenAPI (`@openapi`) annotation — see the Documentation-coverage rule in [`AGENTS.md`](../AGENTS.md). Keep the endpoint surface below current when `/rest` behavior changes; that is the substitute for OpenAPI coverage on this prefix.

## Coverage

- soundspan's in-scope music client surface is fully implemented.
- The missing domains listed under Explicit Non-Goals stay out of scope unless real client demand requires promotion.

## Client-Facing Companion

The per-client compatibility matrix, connection quickstart, and extension roadmap live in [`SUBSONIC_CLIENTS.md`](SUBSONIC_CLIENTS.md). Update that matrix when this contract changes.

## Client Connection URL

- Split frontend/backend deployments: use the frontend base URL for clients (for example `http://host:3030` in deployment, `http://host:3031` in local dev). Frontend proxies `/rest` to backend.
- Backend-direct deployments: clients may target backend directly (`http://host:3006`).

## Supported Auth Modes

- `u` + `p` (plain and `enc:` hex password forms). `p` accepts a local password or an active app password.
- `u` + `t` + `s` token mode (`t = md5(secret + salt)`). `secret` is an active app password (Settings → Sign-in & Security → App Passwords). Accounts with a stored legacy dedicated Subsonic password keep working; the credential is deprecated and cannot be set from Settings.
- `apiKey` query auth (OpenSubsonic extension), with optional `u` username consistency check
- Required protocol params: one auth mode, `v`, `c` (`u` required for password/token auth, optional for `apiKey`)
- Response formats: JSON, XML, JSONP (`f` + optional `callback`)

Create app passwords under **Settings > Sign-in & Security**. Each generated secret starts with `ssap_`, is shown once, is limited to `/rest`, and can be revoked independently. Use the soundspan username with the app password. For token authentication, calculate `t` from the complete `ssap_` secret and the client-provided salt.

## Advertised OpenSubsonic Extensions

`getOpenSubsonicExtensions` advertises these extensions at version 1:

- `apiKeyAuthentication`
- `formPost`
- `replayGain`
- `songLyrics`
- `transcodeOffset`
- `songPlayedDate`
- `albumPlayedDate`
- `indexBasedQueue`

`transcodeOffset` is supported through the `stream` endpoint's integer-second
`timeOffset` parameter. Positive offsets apply only when the resolved quality
is a transcode tier. Offset transcodes use ffmpeg input seeking and bypass the
track-and-quality disk cache, but share the same global ffmpeg concurrency cap
as cached transcodes. Temporary offset output lives under the configured
transcode cache volume in `offset-tmp/`; request aborts kill ffmpeg, every
response path removes its temporary output, and a process-wide 15-minute gate
limits stale-file sweeps. Each bounded sweep removes orphaned files older than
one hour while excluding files owned by active responses. Raw/original streams
ignore the offset. Federated
stream proxy requests ignore `timeOffset` because the peer stream API
forwards quality and Range metadata rather than arbitrary Subsonic parameters.
This extension is distinct from the missing `getTranscodeDecision` and
`getTranscodeStream` endpoint extensions.

`formPost` is honored across the surface: `/rest` accepts form-encoded POST
requests (validated with Music Assistant). Mutating endpoints serve POST
through their existing routes; read endpoints route POST through an explicit
read-only allowlist. Form-body parameters never override same-named URL query
parameters, and credentials submitted in the body are never copied into the
request URL (so they cannot reach URL-based logging).

`replayGain` gains are computed against the server's configurable
`LOUDNESS_TARGET_LUFS` (default `-18` LUFS, the ReplayGain 2 reference).
Tracks the analyzer has not measured yet omit the object until the background
measurement reaches them. Peaks are linear true-peak amplitudes.

## Implemented Endpoint Surface

Tier A foundation and browse/search/media:

- `ping`, `getLicense`, `getOpenSubsonicExtensions`, `tokenInfo`, `getMusicFolders`, `getIndexes`
- `getArtists`, `getArtist`, `getArtistInfo`, `getArtistInfo2`, `getAlbum`, `getAlbumInfo`, `getAlbumInfo2`, `getSong`, `getTopSongs`, `getSimilarSongs`, `getSimilarSongs2`, `getMusicDirectory`, `getAlbumList`, `getAlbumList2`, `getGenres`, `getSongsByGenre`, `getRandomSongs`, `search`, `search2`, `search3`
- `stream`, `download`, `getCoverArt`, `getLyrics`, `getLyricsBySongId`

Tier B mutation/readiness:

- `getUser`, `getAvatar`
- `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`
- `getPlayQueue`, `savePlayQueue`, `getPlayQueueByIndex`, `savePlayQueueByIndex`
- `getBookmarks`, `createBookmark`, `deleteBookmark`
- `getScanStatus`, `startScan`
- `scrobble`, `getNowPlaying`
- `getStarred`, `getStarred2`, `star`, `unstar`, `setRating`

`getPlaylists` omits generated radio-station playlists. Direct `getPlaylist`
access by ID remains available for compatible clients.

Soft-removed local tracks are omitted from browse, search, album, playlist,
similar-song, and random-song responses. `stream` and `download` return
not-found responses for soft-removed track IDs.

The `/rest` contract exposes visible local and federated library content with
the same local-wins deduplication used by the web library. Search, album,
artist, playlist, and state responses include peer-owned tracks. `stream` and
`download` proxy federated audio through the owning peer and preserve Range
requests; complete responses may be served from the consumer transcode cache.
`getCoverArt` falls back to the peer cover proxy when local cover metadata is
absent. An unavailable peer produces Subsonic error code `0` (`GENERIC`) with
the message `Federation peer is offline`. Embedded-file lyrics remain
local-only, while federated tracks may use metadata-based LRCLIB lookup.

Alias support:

- Both bare and `.view` forms are mounted (for example `/rest/ping` and `/rest/ping.view`)
- Mutation routes accept both `GET` and `POST` where compatibility clients commonly vary

## ID Policy

Protocol-facing IDs are deterministic and typed:

- Artists: `ar-<id>`
- Albums: `al-<id>`
- Tracks: `tr-<id>`
- Playlists: `pl-<id>`

Legacy/raw ID fallback remains supported where endpoint type context is sufficient.

## Readiness Evidence (manual validation)

Environment:

- Backend service: `backend` (`/health` OK on `http://127.0.0.1:3006`)
- Database user under test: `baseline-artist-skewed`
- Validation client identifier: `c=manual-check`

Key outcomes:

1. Auth handshake

- Password mode (`u/p`) succeeded for `/rest/ping.view`.
- Token mode (`u/t/s`) succeeded for `/rest/ping.view`.

2. Stream seek/range behavior

- `Range: bytes=0-9` on `stream.view` returned `206 Partial Content` with `Content-Range: bytes 0-9/33`.
- Subsequent seek `Range: bytes=10-20` returned `206 Partial Content` with `Content-Range: bytes 10-20/33`.
- Full fetch without range returned `200 OK` and full payload length.

3. Cover-art retrieval

- `getCoverArt.view` returned `200 OK`, `Content-Type: image/jpeg`, and cache headers.
- `size` parameter path executed successfully for the same entity.

4. Tier B mutation/readiness flows

- `createPlaylist` created a playlist with two tracks.
- `updatePlaylist` renamed playlist, removed one index, and re-added a track (result remained valid with expected song count).
- `getPlaylist` after delete returned protocol failure with `error.code=70` (not found) as expected.
- `star` then `getStarred2` showed track present; `unstar` removed it.
- `scrobble` respected mixed `submission` flags; DB delta confirmed only submitted entry persisted.
- `getNowPlaying` returned active entry after writing recent playback state.

DB side-effect checkpoints:

- `Play` row delta for validated submitted track: `+1`
- `LikedTrack` final count for tested track after unstar: `0`

## Third-Party Client Profile Matrix

Environment:

- Updated code path validated on local backend runtime (`http://127.0.0.1:3007`)
- Test user: `opensubsonic-matrix`
- Client profile IDs (`c`): `symfonium`, `dsub`, `ultrasonic`, `amperfy`, `substreamer`

Matrix outcomes:

1. `symfonium` profile

- `ping.view` returned `status=ok`.
- `search3.view` with `query=\"\"`, `artistCount=0`, `albumCount=0`, `songCount=0` returned `status=ok` with bounded full-sync payload (`artist=80`, `album=80`, `song=1200`).

2. `dsub` profile

- `search2.view` with `query=\"\"` + zero-count full-sync pattern returned `status=ok` with populated payload (`artist=80`, `album=80`, `song=1200`).
- `search2.view` with unsupported `musicFolderId=99` returned `status=ok` with empty payload arrays.

3. `ultrasonic` profile

- `getIndexes.view` returned `status=ok` with `index` groups and a stable `lastModified` value.
- `getIndexes.view` with `ifModifiedSince=<lastModified>` returned `status=ok` and `index=[]` (no-change semantics).
- `getIndexes.view` with unsupported `musicFolderId=99` returned `status=ok` and `index=[]`.
- `startScan.view` and `getScanStatus.view` both returned `status=ok`; scan-state contract was observable (`scanning=true` snapshot during active run).

4. `amperfy` profile

- `getArtists.view` with unsupported `musicFolderId=99` returned `status=ok` and `index=[]`.

5. `substreamer` profile

- `savePlayQueueByIndex.view` persisted indexed queue state (`index=2`, `currentIndex=0`, `position=1234`) for a real track.
- `getPlayQueueByIndex.view` returned the matching `playQueueByIndex` state (`entries=1`, expected track id, expected `currentIndex` and `position`).

Automation support:

- `cd backend && npm run test:smoke` executes baseline health checks and Subsonic profile checks when `SMOKE_SUBSONIC_USER` + `SMOKE_SUBSONIC_PASSWORD` are provided.
- `SMOKE_MODE=full` enables extended non-GUI client emulation (browse/search/list, profile/avatar, playlist lifecycle, queue baseline/indexed read, starred baseline, now-playing baseline, scan contract checks).
- `SMOKE_REQUIRE_TRACKS=true` enforces track-dependent coverage (song/album/artist metadata calls, lyrics-by-song, rating/star/unstar, scrobble, queue mutations with track IDs, stream/cover-art probes) and fails if no library songs are available.
- `SMOKE_ENABLE_FIXTURES=true` provisions a temporary DB-backed artist/album/track fixture when full-mode strict checks require tracks but the library has none; cleanup is automatic by default (`SMOKE_FIXTURE_CLEANUP=false` disables cleanup for debugging).
- `SUBSONIC_TRACE_LOGS=true` enables backend `/rest` trace lines for real-client troubleshooting (`endpoint`, `c`, `v`, `f`, HTTP status, Subsonic protocol status/error code) without logging auth secrets.

Automated run evidence:

- Command: `cd backend && SOUNDSPAN_BASE_URL=http://127.0.0.1:3007 SMOKE_SUBSONIC_USER=opensubsonic-matrix SMOKE_SUBSONIC_PASSWORD=*** SMOKE_MODE=full SMOKE_REQUIRE_TRACKS=true SMOKE_ENABLE_FIXTURES=true DATABASE_URL=postgresql://... npm run test:smoke`
- Result: `health` + `matrix` + strict full emulation all passed; a temporary fixture track was created and cleaned automatically to execute track-dependent checks on an empty-library dataset.

## Known Gaps / Non-Goals for Current Milestone

- This is not a full OpenSubsonic superset; unimplemented endpoints remain out of scope for the current phase.
- Validation includes a third-party client-profile matrix (curl-driven request emulation of real client patterns), but does not include full GUI-client certification runs.

### Known-Gap Backlog (Carry Forward)

High-value gaps to revisit first if future compatibility demand appears:

1. Streaming-profile parity gaps:
    - `hls`
    - OpenSubsonic transcoding extensions (`getTranscodeDecision`, `getTranscodeStream`)
2. Sharing feature gaps:
    - `getShares`, `createShare`, `updateShare`, `deleteShare`
3. Certification gap:
    - Full GUI-client validation passes (current matrix is non-GUI request-profile validation)

Current non-goal domains unless product scope changes:

1. Video endpoints (`getVideos`, `getVideoInfo`)
2. Podcast endpoints (Subsonic-format podcast domain)
3. Chat domain
4. Jukebox / internet-radio management domain
5. Subsonic user-administration endpoints (`getUsers`, `createUser`, `updateUser`, `deleteUser`, `changePassword`)

### Revisit Triggers

Promote a deferred gap to in-scope when at least one of these is true:

1. A target real client fails a core workflow due to a specific missing endpoint/domain.
2. soundspan product scope expands into the corresponding domain (for example podcasts/video/share).
3. A deployment/operator requirement explicitly depends on a missing Subsonic/OpenSubsonic contract surface.

## Implementation Gaps Inside Already-Implemented Endpoints

- `star` / `unstar` support `albumId` and `artistId` via track-like projection (all matching library tracks are starred/unstarred), not separate album/artist favorite tables.
- `getStarred`/`getStarred2` `artist` and `album` arrays are derived from liked-track projection state.
- `getNowPlaying` reports only the authenticated user's active playback state, not global multi-user now-playing.
- Song payloads include the authenticated user's latest `played` timestamp for that track, and album payloads include the latest `played` timestamp across that album's tracks. Both fields are omitted when no matching play exists.
- Song payloads also include `starred`, `userRating`, and `playCount` from authenticated-user state. `bitRate` is derived from stored byte size and duration because the scanner does not persist bitrate. These optional fields are omitted when their source state or derivation is unavailable. Album `starred` and `playCount` values are projections across the album's visible tracks.
- Remaining optional song fields not currently projected include `path`, `sortName`, `mediaType`, and `averageRating`.
- Classic `getPlayQueue`/`savePlayQueue` use the legacy playback-state device bucket (`deviceId=legacy`). `getPlayQueue.current` is the current protocol song ID, and `savePlayQueue.current` resolves a protocol or raw song ID to its first submitted queue position. A bare in-range integer remains accepted as this server's legacy index form when it does not match a submitted song ID.
- `getPlayQueueByIndex` returns a `playQueueByIndex` envelope whose `currentIndex` is 0-based into the returned `entry` list. `savePlayQueueByIndex` reads the required `currentIndex` parameter for a non-empty queue and returns Subsonic error 10 when it is missing, negative, non-integral, or outside the submitted `id` list. Calls without `id` clear the queue and omit `currentIndex`. The optional device-bucket `index` still maps `0` to `deviceId=legacy` and `N` to `deviceId=legacy-N`.
- Queue reads return their required queue object when no playback state exists, with `entry=[]`, `position=0`, the authenticated `username`, the empty snapshot's current server time as the ISO `changed` timestamp, and `changedBy=soundspan`. Empty classic queues omit `current`, and empty index-based queues omit the conditionally required `currentIndex`. Populated responses use the state's ISO `changed` timestamp and the same ownership metadata because playback state does not persist a client name. Reads resolve persisted current state against the unfiltered queue before projecting visible entries. Classic reads omit `current` when that track was filtered. Index-based reads select the nearest following surviving entry, or index `0` when none follows. Both forms reset `position` to `0` when the persisted current track was filtered.
- `getBookmarks`/`createBookmark`/`deleteBookmark` persist per-user bookmark state keyed by track id, with bookmark positions stored in seconds and returned in protocol milliseconds.
- `startScan` is compatibility-throttled with a cooldown window; repeated requests during cooldown return current scan status and do not enqueue new scan jobs.
- `getIndexes` honors `musicFolderId` filtering and `ifModifiedSince` no-change semantics.
- `getArtists` honors `musicFolderId` filtering.
- `search`/`search2`/`search3` honor `musicFolderId` filtering, normalize quoted-empty full-sync queries (`query=\"\"`), and treat zero counts as bounded full-sync requests.
- `search`/`search2`/`search3` pass through large offset values without a hard `10000` clamp so client pagination can complete on very large libraries.
- Song/album protocol payloads project `genre` from library metadata (prefer `userGenres`, then `genres`), and genre-filtered song responses (`getSongsByGenre`, `getRandomSongs` with `genre`) force explicit `genre` values in each returned song item. `getSongsByGenre` uses a day-stable order so offset pages remain coherent throughout the day.
- `getRandomSongs` uses artist-diversity weighted sampling with a top-up to the requested size before returning its flat shuffled song list.
- `getTopSongs` deterministically falls back to case-insensitive artist-name lookup when ID-path lookup misses, including artist names containing hyphens.
- `getSimilarSongs` uses artist-to-similar-artist graph data; `getSimilarSongs2` merges similar-artist tracks with genre and same-artist fallback sources to avoid empty responses when similarity metadata is sparse.
- `getLyrics` resolves by best-match library track (artist/title query), then returns plain lyrics or synced lyrics flattened to plain text lines.
- Auth middleware supports `u/p`, `u/t/s`, and `apiKey`; bearer-token style OpenSubsonic auth variants remain unsupported.
- `getAlbumInfo2` `notes` currently use mapped library metadata (album title fallback) because soundspan does not maintain dedicated album notes fields.
- Classic `getArtistInfo` accepts artist, album, or song IDs and resolves album/song inputs to their owning artist. Classic `getAlbumInfo` accepts album or song IDs and resolves songs to their owning album. Raw IDs use the same fallback resolution. The `*Info2` variants retain strict artist-ID and album-ID typing.
- Local streams, including transcode tiers, are fully materialized to a file before the response starts. The streaming service therefore sends the exact file length. `estimateContentLength=true` does not replace that known value with an estimate, and Range responses continue to use their exact range length. This avoids an inaccurate HTTP message length that could truncate playback or leave a client waiting for bytes that will never arrive.
- `getPodcasts` / `getNewestPodcasts` are empty-response compatibility stubs: soundspan's native podcast domain is not exposed over `/rest`, and stub responses keep probing clients (Music Assistant) from failing.
- Album payload `created` reports `Album.lastSynced` — the same timestamp `getAlbumList type=newest` orders by — not the release date; `year` carries release metadata.
- Some optional query keys outside the validated client matrix may still be ignored.

## Missing Subsonic/OpenSubsonic API Surface (Exhaustive)

Spec coverage snapshot (current):

- Implemented endpoints: `56` (2 of these are empty-response podcast stubs)
- Catalog endpoints tracked for compatibility: `84`
- Missing endpoints: `28`

### System (missing)

- None

### Browsing (missing)

- `getVideos`
- `getVideoInfo`

### Lists (missing)

- None

### Searching (missing)

- None

### Media Retrieval (missing)

- `hls`
- `getCaptions`

### Media Annotation (missing)

- None

### Sharing (missing)

- `getShares`
- `createShare`
- `updateShare`
- `deleteShare`

### Podcast (missing)

`getPodcasts` and `getNewestPodcasts` are implemented as empty-response
compatibility stubs (see Implementation Gaps above). Still missing:

- `refreshPodcasts`
- `createPodcastChannel`
- `deletePodcastChannel`
- `deletePodcastEpisode`
- `downloadPodcastEpisode`
- `getPodcastEpisode`

### Jukebox (missing)

- `jukeboxControl`

### Internet Radio (missing)

- `getInternetRadioStations`
- `createInternetRadioStation`
- `updateInternetRadioStation`
- `deleteInternetRadioStation`

### Chat (missing)

- `getChatMessages`
- `addChatMessage`

### User Management (missing)

- `getUsers`
- `createUser`
- `updateUser`
- `deleteUser`
- `changePassword`

### Bookmarks and Play Queue (missing)

- None

### Library Scan (missing)

- None

### OpenSubsonic Transcoding Extensions (missing)

- `getTranscodeDecision`
- `getTranscodeStream`

## Which Missing Endpoints Are Required For This Project?

Decision basis:

- We are currently staying on Subsonic/OpenSubsonic feature implementation.
- Project objective is broad third-party client compatibility for soundspan's music-server use case.
- This does **not** require implementing every historical Subsonic domain (chat, jukebox, podcasts, videos, admin user provisioning) to deliver project value.

### Required (P0) to move toward practical client completeness

None in this category remain from the current P0 list.

### Recommended (P1) for broader ecosystem compatibility

- None

### Not required for soundspan's current Subsonic-track scope (non-goal unless strategy changes)

- Video domain: `getVideos`, `getVideoInfo`
- Podcast domain endpoints
- Jukebox and internet-radio management endpoints
- Chat endpoints
- Subsonic user-admin endpoints (`createUser`, `deleteUser`, etc.) where soundspan native auth/admin UI already owns this
- Share-link endpoints (optional; product decision dependent)

## Reference Catalogs Used For Gap Audit

- OpenSubsonic endpoint catalog: <https://opensubsonic.netlify.app/docs/endpoints/>
- Subsonic API endpoint catalog: <https://www.subsonic.org/pages/api.jsp>
