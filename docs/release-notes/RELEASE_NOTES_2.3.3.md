# [2.3.3] Release Notes - 2026-08-18

## Release Summary

This is a fix release for everyone who upgraded to 2.3.2. The 2.3.2 audio
analyzer container could not start — two of the new volume-leveling files
never made it into the image — so audio analysis and loudness measurement
were silently stalled: Kubernetes deployments kept running the old analyzer,
and the all-in-one image restarted its analyzer in a loop. 2.3.3 ships
complete analyzer images and adds a build-time check so an incomplete image
can never pass CI again. The release also makes federation tolerant of
version differences between peers: a newer peer's extra fields no longer
cause tracks to be skipped, and servers now only send fields a peer
understands. Upgrading from 2.3.x is a plain rolling update.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.3.3. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- Straightforward rolling upgrade from 2.3.x - a small database migration
  runs automatically and no special procedure is needed. If you are coming
  from 2.2.x or earlier, follow the 2.3.0 upgrade steps first.
- If you are on 2.3.2, upgrade promptly: loudness measurement has not been
  running since you upgraded. It resumes automatically on 2.3.3 and catches
  up in the background.

## Fixed

- Fixed the 2.3.2 audio-analyzer images failing to start because two new
  loudness modules were missing from both the standalone and all-in-one
  images. On Kubernetes this looked like a stuck rollout with the new
  analyzer pod in CrashLoopBackOff; on the all-in-one image the analyzer
  restarted in a loop in the background. A new CI check now verifies every
  analyzer module is present in the images before a release can build.

## Added

- Federation peers now advertise what they understand ("capabilities")
  when pairing and during regular health checks, so servers on different
  versions only exchange fields both sides support.

## Changed

- Federation sync now tolerates fields from newer peers instead of skipping
  the affected tracks. Unknown fields are safely ignored and counted, so
  mixed-version federations keep syncing fully during upgrades.
- For contributors: the frontend component-test commands now fail fast with
  clear guidance when run on Node.js older than 24 instead of failing with
  dozens of confusing errors.

## Removed

- None documented in this release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- Federation compatibility is observable: fields stripped from newer peers
  are counted in `soundspan_federation_sync_skips_total` on the metrics
  endpoint, with the peer and field names in the server log.
- A `capabilities` column is added to the federation peer table
  automatically at startup. No action needed.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.3.3
```

## Breaking Changes

- None.

## Known Issues

- Libraries that spent time on 2.3.2 will have a loudness-measurement
  backlog; it clears automatically in the background after upgrading, and
  volume leveling covers more of the library as it converges.

## Compatibility and Migration

- The federation peer capabilities column is added automatically at
  startup. No manual migration steps for standard Docker and Helm
  deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.3.3. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.3.2...HEAD](https://github.com/soundspan/soundspan/compare/2.3.2...HEAD)
- Full changelog: https://github.com/soundspan/soundspan/blob/HEAD/CHANGELOG.md
