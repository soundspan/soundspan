# soundspan 1.3.4 Release Notes - 2026-03-09

## Release Summary

soundspan 1.3.4 fixes three user-facing bugs: liked remote tracks that were saved with placeholder metadata now repair themselves automatically, the Listen Together 500-track queue cap once again silently trims oversized queues instead of rejecting them, and queue-derived UI state no longer recalculates unnecessarily during playback.

## Fixed

- Remote tracks (TIDAL or YouTube Music) that were liked or replayed while still carrying placeholder "Unknown" metadata now automatically resolve to real artist/title information on the next play or during the background metadata backfill. The TIDAL repair job also no longer depends on which authenticated user happens to appear first in the database.
- Listen Together queue creation and shared-queue additions once again trim oversized queues down to the 500-track cap instead of failing the request entirely.
- Queue-derived UI state (track IDs, ordering) no longer recalculates on every render when the actual queue membership hasn't changed, reducing unnecessary re-renders during local playback and Listen Together sessions.

## Changed

- No user-facing changes. Internal maintainer verification tooling was updated (ACM review scripts, frontend coverage checks, Python sidecar test scaffolds).

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.3.4
```

## Breaking Changes

No breaking changes in this release.

## Known Issues

- YouTube Music personalized mixes (My Mix, Discover Mix, etc.) are implemented but dormant due to an upstream YouTube API limitation tracked in ytmusic-api issue #813. The feature will activate automatically once the upstream blocker is resolved.

## Compatibility and Migration

No migration steps required. This is a drop-in replacement for 1.3.3.

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.3.3...v1.3.4
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md
