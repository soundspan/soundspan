# [2.6.0] Release Notes - 2026-08-26

## Release Summary

2.6.0 is a big quality-of-life release. You can now connect your own Last.fm and ListenBrainz accounts and soundspan will record what you listen to, including plays from Subsonic apps. Search puts songs you own and songs you can discover in one ranked list, every song gets a shareable link, and artists and albums you have browsed before now load instantly. Album downloads got stricter and more honest: albums download one at a time through a queue that survives restarts, partial downloads say so instead of claiming success, and Soulseek album downloads prefer one uploader's complete album folder. Under the hood, pages with thousands of tracks scroll smoothly, radio stations start quickly on large libraries, and Subsonic apps load much faster.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.6.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update: pull the new image, restart, and the database migrations apply automatically.
- **If you bring your own PostgreSQL:** a new search migration needs the `pg_trgm` extension. The bundled database image handles it automatically. If your database user cannot create extensions, run `CREATE EXTENSION IF NOT EXISTS pg_trgm;` as a superuser once before upgrading.
- The first start after upgrading can take longer on large libraries while database indexes are rebuilt. This happens once.
- Two defaults to know about: browsed artists and albums are now cached in the database (turn off with `CATALOG_PERSISTENCE=off`), and to offer Last.fm scrobbling the operator must set `LASTFM_API_KEY` and `LASTFM_SHARED_SECRET`. ListenBrainz needs no setup.

