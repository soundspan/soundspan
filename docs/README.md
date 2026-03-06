# Documentation Index

This index is the central navigation page for all project documentation under `docs/`.

## Suggested Reading Paths

### New users

1. Read [`../README.md`](../README.md) for the product overview
2. Follow the deploy flow in [`DEPLOYMENT.md`](DEPLOYMENT.md)
3. Read [`USAGE_GUIDE.md`](USAGE_GUIDE.md) for navigation, playback, and admin basics
4. Configure essentials via [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md)

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
2. Use [`../AGENTS.md`](../AGENTS.md) for the active ACM repo contract
3. Use domain start-here guides in [`../backend/src/routes/README.md`](../backend/src/routes/README.md), [`../backend/src/services/README.md`](../backend/src/services/README.md), and [`../frontend/features/README.md`](../frontend/features/README.md)
4. Use [`maintainers/README.md`](maintainers/README.md) for retained maintainer-only guidance
5. Follow contribution flow in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
6. Use CI visibility details in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and workflow summaries

---

## For Users and Operators

| Document | Audience | Purpose |
| --- | --- | --- |
| [`../README.md`](../README.md) | Everyone | Product overview, highlights, and quick start |
| [`USAGE_GUIDE.md`](USAGE_GUIDE.md) | Users | Navigation, playback behavior, keyboard shortcuts, and administration |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Self-hosters/operators | Docker run/compose deployment modes, release channels, and updates |
| [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) | Operators/admins | External-access config, secret handling, and security hardening |
| [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) | Operators/admins | Complete env var reference by container with defaults and status labels |
| [`INTEGRATIONS.md`](INTEGRATIONS.md) | Operators/admins | Setup guides for Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, and OpenSubsonic |
| [`ADVANCED_ANALYSIS_AND_GPU.md`](ADVANCED_ANALYSIS_AND_GPU.md) | Power users/operators | CLAP analysis service details and optional GPU acceleration |
| [`KUBERNETES.md`](KUBERNETES.md) | Kubernetes operators | Helm and manual Kubernetes deployment guidance |
| [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md) | Operators/network admins | Reverse proxy and Cloudflare Tunnel routing guidance |
| [`MIGRATING_FROM_LIDIFY.md`](MIGRATING_FROM_LIDIFY.md) | Operators/maintainers | Step-by-step migration runbook from kima-hub to soundspan |
| [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md) | Operators | Segmented-streaming guidance (experimental feature) |

## For Contributors and Maintainers

| Document | Audience | Purpose |
| --- | --- | --- |
| [`TESTING.md`](TESTING.md) | Contributors/operators | Test frameworks, directory structure, commands, CI coverage visibility, and manual-vs-automated boundaries |
| [`../AGENTS.md`](../AGENTS.md) | Contributors/agents | Active ACM repo contract and task loop |
| [`maintainers/README.md`](maintainers/README.md) | Maintainers | Index of retained maintainer-only guidance |
| [`maintainers/LOGGING_STANDARDS.md`](maintainers/LOGGING_STANDARDS.md) | Maintainers | Current shared logging guidance for runtime code |
| [`maintainers/RELEASE_NOTES_TEMPLATE.md`](maintainers/RELEASE_NOTES_TEMPLATE.md) | Maintainers | Manual release-notes scaffold for published releases |

## Compatibility and Brand

| Document | Purpose |
| --- | --- |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Canonical release and feature change log for this repository |
| [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) | Supported `/rest` compatibility contract, known gaps, and validation evidence |
| [`BRAND_POLICY.md`](BRAND_POLICY.md) | Brand usage rules, naming constraints, and attribution guidance for soundspan |

---

Key ACM helper commands:
- `acm get-context --project soundspan --task-text "<task>" --phase plan` starts scoped work.
- `acm verify --project soundspan --phase review --file-changed <path>` runs repo-defined verification.
- `acm health --project soundspan --include-details` checks ACM index/rules health.
- `acm work search --project soundspan --scope all --query "<topic>"` finds current and historical work by topic.
- `acm work list --project soundspan --scope all` lists the broader work inventory when you need to browse history.
