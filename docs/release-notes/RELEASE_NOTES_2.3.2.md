# [2.3.2] Release Notes - 2026-08-18

## Release Summary

This release brings volume leveling to soundspan: playback volume now evens
out automatically across your library, so a quiet 90s album and a loud
modern one play at a comfortable, consistent level. Leveling is on by
default in an "Automatic" mode that keeps albums sounding the way they were
mastered and levels everything else per song — each listener can change or
turn it off under Settings → Playback. The release also fixes playback with
Music Assistant and other Subsonic apps that send POST requests, stops the
vibe embedding service from crashing on very long tracks (DJ mixes, live
sets), and cleans up several rough edges in Library Health and the vibe map.
Upgrading from 2.3.x is a plain rolling update.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.3.2. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- Straightforward rolling upgrade from 2.3.0 or 2.3.1 - new database columns
  are added automatically and no special procedure is needed. If you are
  coming from 2.2.x, follow the 2.3.0 upgrade steps first.
- **Behavior change:** volume leveling ships enabled (Automatic mode) for
  every user. It only turns loud songs down and gives quiet songs a small,
  clip-safe boost; anyone who prefers the old behavior can set it to Off
  under Settings → Playback → Volume leveling.

## Fixed

- Fixed playback with Music Assistant and other Subsonic clients that send
  form-encoded POST requests. Thanks to @ORi0N for the contribution.
- Fixed the vibe embedding service running out of memory and restarting in a
  loop when the library contains very long tracks: audio is now measured
  from a capped window (default 30 minutes) and processed in small chunks.
- Fixed the Library Health "Delete all now" purge getting stuck when a
  removed track was linked to a streaming-service match, and the section now
  shows live progress and a clear reason if a purge stops.
- Fixed the purge status showing "Purging — 0 tracks remaining" forever
  after a purge finished.
- Fixed the vibe map failing permanently on memory-constrained servers; it
  now builds in the background with a progress message on first load
  instead of timing out.
- Fixed enrichment progress and failure counts including deleted tracks, so
  cleared failures stop reappearing and the status no longer sticks on
  "Processing podcasts".

## Added

- **Volume leveling** (on by default): per-song and per-album loudness is
  measured during audio analysis, existing libraries are measured in the
  background without re-running full analysis, and the web player levels
  playback with a per-user mode (Automatic / By track / By album / Off).
- Subsonic apps that support ReplayGain (for example Symfonium) now receive
  gain and peak values and can level volume on their own. The reference
  level is configurable with `LOUDNESS_TARGET_LUFS` (default -18).
- A "Vibe" entry in the main navigation, so the vibe map no longer requires
  going through a track's context menu.
- An admin control in Library Health to purge all removed tracks
  immediately instead of waiting for the retention window.

## Changed

- The Cache & Automation settings section was modernized: consistent status
  colors, accurate stage labels, tooltips on the Re-run controls, and a
  confirmation before Re-enrich All starts an hours-long rebuild.
- The upgrade guides were rewritten around release versions with
  Docker-Compose-first instructions for the all-in-one image.

## Removed

- The per-user "Subsonic password" field was removed from Settings in favor
  of app passwords (Settings → Sign-in & Security). Existing Subsonic
  passwords keep working for now; they will be removed in a future release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- New environment variables: `LOUDNESS_TARGET_LUFS` (leveling reference,
  default -18), `LOUDNESS_MEASURE_TIMEOUT_SECONDS`,
  `LOUDNESS_BACKFILL_BATCH_SIZE`, `DCLAP_MAX_AUDIO_SECONDS` (long-track
  decode cap, default 1800), and `VIBE_MAP_WORKER_MEMORY_MB` (vibe map heap
  ceiling, default 512). Defaults are sensible; no action needed.
- Loudness measurement coverage is visible on the metrics endpoint as
  `soundspan_loudness_coverage`.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.3.2
```

## Breaking Changes

- None. Volume leveling defaulting to on is a behavior change, not a
  breaking one — it is per-user switchable and cannot clip or distort audio.

## Known Issues

- Tracks are leveled as background measurement completes, so during the
  first hours after upgrading some songs may still play at their original
  volume. Coverage converges automatically.

## Compatibility and Migration

- Database columns for loudness data are added automatically at startup.
  No manual migration steps for standard Docker and Helm deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.3.2. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.3.1...HEAD](https://github.com/soundspan/soundspan/compare/2.3.1...HEAD)
- Full changelog: https://github.com/soundspan/soundspan/blob/HEAD/CHANGELOG.md
