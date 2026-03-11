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

1. Start with [`ARCHITECTURE.md`](ARCHITECTURE.md) for service topology and request flows
2. Read [`DATA_MODEL.md`](DATA_MODEL.md) for entity relationships and resolution chains
3. Use [`TEST_MATRIX.md`](TEST_MATRIX.md) for fast, targeted test commands by domain
4. Use [`TESTING.md`](TESTING.md) for test framework/layout/command standards
5. Use [`../AGENTS.md`](../AGENTS.md) for the active ACM repo contract
6. Use domain start-here guides in [`../backend/src/routes/README.md`](../backend/src/routes/README.md), [`../backend/src/services/README.md`](../backend/src/services/README.md), and [`../frontend/features/README.md`](../frontend/features/README.md)
7. Use [`FEATURE_INDEX.json`](FEATURE_INDEX.json) for machine-readable feature-to-code mapping
8. Use [`maintainers/README.md`](maintainers/README.md) for retained maintainer-only guidance
9. Follow contribution flow in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
10. Use CI visibility details in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and workflow summaries

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
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Contributors/agents | Service topology, request flows, service communication map |
| [`DATA_MODEL.md`](DATA_MODEL.md) | Contributors/agents | Entity relationships (mermaid ERD), classification, resolution chains |
| [`TEST_MATRIX.md`](TEST_MATRIX.md) | Contributors/agents | Domain-to-test-file mapping for fast targeted verification |
| [`FEATURE_INDEX.json`](FEATURE_INDEX.json) | Agents | Machine-readable feature-to-code mapping for navigation and verification |
| [`TESTING.md`](TESTING.md) | Contributors/operators | Test frameworks, directory structure, commands, CI coverage visibility, and manual-vs-automated boundaries |
| [`../AGENTS.md`](../AGENTS.md) | Contributors/agents | Active ACM repo contract and task loop |
| [`ACM_FEATURE_PLANS.md`](ACM_FEATURE_PLANS.md) | Contributors/agents | Visible repo-local schema for formal feature plans stored in ACM |
| [`maintainers/README.md`](maintainers/README.md) | Maintainers | Index of retained maintainer-only guidance |
| [`maintainers/LOGGING_STANDARDS.md`](maintainers/LOGGING_STANDARDS.md) | Maintainers | Current shared logging guidance for runtime code |
| [`maintainers/RELEASE_NOTES_TEMPLATE.md`](maintainers/RELEASE_NOTES_TEMPLATE.md) | Maintainers | Manual release-notes scaffold for published releases |

## Design Documents

| Document | Status | Purpose |
| --- | --- | --- |
| [`designs/provider-strategy-track-mapping.md`](designs/provider-strategy-track-mapping.md) | Design phase | Provider strategy overhaul, browse redesign, TrackMapping data model |
| [`designs/explore-page-consolidation.md`](designs/explore-page-consolidation.md) | Design phase | Merge Home/Browse/Radio/Discovery into single Explore page |

## Compatibility and Brand

| Document | Purpose |
| --- | --- |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Canonical release and feature change log for this repository |
| [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) | Supported `/rest` compatibility contract, known gaps, and validation evidence |
| [`BRAND_POLICY.md`](BRAND_POLICY.md) | Brand usage rules, naming constraints, and attribution guidance for soundspan |

---

Key ACM helper commands:
- `acm context --project soundspan --task-text "<task>" --phase plan` starts scoped work.
- `acm verify --project soundspan --phase review --file-changed <path>` runs repo-defined verification.
- `acm review --run --project soundspan --receipt-id <receipt-id>` satisfies repo-defined workflow gates when `.acm/acm-workflows.yaml` selects the current task.
- `acm verify --project soundspan --receipt-id <receipt-id> --phase review --file-changed <path>` selects `acm-feature-plan-validate` for feature-relevant work and runs it with active receipt/plan context.
- `python3 scripts/acm-feature-plan-validate.py` is the repo-local validator behind that verify check and can be run directly for debugging.
- `acm health --project soundspan --include-details` checks ACM index/rules health.
- `acm work search --project soundspan --scope all --query "<topic>"` finds current and historical work by topic.
- `acm work list --project soundspan --scope all` lists the broader work inventory when you need to browse history.
