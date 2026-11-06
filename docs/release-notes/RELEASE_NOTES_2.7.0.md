# [2.7.0] Release Notes - 2026-11-06

## Release Summary

2.7.0 lets admins back up the whole server and restore it on a fresh install, brings your liked TIDAL and YouTube Music songs into the Library and Search, and lets people follow a music request until the album is in the library. It is also a security release: Node.js 24.22.2 fixes the Node2Shell Brotli flaw (CVE-2026-111497), and Next.js 16.4.3 fixes two remote code execution flaws. TIDAL album downloads work again, the Vibe Map rebuilds itself and shows when it was last built, and plain-`http://` installs no longer need `SECURE_COOKIES=false` for backup downloads and the queue dashboard.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.7.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update: pull the new image, restart, and five database migrations apply automatically. None of them needs a new PostgreSQL extension.
- Upgrade promptly. This release fixes the Node2Shell flaw and two Next.js remote code execution flaws (see Fixed).
- **If you use HTTPS through a proxy that does not send `X-Forwarded-Proto`**, set `SECURE_COOKIES=true`. With `SECURE_COOKIES` unset, soundspan's own cookies are now `Secure` only when the proxy reports an HTTPS request. An existing `SECURE_COOKIES=false` keeps working.
- **If you run the TIDAL or YouTube Music sidecar**, pull the sidecar images too. The all-in-one compose file pulls only the all-in-one image, and the TIDAL album download fix and the YouTube Music Brotli fix are in the sidecar images.
- **If you have scripts that use the request API with an API key**, `GET /api/requests` and `GET /api/requests/mine` now return one page as an object instead of a plain list. See Breaking Changes.
- Declining an album request now starts a 30-day wait before anyone can request that album again. Set `REQUESTS_DENIED_COOLDOWN_DAYS` to change it, or `0` to turn it off. Declines made before the upgrade do not start a wait.

