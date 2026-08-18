# [2.3.1] Release Notes - 2026-08-18

## Release Summary

A small, fast follow-up to 2.3.0 based on the first production deployment:
it stops a noisy database-deadlock loop in the background embedding
lifecycle (which was also slowing the automatic library re-analysis) and
fixes provider health not appearing in Settings on servers with a busy
Redis. Upgrading from 2.3.0 is a plain rolling update.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.3.1. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- Straightforward rolling upgrade from 2.3.0 - no schema changes and no special procedure. If you are coming from 2.2.x, follow the 2.3.0 upgrade steps first.

## Fixed

- Fixed embedding-space index checks so existing matching indexes are not
  rebuilt on every lifecycle tick.
- Fixed vibe worker status reads on large Redis keyspaces by using a bounded
  worker registry and removing expired entries.

## Added

- No new features documented in this release.

## Changed

- No behavior changes documented in this release.

## Removed

- Nothing removed in this release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- No admin/operations updates documented in this release.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.3.1
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.3.1. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.3.0...HEAD](https://github.com/soundspan/soundspan/compare/2.3.0...HEAD)
- Full changelog: https://github.com/soundspan/soundspan/blob/HEAD/CHANGELOG.md
