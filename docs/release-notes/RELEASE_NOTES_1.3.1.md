# soundspan 1.3.1 Release Notes - 2026-03-05

## Release Summary

soundspan 1.3.1 is a stability-focused patch that hardens Listen Together sessions and improves streaming reliability. The queue is now hard-capped at 500 tracks with enforcement at every entry point, fixing a class of issues where large queues could disconnect users on page refresh. Concurrent audio transcoding is now deduplicated so multiple listeners requesting the same track quality share a single encoding job.

## Fixed

- Listen Together sessions could disconnect a user who hard-refreshed the page when the queue was large, because the full state snapshot exceeded the Socket.IO payload buffer. The queue is now capped at 500 tracks at every layer, keeping snapshots well within the transport limit.
- Listen Together playback could flicker or stall due to duplicate resume and recovery logic firing simultaneously — for example, when a follower's pause recovery raced with the reconnect delta handler after a brief network interruption.

## Added

No new features in this release.

## Changed

- Listen Together enforces a hard cap of 500 tracks on the queue. When starting a session with more than 500 tracks queued, the first 500 are kept and the rest are silently dropped. Adding tracks to an active session is rejected when it would exceed the cap. The limit is also applied when restoring groups from the database and when syncing state between backend pods, so pre-existing oversized groups are automatically trimmed.
- Queue input validation now runs only on the tracks that will actually be used (after truncation), avoiding unnecessary database lookups and provider API calls for tracks that would be discarded.
- Concurrent audio transcode requests for the same track and quality now share a single ffmpeg process instead of spawning duplicates. The transcoded file cache also uses an upsert strategy to prevent duplicate-record errors under concurrent writes.

## Admin/Operations

No admin or operational changes in this release.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.3.1
```

## Breaking Changes

No breaking changes in this release.

## Known Issues

- YouTube Music personalized mixes (My Mix, Discover Mix, etc.) are implemented but dormant due to an upstream YouTube API limitation tracked in ytmusic-api issue #813. The feature will activate automatically once the upstream blocker is resolved.

## Compatibility and Migration

No migration steps required. This is a drop-in replacement for 1.3.0.

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.3.0...v1.3.1
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md
