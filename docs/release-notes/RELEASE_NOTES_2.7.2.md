# [2.7.2] Release Notes - 2026-11-07

## Release Summary

2.7.2 fixes YouTube Music playback. Since 2.7.0, every YouTube Music song lookup started a JavaScript solver of about 300 MB inside the YouTube Music sidecar. On servers that give the sidecar a tight memory limit, the sidecar ran out of memory and restarted each time a song started, so songs and playlists would not play. Lookups now need about 60 MB again. Operators with memory to spare can also turn on a new fallback that retries songs the regular YouTube clients cannot play.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.7.2. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update: pull the new images and restart. There are no database migrations, and no setting is required.
- If you upgrade from a version before 2.7.0, read the [2.7.0 release notes](https://github.com/soundspan/soundspan/blob/2.7.2/docs/release-notes/RELEASE_NOTES_2.7.0.md) first.

## Fixed

- YouTube Music songs and playlists play again when the YouTube Music sidecar has a tight memory limit. The yt-dlp version shipped in 2.7.0 added a YouTube client (`tv_samsung`) to its defaults that needs YouTube's JavaScript player. Every song lookup then started a solver of about 300 MB, and a sidecar with a 256 MiB limit ran out of memory and restarted. Each restart stopped every song that was playing. Lookups and playback downloads now skip that client and use the same clients as 2.6.1, which return the same audio.

## Added

- An opt-in playback fallback for YouTube Music. Set `YTMUSIC_JS_CLIENT_FALLBACK=true` on the YouTube Music sidecar. When the regular clients cannot play a song, the sidecar retries that song once with yt-dlp's full client set, including the clients that need YouTube's JavaScript player. Each retry uses about 300 MB more, and the sidecar runs one retry at a time. The fallback is off by default. Give the sidecar at least 512 MB of memory before you turn it on. See [Memory and the playback fallback](https://github.com/soundspan/soundspan/blob/2.7.2/docs/INTEGRATIONS.md#memory-and-the-playback-fallback).

## Changed

- The frontend moves to Next.js 16.4.5, and the TIDAL and YouTube Music sidecars move to pydantic 2.14.3 and anyio 4.16.0. These are maintenance updates with no behavior change.

## Deprecated

- None documented in this release.

## Removed

- None documented in this release.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- The YouTube Music sidecar logs at startup whether the playback fallback is on, and logs each retry with the song's video ID.
- If you raised the YouTube Music sidecar's memory limit to work around this problem on 2.7.x, you can lower it again. Without the fallback, 256Mi is enough again; the chart default of 512Mi leaves room for the fallback.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.7.2
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments. There are no database migrations, and the new fallback setting is optional.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.7.2. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.7.1...2.7.2](https://github.com/soundspan/soundspan/compare/2.7.1...2.7.2)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.7.2/CHANGELOG.md