See [`docs/UPGRADING.md`](https://github.com/soundspan/soundspan/blob/2.7.0/docs/UPGRADING.md) for details.

## Fixed

- [Security] The backend, frontend, and all-in-one images run Node.js 24.22.2, which fixes the Node2Shell Brotli decoder flaw (CVE-2026-111497): a crafted Brotli-compressed request body or `fetch()` response could corrupt server memory. The YouTube Music sidecar's `brotli` package moves to 1.2.1 for the same flaw.
- [Security] Next.js 16.4.3 fixes two unauthenticated remote code execution flaws (image optimization and `use cache` functions) and a Server Actions denial of service. Backend `body-parser`, `multer`, `follow-redirects`, and `fast-uri`, and the sidecars' `filelock`, `msgpack`, `pyasn1`, `setuptools`, and `oauthlib`, move to fixed releases.
- [Security] Artist-name matching, library folder-name parsing, and Soulseek search ranking now take linear time. A name with a long run of spaces could make the server work much harder than needed (#991).
- [Security] `glob` and `minimatch` are forced to fixed releases through npm overrides, closing a filesystem-walk cancellation bypass and a pattern-expansion denial of service.
- TIDAL album downloads work again. The TIDAL sidecar reported every album's artist as `Unknown`, so every album download failed with `Album not found on TIDAL`.
- Search no longer shows other users' streaming albums. Before, everyone saw every streaming-only album on the server, which revealed other people's likes and led to "not found" pages (#953).
- The download reconciliation cycle no longer fails on a large Lidarr library. It now asks Lidarr only about downloads in progress, and makes no Lidarr requests when nothing is downloading.
- TIDAL and YouTube Music album downloads find albums whose titles are symbols, such as `( )`, `?`, or `!!!`, and treat look-alike characters such as `×` and `−` as their keyboard twins.
- TIDAL downloads that the sidecar rejects as unauthorized refresh the TIDAL sign-in and retry once, instead of retrying without limit.
- A music request whose download was cancelled no longer stays `Approved` forever, and a request whose album reached the library anyway is marked fulfilled (#725).
- Approving a request no longer downloads a different album by the same artist when every release of the requested album fails (#725).
- Artist pages no longer drop their MusicBrainz albums a day after they were first opened, and the saved discography now lists the same albums as MusicBrainz. Each artist's saved discography is rebuilt the next time the artist is opened.
- The `Download` button on an album page opened from a MusicBrainz release shows as pending while that album downloads (#926).
- Podcasts that publish episodes only as video (MP4, M4V, or WebM) now list and play them as audio. Existing subscriptions pick up the missing episodes on their next refresh (#910).
- On phones and tablets, the Now Playing screen has a visible `Minimize player` button again, and swiping down on its header no longer reloads the page and stops playback (#909).
- The API Keys settings page explains that keys go in an `X-API-Key` header and shows a copy-ready example (#897).
- Removing an audiobook now also removes its listening progress in the same step, so deleted books no longer linger in Continue Listening (#866).
- The all-in-one container starts against an existing database that has soundspan's tables but no Prisma migration history. If it cannot record the first migration, it stops with a `FATAL` message before it changes the database.

## Added

- **Backup and restore.** Admins can download a backup of the whole server from `Admin → Backup` and restore it on a fresh install from the first-run screen's `Restore from a backup`. The backup holds everything in the database, including accounts, settings, playlists, listening history, and audio analysis, so nothing needs a rescan or re-analysis. Music files, caches, Redis, and deployment config are not included. A passphrase protects the stored credentials, and memory use stays bounded on large servers. See `docs/BACKUP_AND_RESTORE.md` (#533).
- **Your streaming likes in the Library.** Songs you like on TIDAL or YouTube Music appear in your Library with a provider badge. `All` mixes them in, the new `Remote` button shows only the liked songs you don't have yet, and `Local` still shows only the files on this server. Each user sees only their own likes (#699).
- **Your streaming likes in Search.** Search lists your liked streaming songs that are not in your library in a `From your streaming services` group, and your own streaming albums in an `Albums from your streaming services` group (#699, #953).
- **Adding streaming songs to the library.** A streaming song's menu offers `Add album to library` or `Add song to library` (admins), or `Request album` (when requests are on). A background job matches the albums of liked songs to MusicBrainz, up to 25 albums an hour, so more of them can be downloaded or requested as whole albums (#926).
- **Following a request.** `My Requests` (avatar menu and phone side menu) shows whether an approved request is queued, downloading, or in your library, with an `Open album` link (#725).
- **Managing requests.** Admins can retry or decline a failed request, approve all of one user's pending requests, decline stale requests, and give a reason the requester sees. The `Requests` menu entry and the avatar show how many requests are pending, and every admin is notified when an approved request fails (#725).
- **Queue dashboard button.** `Admin → Open queue dashboard` opens Bull Board in a new tab with a 15-minute browser grant, and `End dashboard access` revokes it early (#897).
- **Vibe Map status and rebuilds.** The Vibe Map shows when it was last built and how many songs it covers, shows a `Re-analyzing` badge while a new analysis fills in, and gives admins a `Rebuild` button. It also rebuilds itself in the background once enough songs change, and on large libraries the sampled songs stay the same from one build to the next (#887, #896).
- Helm deployments can set the per-user music-request daily cap with `config.requestsPerUserPerDay`.

## Changed

- With `SECURE_COOKIES` unset, soundspan's own cookies (sign-in flow, queue dashboard, and backup download) follow the scheme the browser used. Before, unset meant `Secure` in production, which broke backup downloads and the queue dashboard on plain-`http://` installs.
- A failed request's notification says whether the download failed or was stopped, and that an admin can retry or decline it (#725).
- The Library's source buttons (`All` / `Local` / `Peers` / `Remote`) appear whenever peer libraries or a streaming service are available, not only when federation is on (#699).
- The scheduled Audiobookshelf sync also removes books that were deleted in Audiobookshelf. It removes a book only after the book is missing from two complete listings taken several minutes apart (#864).
- Soulseek runs on slsk-client 2. soundspan logs in again on its next search or download when the Soulseek server ends its session, and a download that runs past its time limit is cancelled (#943).
- The Vibe Map keeps its last loaded map for a few minutes when you leave and come back.
- Headers, filters, toggles, and section headings now look the same across the Library, Audiobooks, Podcasts, Playlists, Requests, Explore, Search, Radio, and detail pages (#868).
- The TIDAL and YouTube Music sidecar images run Python 3.15, with the same package versions as before.

## Deprecated

- None documented in this release.

## Removed

- Nothing removed in this release.

## Accessibility

- Native dropdown menus, such as sort, genre, and pagination on the Audiobooks and Podcasts pages, no longer show white text on a white popup.

## Admin/Operations

- New optional setting: `REQUESTS_DENIED_COOLDOWN_DAYS` (default 30, `0` turns it off), available in Compose, the all-in-one image, and Helm (`config.requestsDeniedCooldownDays`).
- `SECURE_COOKIES` now defaults to following the request's scheme. Set `true` or `false` to override it.
- New Prometheus metrics: `soundspan_vibe_map_builds_total`, `soundspan_vibe_map_build_seconds`, `soundspan_vibe_map_sampled`, `soundspan_vibe_map_rebuild_requests_total`, `soundspan_vibe_map_refresh_checks_total`, and `soundspan_library_remote_rows_capped_total`.
- New API endpoints: `POST /api/backup/session`, `GET /api/backup/download`, the anonymous `/api/restore` endpoints, `POST /api/vibe/map/rebuild`, `GET /api/requests/counts`, `POST /api/requests/bulk/approve`, `POST /api/requests/bulk/deny-stale`, and `POST /api/downloads/tidal-track`.
- `npm --prefix backend run test:smoke:soulseek` checks login, search, and a small download against the live Soulseek network with your own account.
- The background MusicBrainz album matcher shares the normal MusicBrainz rate limit, so other metadata lookups can run a little slower while it works through a large backlog.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.7.0
```

## Breaking Changes

- **Request API clients:** `GET /api/requests` and `GET /api/requests/mine` return one page as `{ requests, total, offset, limit }` instead of a plain list, and take `status`, `limit` (1–100, default 50), and `offset`. The soundspan web app is already updated (#725).
- **Library and Search API clients (heads-up):** the Library list endpoints default to `origin=all`, which now includes the signed-in user's liked TIDAL and YouTube Music songs. Those rows have no file. Pass `origin=local` to get only the files on this server. `GET /api/search` returns streaming albums under `remoteAlbums` instead of `albums`.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- Standard Docker and Helm deployments need no manual steps. Five database migrations apply automatically on first start:
  - Audiobook listening progress is tied to its audiobook, and orphaned progress rows are removed.
  - Every podcast's cached feed headers are cleared, so video-only episodes appear on the next refresh.
  - The albums table gets two empty columns for background MusicBrainz matches.
  - A new table holds saved artist discographies, and every artist's catalog sync time is cleared.
  - Music requests get a column that records when a declined album's re-request wait ends.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.7.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.6.1...2.7.0](https://github.com/soundspan/soundspan/compare/2.6.1...2.7.0)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.7.0/CHANGELOG.md
