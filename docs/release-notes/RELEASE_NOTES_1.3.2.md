# soundspan 1.3.2 Release Notes - 2026-03-06

## Release Summary

soundspan 1.3.2 brings visual polish to the Home and Explore pages, fixes a Listen Together recovery race, and resolves two library sync issues where downloaded albums could stay hidden and provider track imports could stall. On the operations side, CI image builds are consolidated into a single pipeline and project tooling has been migrated to the ACM control plane.

## Fixed

- Listen Together guests could experience doubled playback or unexpected stops when follower-side stall/handoff recovery ran at the same time as a session resync after mid-track buffering. Recovery is now delegated to the group resync path so only one recovery runs at a time.
- Albums downloaded from TIDAL or YouTube Music could remain hidden behind a "remote" state after a library scan picked up the local files. The scanner now promotes those albums into the user's owned library automatically.
- Track-mapping reconciliation could get stuck retrying the same oldest skipped rows indefinitely instead of making progress through the backlog. It now sweeps forward, so imported provider tracks switch over to local copies after a scan completes.

## Added

- My Liked and Discover Weekly cards on the Home and Explore pages now display a small overlay icon (heart and lightning bolt, respectively) for clearer visual identity at a glance.

## Changed

- Discover Weekly uses a lightning bolt icon instead of a compass across Home, Explore, and the Discover hero section.
- Discover Weekly and My Liked hero sections now show actual cover art from their first track instead of a generic placeholder icon.
- My Liked page header uses a single cover image instead of the previous mosaic grid layout.

## Admin/Operations

- CI image builds consolidated from 8 separate GitHub Actions workflows into a single unified pipeline with shared release-tag validation, reducing workflow maintenance overhead.
- Project tooling migrated from custom agent-config scripts to the ACM control plane, removing approximately 30,000 lines of legacy governance scaffolding.
- Pull request checks now use ACM-driven verification for backend coverage, frontend lint/build/coverage, and Helm chart rendering.
- Developer documentation reorganized under `docs/maintainers/` and streamlined across README, CONTRIBUTING, and TESTING guides.
- Backend runtime tests updated to match current API response shapes and behavior.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.3.2
```

## Breaking Changes

No breaking changes in this release.

## Known Issues

- YouTube Music personalized mixes (My Mix, Discover Mix, etc.) are implemented but dormant due to an upstream YouTube API limitation tracked in ytmusic-api issue #813. The feature will activate automatically once the upstream blocker is resolved.

## Compatibility and Migration

No migration steps required. This is a drop-in replacement for 1.3.1.

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.3.1...v1.3.2
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md
