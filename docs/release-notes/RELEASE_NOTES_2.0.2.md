# [2.0.2] Release Notes - 2026-08-13

Soundspan 2.0.2 fixes M3U playlist import previews for large libraries. Under
2.0.1, the M3U preview request used the default 15-second timeout, and the
matcher re-sorted and re-normalized the whole library for every playlist
entry, so large previews timed out before they finished. The 2.0.2 preview
request allows 60 seconds, and the matcher resolves entries against a
prebuilt library index, so previews complete in a fraction of the old time.
Match results are unchanged.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.0.2. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

If you already run 2.0.0 or 2.0.1, no action is required before the upgrade.

## Deployment and distribution

- Docker images: `ghcr.io/soundspan/*:2.0.2`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.0.2
```

The chart is published only after all eight `2.0.2` image tags are available.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.0.2. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full changelog

- Compare changes: [2.0.1...2.0.2](https://github.com/soundspan/soundspan/compare/2.0.1...2.0.2)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.0.2/CHANGELOG.md)
