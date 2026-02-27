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
2. Use [`FEATURE_INDEX.json`](../.agents-config/docs/FEATURE_INDEX.json) to locate feature entrypoints quickly
3. Use [`TEST_MATRIX.md`](../.agents-config/docs/TEST_MATRIX.md) to run targeted impacted checks before broader suites
4. Use [`ROUTE_MAP.md`](../.agents-config/docs/ROUTE_MAP.md) to jump straight to backend endpoint and frontend page handlers
5. Use domain start-here guides in [`../backend/src/routes/README.md`](../backend/src/routes/README.md), [`../backend/src/services/README.md`](../backend/src/services/README.md), and [`../frontend/features/README.md`](../frontend/features/README.md)
6. Follow contribution flow in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
7. Use CI visibility details in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and workflow summaries

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
| [`REPO_INDEXING.md`](../.agents-config/docs/REPO_INDEXING.md) | Contributors/agents | Deterministic local indexing/vectorization, drift controls, and retrieval operations |
| [`FEATURE_INDEX.json`](../.agents-config/docs/FEATURE_INDEX.json) | Contributors/agents | Machine-readable feature map linking domains to implementation files, tests, and docs |
| [`TEST_MATRIX.md`](../.agents-config/docs/TEST_MATRIX.md) | Contributors/agents | Canonical feature-to-targeted-test command matrix for fast local validation |
| [`ROUTE_MAP.md`](../.agents-config/docs/ROUTE_MAP.md) | Contributors/agents | Generated backend endpoint and frontend route map for quick entrypoint discovery |
| [`JSDOC_COVERAGE.md`](../.agents-config/docs/JSDOC_COVERAGE.md) | Contributors/agents | Generated baseline of exported-symbol JSDoc coverage by backend/frontend area |
| [`LOGGING_STANDARDS.md`](../.agents-config/docs/LOGGING_STANDARDS.md) | Contributors/agents | Canonical frontend/backend/python logging contract and compliance workflow |
| [`RELEASE_NOTES_TEMPLATE.md`](../.agents-config/docs/RELEASE_NOTES_TEMPLATE.md) | Maintainers | Canonical release-notes format and command (`npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>]`) |

## Compatibility and Brand

| Document | Purpose |
| --- | --- |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Canonical release and feature change log for this repository |
| [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) | Supported `/rest` compatibility contract, known gaps, and validation evidence |
| [`BRAND_POLICY.md`](BRAND_POLICY.md) | Brand usage rules, naming constraints, and attribution guidance for soundspan |

---

Quick helper commands:
- `npm run feature-index:verify` validates `.agents-config/docs/FEATURE_INDEX.json` coverage against `frontend/features/*`.
- `npm run route-map:verify` validates `.agents-config/docs/ROUTE_MAP.md` is up to date with backend/frontend route sources.
- `npm run domain-readmes:verify` validates per-domain start-here READMEs are up to date.
- `npm run jsdoc-coverage:verify` validates `.agents-config/docs/JSDOC_COVERAGE.md` is up to date with current exported-symbol scan results.
- `npm run logging:compliance:verify` validates raw logging callsites against the enforced baseline contract.
