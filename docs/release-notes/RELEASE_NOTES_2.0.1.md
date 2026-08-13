# [2.0.1] Release Notes - 2026-08-13

Soundspan 2.0.1 fixes the CLAP analyzer image for Helm deployments. Under the
2.0.0 chart's default probes, CLAP analyzer pods never became Ready because the
image did not include `pgrep`. The 2.0.1 image includes `pgrep`, so the default
liveness and readiness probes work.

## Before you upgrade

No action is required before the upgrade. If you set
`audioAnalyzerClap.livenessProbe` or `audioAnalyzerClap.readinessProbe` to
`null` as a workaround, you can remove those overrides after the upgrade.

## Deployment and distribution

- Docker images: `ghcr.io/soundspan/*:2.0.1`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.0.1
```

The chart is published only after all eight `2.0.1` image tags are available.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full changelog

- Compare changes: [2.0.0...2.0.1](https://github.com/soundspan/soundspan/compare/2.0.0...2.0.1)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.0.1/CHANGELOG.md)
