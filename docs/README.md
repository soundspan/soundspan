# Documentation Index

This index is the central navigation page for all project documentation under `docs/`.

## User and Operator Guides

| Document | Audience | Purpose |
| --- | --- | --- |
| [`../README.md`](../README.md) | Everyone | Product overview, key features, quick start, and core usage flow |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Self-hosters/operators | Docker run/compose deployment modes, release channels, and updates |
| [`MIGRATING_FROM_LIDIFY.md`](MIGRATING_FROM_LIDIFY.md) | Operators/maintainers | Complete step-by-step migration runbook from `https://github.com/Chevron7Locked/kima-hub` to soundspan |
| [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) | Operators/admins | Environment variables, external-access config, secret handling, and security hardening |
| [`INTEGRATIONS.md`](INTEGRATIONS.md) | Operators/admins | Setup guides for Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, and OpenSubsonic |
| [`ADVANCED_ANALYSIS_AND_GPU.md`](ADVANCED_ANALYSIS_AND_GPU.md) | Power users/operators | CLAP analysis service details and optional GPU acceleration |
| [`KUBERNETES.md`](KUBERNETES.md) | Kubernetes operators | Helm and manual Kubernetes deployment guidance |
| [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md) | Operators/network admins | Reverse proxy and Cloudflare Tunnel routing guidance |
| [`TESTING.md`](TESTING.md) | Contributors/operators | Test frameworks, directory structure, commands, CI coverage visibility, and manual-vs-automated boundaries |
| [`REPO_INDEXING.md`](REPO_INDEXING.md) | Contributors/agents | Deterministic local indexing/vectorization, drift controls, and retrieval operations |
| [`RELEASE_NOTES_TEMPLATE.md`](RELEASE_NOTES_TEMPLATE.md) | Maintainers | Canonical release-notes format and command (`npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>]`) |

## Compatibility and Brand Tracking

| Document | Purpose |
| --- | --- |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Canonical release and feature change log for this repository |
| [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) | Supported `/rest` compatibility contract, known gaps, and validation evidence |
| [`BRAND_POLICY.md`](BRAND_POLICY.md) | Brand usage rules, naming constraints, and attribution guidance for soundspan |

## Suggested Reading Paths

### New users

1. Read [`../README.md`](../README.md)
2. Follow the deploy flow in [`DEPLOYMENT.md`](DEPLOYMENT.md)
3. Configure essentials via [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md)

### Operators enabling integrations

1. Deploy and validate base app via [`DEPLOYMENT.md`](DEPLOYMENT.md)
2. Configure secrets and service URLs via [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md)
3. Enable integrations using [`INTEGRATIONS.md`](INTEGRATIONS.md)

### Kubernetes users

1. Start with [`KUBERNETES.md`](KUBERNETES.md)
2. Apply edge routing guidance from [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md)
3. Refer to [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) for env and secret policy

### Contributors and maintainers

1. Start with [`TESTING.md`](TESTING.md) for test framework/layout/command standards
2. Follow contribution flow in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
3. Use CI visibility details in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and workflow summaries
