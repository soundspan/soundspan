# [2.4.1] Release Notes - 2026-08-22

## Release Summary

2.4.1 is a patch release focused on one high-impact fix: Subsonic apps (Symfonium, DSub, and friends) doing a full library sync against a large soundspan library could get a server error on every search page and finish with an empty library. That is fixed, and large full syncs now complete. The release also restores federation support for servers that must egress through a proxy (as an explicit opt-in), makes the Library Enrichment failures view agree with its summary tiles, fixes a web client error on empty API responses, and ships freshly patched images. Upgrading is a plain rolling update with no database migrations.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.4.1. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, no manual steps are required. This is a plain rolling update; no database migrations run.

## Fixed

- Subsonic clients can fully sync large libraries again. A full sync requests very large search pages, and loading the per-user play counts for those pages exceeded a PostgreSQL query limit — every page returned an error and clients such as Symfonium imported nothing. The lookups now run in bounded batches and large syncs complete.
- Servers that must reach the internet through a proxy can federate again by setting `FEDERATION_ALLOW_PROXY=true`. The 2.4.0 security hardening had disabled proxy handling on federation traffic unconditionally; the opt-in restores it while keeping peer address validation active. If you do not set the flag, nothing changes (#673).
- The web client no longer reports an error after actions that succeed with an empty server response (for example deleting a federation peer). Previously it tried to parse the empty response as JSON and showed a parse error even though the action had completed.
- The Library Enrichment failures dialog now matches the summary tiles. Stale failure entries whose track, artist, or analysis has since recovered are cleaned up automatically when you open the dialog, after "Retry all", and during every full enrichment run, so the "View Failures" count reflects what is actually still failing. Failure rows show a real error summary again instead of "Unknown error", an unfinished stage no longer displays a premature "100%", and the dialog layout no longer collapses under long failure lists.
- [Security] All published images are rebuilt on refreshed base images and now apply current Debian security updates at build time, and the Python sidecar images drop the pip tooling from their runtime layers. This clears every fixable HIGH-severity finding in image scanning; the few remaining findings live inside npm's own bundled dependencies and are tracked in #671.

## Added

- No new features documented in this release.

## Changed

- No behavior changes documented in this release.

## Deprecated

- None documented in this release.

## Removed

- Nothing removed in this release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- New optional environment variable `FEDERATION_ALLOW_PROXY` (default `false`): set to `true` only if your server must reach federation peers through an egress proxy (`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`).

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.4.1
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.4.1. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.4.0...2.4.1](https://github.com/soundspan/soundspan/compare/2.4.0...2.4.1)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.4.1/CHANGELOG.md
