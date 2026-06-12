# soundspan 1.4.0 Release Notes - 2026-03-15

## Release Summary

soundspan 1.4.0 is a major browser-first feature release adding exploratory alternate playback-backend work for environments where browser audio output is limited, an interactive vibe map for visual library exploration, M3U/M3U8 playlist import, background import jobs, podcast bulk refresh, OpenSubsonic bookmark persistence, and a sleep timer — alongside import UX improvements, security hardening, and a batch of bug fixes across the vibe map, admin library health, import jobs, Listen Together, and the player UI.

## Fixed

- Admin Library Health now loads and dismisses health records through dedicated `/api/admin/library-health` endpoints instead of failing on a missing backend route.
- Library validation no longer deletes unrelated health records (e.g. `UNREADABLE_METADATA`) when clearing `MISSING_FROM_DISK` entries for tracks that reappear on disk.
- Generic import job cancellation now uses an intermediate `cancelling` state so late cancellations after playlist creation record the completed playlist instead of discarding it.
- Vibe map mood colors now match the actual mood keys emitted by the backend projection payload.
- Listen Together connection indicators no longer flicker grey during brief network reconnects; a 2-second grace period absorbs transient disconnects before updating the UI.
- Volume slider popup in the full player is narrower with better spacing between the slider track and percentage label.
- UMAP projection worker entrypoint now resolves correctly in both tsx source runtime and compiled dist builds.
- ACM cross-review now takes its Codex sandbox mode from workflow/script arguments instead of hardcoding `read-only` in the script.
- ACM cross-LLM review now sends an untrimmed scoped review packet into the nested Codex reviewer so the read-only sandbox no longer depends on inner shell access.

## Added

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

## Changed

- Import page now supports both streaming-service URL imports and local M3U/M3U8 file uploads with a tabbed input interface, and offers a "Run in Background" option for URL imports.
- Add-to-playlist picker now supports multi-select mode for adding a track to multiple playlists in one action.
- Podcast subscriptions now persist feed `ETag` and `Last-Modified` validators, and refresh reuses them for conditional GETs so 304 responses skip unnecessary episode rewrites.
- Last.fm no longer ships with a bundled fallback application key; operators must provide `LASTFM_API_KEY` via environment or System Settings.
- Outbound URL safety checks centralized through a shared validator, newly blocking IPv6 loopback, link-local, and unique-local redirect targets.
- README architecture diagram updated to reflect current system layout.

## Admin/Operations

- Operators who previously relied on a bundled Last.fm API key must now provide `LASTFM_API_KEY` via environment variable or System Settings for Last.fm scrobbling and recommendations to continue working.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.4.0
```

## Breaking Changes

- Last.fm integration no longer includes a bundled fallback API key. Operators must set `LASTFM_API_KEY` via environment or System Settings for Last.fm features to function.

## Known Issues

- YouTube Music personalized mixes (My Mix, Discover Mix, etc.) are implemented but dormant due to an upstream YouTube API limitation tracked in ytmusic-api issue #813. The feature will activate automatically once the upstream blocker is resolved.

## Compatibility and Migration

No migration steps required. This is a drop-in replacement for 1.3.4. Operators using Last.fm should ensure `LASTFM_API_KEY` is configured before upgrading (see Breaking Changes above).

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.3.4...v1.4.0
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md