See [`docs/UPGRADING.md`](https://github.com/soundspan/soundspan/blob/2.6.0/docs/UPGRADING.md) for details.

## Fixed

- Docker Compose and all-in-one deployments now pass Last.fm scrobbling and catalog-persistence settings through to the app instead of silently ignoring them.
- Scrobble forwarding now preserves OpenSubsonic millisecond timestamps, disables provider connections after invalid authentication, rate-limits credential validation and Last.fm authorization on the distributed auth tier, rejects stale Last.fm authorization completions, and mounts both Last.fm secret values from a configured Helm existing Secret (#761).
- TIDAL and YouTube Music sidecar containers no longer crash at startup after the `app.py` decomposition when the repository-root path probe runs outside the repository directory layout.
- Album downloads that deliver only part of the requested album now fail with a "Partial download: N/M tracks" status instead of reporting success, and library reconciliation no longer marks a multi-track request complete off a single-track album (#826).
- TIDAL downloads now tag ALBUMARTIST with the album artist instead of the per-track artist, preventing multi-artist album tracks from splitting into phantom single-track albums.
- Artist "Download all missing albums" now skips promotion-, bootleg-, or pseudo-release-only groups, remix/live/demo/compilation groups, and releases where the artist is only a featured credit; MusicBrainz enumeration failures now fail the expansion instead of reporting no missing albums (#824).
- TIDAL and YouTube Music album matching no longer downloads an unrelated release when the requested album is missing; the job now fails over to the configured provider or fails honestly instead (#825).
- Library scans no longer create duplicate albums when album tags differ only by case, diacritics, punctuation, or `&`/`and`; existing scanner-created duplicates in the same directory merge automatically during scan maintenance (#828).
- Lidarr download cleanup is more predictable: retries stay responsive, and manually picking a release no longer fights with automatic search (#789).
- Album downloads that select Soulseek, including TIDAL or YouTube Music runtime fallbacks and the default setting, now download through Soulseek instead of silently using Lidarr (#788).
- Playing music no longer re-renders large parts of the app once per second: pages and controls now subscribe only to the playback details they actually show, and dragging the volume slider updates just the volume controls instead of rippling through every open page (#785).
- Queued album downloads waiting on the deployment-wide claim now return to Bull with a delay instead of occupying an active worker slot for up to four hours.
- Pressing get-all-missing-albums now queues the artist's albums immediately even while other downloads are running (#808).
- Radio stations now start quickly on large libraries, and genre and decade stations load instantly without recounting the full library on every request (#776). Preferences now reorder the selected station without promoting liked tracks into it or displacing disliked tracks near the cutoff.
- Provider matching now treats accents, punctuation, conjunctions, and album edition suffixes consistently, reducing wrong or missed album and track matches (#791).
- Post-scan download reconciliation no longer risks heavy database load when many downloads are queued.
- Long track lists (Liked Songs, queue, large playlists) now render only the rows on screen instead of every row at once, so pages with thousands of tracks scroll smoothly and no longer stutter once per second during playback (#784).
- Download bookkeeping jobs now run in their own fast lane, so slow maintenance work can no longer delay download status updates, and multi-worker deployments coordinate outage recovery correctly (#780).
- Slow or unresponsive Lidarr album-catalog requests now abort within a bounded reconciliation tick instead of piling up overlapping requests and memory use (#779).
- Album genres, label, and release year now populate during normal background enrichment instead of only via the admin per-album tool, and admin re-enrichment now applies the same rules as the background worker.
- Search results now reflect library changes immediately after a scan or deletion; artist-page popular tracks and discography now recognize remasters and editions you own (#758).
- Artist-page popular tracks now show artist identity and use correct Last.fm durations for unowned tracks (#757).
- Tracks you do not own on the artist page keep their row menu, so Go to artist and Go to album stay available (#757).
- Artist-wide downloads now expand through the background album-download pipeline and no longer require Lidarr, allowing TIDAL- and YouTube-only deployments to queue the full discography.
- Artist-wide download jobs now expose durable enumeration progress through the artist MBID instead of leaving the Download All button waiting on per-album rows.
- Album and artist jobs rejected during Redis queue admission now remain pending for automatic recovery instead of becoming stranded failures.
- Retrying a download no longer cuts off album titles that contain a dash.
- Finishing a batch of album downloads now triggers one combined library scan instead of one scan per album, which could crash the background worker.
- Library scans now skip embedded covers during routine metadata parsing and extract new-album covers one at a time to reduce memory spikes.
- Two different TIDAL tracks whose names collapse to the same filename no longer overwrite each other; the second download is saved under a disambiguated name, while legacy files without embedded TIDAL identity still refresh in place at their planned path.
- Album downloads from YouTube Music no longer silently skip a track when two song names collide into the same filename — the second track is saved under a disambiguated name.
- Retrying a failed album download now uses the configured download source instead of always routing to Lidarr.
- TIDAL downloads now convert tracks detected as lossless to real FLAC files. Tracks detected as AAC-only are saved as `.m4a` instead of mislabeled `.flac`; when codec detection is unavailable, the original file is kept as-is.
- Max-quality (Hi-Res) TIDAL downloads are no longer saved as broken files missing their opening data.
- [Security] The metrics endpoint now rate-limits failed access attempts, and internal Subsonic auth-type reporting no longer re-reads credential query parameters.
- [Security] The DCLAP vibe provider now refuses requests when its internal secret is missing or left at the default, instead of silently allowing them.

## Added

- Helm deployments can now optionally set library scan concurrency and catalog persistence retention through chart values.
- Every local track now gets an audio fingerprint during analysis. If you add a free AcoustID key (`ACOUSTID_API_KEY`), soundspan uses the fingerprints to confirm exactly which recording each file is via MusicBrainz — quietly, in the background (#763).
- Soulseek album downloads now prefer a single uploader's complete, consistent album folder, so albums arrive as one matching set instead of a mix of sources; when no good folder exists, tracks are still assembled individually as before (#762).
- Scrobbling: each user can connect their own Last.fm and ListenBrainz accounts under Settings -> Scrobbling. Finished tracks and now-playing updates are forwarded — including plays made through Subsonic apps — and delivery never delays playback (#761).
- Artists and albums you browse are now remembered locally, so repeat visits load instantly and survive MusicBrainz outages; a retention sweep clears entries untouched for 180 days (`CATALOG_RETENTION_DAYS`), and `CATALOG_PERSISTENCE=off` disables the feature (#760).
- Search now shows one Songs section: songs you own and songs you don't sit together (external matches carry provider badges and skip anything already in your library) instead of being split across distant "Songs in Your Library" and "Songs to Discover" sections (#756).
- Songs now have shareable links: "Copy link to song" in a track's menu copies a link that opens the album with that song highlighted and starts playing it (browsers may require a tap first on brand-new devices) (#756).
- Songs in search results now have the full row menu and like/dislike buttons, and external "Songs to Discover" play right from the results when a streaming provider match exists (with TIDAL/YouTube badges) instead of only linking to the artist page (#756).
- Popular tracks on the artist page now show the album name as a clickable link, including for tracks that are not in your library (#757).
- Search API supports offset pagination for type-scoped searches.

## Changed

- Download retries, stale-job cleanup, Lidarr queue reconciliation, and notification delivery now use focused internal modules without changing the manager's public behavior (#790).
- Lidarr album acquisition, discovery tags, and reconciliation now use focused internal modules without changing the service API or download behavior (#790).
- The full-screen player's swipe gestures (track skip, swipe-down to close, drawer handle) now run through one tested gesture module, in preparation for further player decomposition.
- The full-screen player's Up Next list now renders only the rows in view, so very large queues open and scroll smoothly, and the Queue, Lyrics, and Related panels fetch their data independently so an open player does less background work.
- Listen Together's connection handling and "ready to play" reporting now run through small tested modules, making group playback behavior easier to verify without changing how sessions work.
- Subsonic search and artist views now share the main library's data layer.
- Internal route handling now shares validation, pagination, and ownership middleware, and enrichment and YouTube Music administrator errors use the documented response format.
- App screens now share one catalog of data-cache keys, so library, playlist, download, and notification views refresh reliably after changes instead of occasionally showing stale lists.
- The TIDAL streamer now uses focused internal modules, and all Python sidecars use one shared-package import prefix without changing their HTTP APIs.
- Worker claims and transient Prisma retries now use shared internal primitives, and worker modules can be imported without registering processors or schedules.
- Internal TIDAL and YouTube provider plumbing now uses shared types and routing adapters, and Deezer API calls now use the shared rate limiter.
- The enrichment worker now idles cheaply when the library is fully enriched.
- Subsonic apps load artist lists much faster on large libraries, and genre shuffle pages now load consistently fast.
- TIDAL and YouTube Music downloads now use identical filename and collision handling, and loudness backfills now measure tracks with multiple workers.
- Federation catalog syncs now batch database writes and refresh only affected artist counts instead of recounting every artist.
- CI now blocks on typechecks, backend tests, and coverage while a split enforcement gate provides faster merge feedback.
- Python sidecar image builds now import their runtime entrypoints from the built container before publishing tags to GHCR (#845).
- Backend Jest tests now use transpile-only TypeScript transforms, six workers, and smaller runtime suites for faster test runs.
- Database indexes now match frequent embedding, library, radio, playlist, and notification queries, while unused single-column audio-feature indexes no longer add write overhead.
- Moved backend Listen Together and federation metrics contracts into cycle-free type modules.
- Moved the shared route error-response helper into utilities and expanded the route module index with an enforced CI coverage check.
- Album covers now resolve through one provider ladder with unified caching, replacing six surface-specific implementations.
- Artist images now resolve through one provider ladder with unified caching, instead of five surface-specific implementations.
- Search now matches songs by artist and album name, tolerates typos, and ranks fallback results by similarity instead of alphabetically.
- Download job metadata updates now flow through guarded helpers instead of ad-hoc merges scattered across the backend.
- TIDAL and YouTube Music library downloads now run through one shared processor with per-source steps, so fixes apply to both sources at once.
- Consolidated repeated backend error handling, download-job state transitions, availability probes, queue event wiring, and value parsing behind shared internal helpers.
- The Python sidecars now share one hardened implementation of their path-safety and runtime helpers instead of maintaining copies.
- The TIDAL playlist and mix explore pages now share one implementation, settings connection tests share one status hook, and dates and durations render through shared formatters. Album pages now show total length compactly (for example "2h 30m").
- Album downloads now use queued, serialized processing, one album at a time across the deployment, with renewable claims, restart recovery, and queue-owned lifecycle reconciliation.
- Lidarr-routed album downloads no longer wait behind in-flight TIDAL/YouTube downloads; the one-at-a-time throttle now applies only to the streaming providers.
- The DCLAP vibe provider now answers malformed requests with the same 422 response the other sidecars use (previously 400).
- Library scans now process several files at once within a configurable bound, making large-library scans significantly faster.

## Deprecated

- `DISCOVERY_MODE=legacy` remains accepted but now serves the modern discovery implementation and logs one deprecation warning at process startup (#795).

## Removed

- The legacy discovery implementation was removed behind an accept-and-redirect shim; `DISCOVERY_MODE=legacy` now serves the modern discovery pages (#795).
- Removed the unused frontend charting dependency (recharts).

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- New optional settings: `LASTFM_API_KEY` + `LASTFM_SHARED_SECRET` (enable Last.fm scrobbling), `ACOUSTID_API_KEY` (AcoustID track identification), `CATALOG_PERSISTENCE` / `CATALOG_RETENTION_DAYS` (browsed-metadata cache), and `SCAN_FILE_CONCURRENCY` (library scan parallelism). All are available in Compose, the AIO image, and the Helm chart.
- The Helm chart leaves the new tuning values unset unless you configure them, so existing overrides keep working.
- Sidecar images are now boot-tested inside the built container before they are published, so a broken image can no longer reach the registry (#845).
- CI now blocks merges on type checks, tests, and coverage.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.6.0
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- Standard Docker and Helm deployments need no manual steps; five database migrations apply automatically on first start.
- External-PostgreSQL deployments may need the `pg_trgm` extension pre-created — see "Before you upgrade".

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.6.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.5.0...2.6.0](https://github.com/soundspan/soundspan/compare/2.5.0...2.6.0)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.6.0/CHANGELOG.md
