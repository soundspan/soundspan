# [2.6.1] Release Notes - 2026-08-26

## Release Summary

2.6.1 is a small follow-up to 2.6.0 focused on making setup smoother. Connecting a Last.fm account now gives clear guidance instead of a generic error — if you click "finish" before approving in the Last.fm tab, the app now tells you exactly that. Docker Compose and all-in-one deployments can now set every documented optional setting (about 40 previously documented variables were never passed into the containers), and Helm users get a chart value for the music-requests feature flag.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.6.1. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update: pull the new image and restart. No database migrations ship in this release.
- Upgrading from a version before 2.6.0? Read the [2.6.0 notes](https://github.com/soundspan/soundspan/blob/2.6.0/docs/release-notes/RELEASE_NOTES_2.6.0.md) first — they cover the database and setup notes for that release.

## Fixed

- Docker Compose and all-in-one deployments can now set every documented optional tuning and integration variable; previously, about 40 documented variables were not forwarded into the containers.
- Connecting Last.fm before approving access no longer shows a generic internal error, and credential or availability problems report clearly.

## Added

- Helm deployments can configure the music-requests feature flag through `config.features.requests`.

## Changed

- CI now verifies that environment variables used by the backend and Python services stay documented and available through a deployment surface.

## Deprecated

- None documented in this release.

## Removed

- Nothing removed in this release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- Every variable documented in the environment reference is now settable on Docker Compose and all-in-one deployments; a CI check keeps code, documentation, and deployment files in sync going forward.
- The Scrobbling settings page now names exactly which Last.fm server value is missing (`LASTFM_API_KEY` or `LASTFM_SHARED_SECRET`) when Last.fm is unavailable. The shared secret is intentionally never displayed anywhere.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.6.1
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.6.1. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.6.0...2.6.1](https://github.com/soundspan/soundspan/compare/2.6.0...2.6.1)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.6.1/CHANGELOG.md
