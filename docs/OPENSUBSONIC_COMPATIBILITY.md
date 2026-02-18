# OpenSubsonic Compatibility (Current Fork Status)

Last updated: 2026-02-14

## Scope

This document defines the current `/rest` compatibility contract implemented in this fork and captures readiness evidence used to close the current OpenSubsonic phase gate.

## Milestone Status

- Current OpenSubsonic compatibility milestone: `Complete` (for soundspan's in-scope music client surface)
- Remaining missing domains are intentionally out-of-scope for this milestone unless real client demand requires promotion.

## Client Connection URL

- Split frontend/backend deployments: use the frontend base URL for clients (for example `http://host:3030` in deployment, `http://host:3031` in local dev). Frontend proxies `/rest` to backend.
- Backend-direct deployments: clients may target backend directly (`http://host:3006`).

## Supported Auth Modes

- `u` + `p` (plain and `enc:` hex password forms)
- `u` + `t` + `s` token mode (`t = md5(subsonicPassword + salt)`)
- `apiKey` query auth (OpenSubsonic extension), with optional `u` username consistency check
- Required protocol params: one auth mode, `v`, `c` (`u` required for password/token auth, optional for `apiKey`)
- Response formats: JSON, XML, JSONP (`f` + optional `callback`)

## Implemented Endpoint Surface

Tier A foundation and browse/search/media:

- `ping`, `getLicense`, `getOpenSubsonicExtensions`, `tokenInfo`, `getMusicFolders`, `getIndexes`
- `getArtists`, `getArtist`, `getArtistInfo2`, `getAlbum`, `getAlbumInfo2`, `getSong`, `getTopSongs`, `getSimilarSongs`, `getSimilarSongs2`, `getMusicDirectory`, `getAlbumList`, `getAlbumList2`, `getGenres`, `getSongsByGenre`, `getRandomSongs`, `search`, `search2`, `search3`
- `stream`, `download`, `getCoverArt`, `getLyrics`, `getLyricsBySongId`

Tier B mutation/readiness:

- `getUser`, `getAvatar`
- `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`
- `getPlayQueue`, `savePlayQueue`, `getPlayQueueByIndex`, `savePlayQueueByIndex`
- `getBookmarks`, `createBookmark`, `deleteBookmark` (compatibility no-op surface)
- `getScanStatus`, `startScan`
- `scrobble`, `getNowPlaying`
- `getStarred`, `getStarred2`, `star`, `unstar`, `setRating`

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

## Readiness Evidence (2026-02-14 Manual Validation)

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

## Third-Party Client Profile Matrix (2026-02-14)

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
- `savePlayQueueByIndex.view` persisted indexed queue state (`index=2`, `position=1234`) for a real track.
- `getPlayQueueByIndex.view` returned matching indexed state (`entries=1`, expected track id, expected `current` and `position`).

Automation support:

- `cd backend && npm run test:smoke` executes baseline health checks and Subsonic profile checks when `SMOKE_SUBSONIC_USER` + `SMOKE_SUBSONIC_PASSWORD` are provided.
- `SMOKE_MODE=full` enables extended non-GUI client emulation (browse/search/list, profile/avatar, playlist lifecycle, queue baseline/indexed read, starred baseline, now-playing baseline, scan contract checks).
- `SMOKE_REQUIRE_TRACKS=true` enforces track-dependent coverage (song/album/artist metadata calls, lyrics-by-song, rating/star/unstar, scrobble, queue mutations with track IDs, stream/cover-art probes) and fails if no library songs are available.
- `SMOKE_ENABLE_FIXTURES=true` provisions a temporary DB-backed artist/album/track fixture when full-mode strict checks require tracks but the library has none; cleanup is automatic by default (`SMOKE_FIXTURE_CLEANUP=false` disables cleanup for debugging).
- `SUBSONIC_TRACE_LOGS=true` enables backend `/rest` trace lines for real-client troubleshooting (`endpoint`, `c`, `v`, `f`, HTTP status, Subsonic protocol status/error code) without logging auth secrets.

Automated run evidence (2026-02-14):

- Command: `cd backend && SOUNDSPAN_BASE_URL=http://127.0.0.1:3007 SMOKE_SUBSONIC_USER=opensubsonic-matrix SMOKE_SUBSONIC_PASSWORD=*** SMOKE_MODE=full SMOKE_REQUIRE_TRACKS=true SMOKE_ENABLE_FIXTURES=true DATABASE_URL=postgresql://... npm run test:smoke`
- Result: `health` + `matrix` + strict full emulation all passed; a temporary fixture track was created and cleaned automatically to execute track-dependent checks on an empty-library dataset.

## Known Gaps / Non-Goals for Current Milestone

- This is not a full OpenSubsonic superset; unimplemented endpoints remain out of scope for the current phase.
- Validation now includes a third-party client-profile matrix (curl-driven request emulation of real client patterns), but full GUI-client certification runs are still pending.

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
- `getNowPlaying` currently reports only the authenticated user's active playback state, not global multi-user now-playing.
- `getPlayQueue`/`savePlayQueue` currently use the legacy playback-state device bucket (`deviceId=legacy`) for compatibility clients.
- `getPlayQueueByIndex`/`savePlayQueueByIndex` map index `0` to `deviceId=legacy` and index `N` to `deviceId=legacy-N`.
- `getBookmarks` currently returns an empty bookmark list and `createBookmark`/`deleteBookmark` are protocol-success no-ops (bookmark persistence is not modeled yet).
- `startScan` is compatibility-throttled with a cooldown window; repeated requests during cooldown return current scan status and do not enqueue new scan jobs.
- `getIndexes` now honors `musicFolderId` filtering and `ifModifiedSince` no-change semantics.
- `getArtists` now honors `musicFolderId` filtering.
- `search`/`search2`/`search3` now honor `musicFolderId` filtering, normalize quoted-empty full-sync queries (`query=\"\"`), and treat zero counts as bounded full-sync requests.
- `search`/`search2`/`search3` now pass through large offset values without a hard `10000` clamp so client pagination can complete on very large libraries.
- Song/album protocol payloads now project `genre` from library metadata (prefer `userGenres`, then `genres`), and genre-filtered song responses (`getSongsByGenre`, `getRandomSongs` with `genre`) force explicit `genre` values in each returned song item.
- `getTopSongs` now deterministically falls back to case-insensitive artist-name lookup when ID-path lookup misses, including artist names containing hyphens.
- `getSimilarSongs` uses artist-to-similar-artist graph data; `getSimilarSongs2` merges similar-artist tracks with genre and same-artist fallback sources to avoid empty responses when similarity metadata is sparse.
- `getLyrics` currently resolves by best-match library track (artist/title query), then returns plain lyrics or synced lyrics flattened to plain text lines.
- Auth middleware now supports `u/p`, `u/t/s`, and `apiKey`; bearer-token style OpenSubsonic auth variants remain unsupported.
- `getAlbumInfo2` `notes` currently use mapped library metadata (album title fallback) because soundspan does not maintain dedicated album notes fields.
- Some optional query keys outside the validated client matrix may still be ignored.

## Missing Subsonic/OpenSubsonic API Surface (Exhaustive)

Spec coverage snapshot (current):

- Implemented endpoints: `52`
- Catalog endpoints tracked for compatibility: `84`
- Missing endpoints: `32`

### System (missing)

- None

### Browsing (missing)

- `getVideos`
- `getVideoInfo`
- `getArtistInfo`
- `getAlbumInfo`

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

- `getPodcasts`
- `getNewestPodcasts`
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
