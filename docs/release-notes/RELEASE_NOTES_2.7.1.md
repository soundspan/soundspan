# [2.7.1] Release Notes - 2026-11-06

## Release Summary

2.7.1 is a small security release for the audio analyzer. The analyzer and all-in-one images no longer carry the Python TensorFlow package, which the analyzer never used. That removes every keras and protobuf advisory that came with it and roughly halves the analyzer image. Analysis results do not change, and nothing is re-analyzed.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.7.1. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update: pull the new images and restart. There are no database migrations and no new settings.
- If you upgrade from a version before 2.7.0, read the [2.7.0 release notes](https://github.com/soundspan/soundspan/blob/2.7.1/docs/release-notes/RELEASE_NOTES_2.7.0.md) first.

## Fixed

- [Security] The audio analyzer and all-in-one images no longer install the Python TensorFlow package. It brought keras 2.15 and protobuf 4.25, whose advisories could not be fixed while it stayed installed (#717). The analyzer never loaded it: Essentia runs the MusiCNN mood and genre models through its own built-in TensorFlow runtime, which is unchanged. Mood, genre, and vibe results stay the same, and your library is not re-analyzed.
- [Security] The all-in-one image's protobuf, still used by the vibe provider, moves to 7.36.2. The analyzer image also drops the unused setuptools and wheel packages that came with its base image.

## Added

- No new features documented in this release.

## Changed

- The analyzer image shrinks from about 3.0 GB to 1.4 GB, and the all-in-one image from about 6.2 GB to 4.6 GB, so pulls are faster and use less disk.

## Deprecated

- None documented in this release.

## Removed

- The unused Python TensorFlow package and the packages that only it needed, from the analyzer and all-in-one images.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- Python dependency audits and image scans no longer carry any accepted exceptions for the analyzer.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.7.1
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments. There are no database migrations, and the analyzer keeps its analysis version, so stored analysis and vibe embeddings stay valid.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.7.1. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.7.0...2.7.1](https://github.com/soundspan/soundspan/compare/2.7.0...2.7.1)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.7.1/CHANGELOG.md
