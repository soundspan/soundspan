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
5. Use [`../AGENTS.md`](../AGENTS.md) for the active AWM repo contract
6. Use domain start-here guides in [`../backend/src/routes/README.md`](../backend/src/routes/README.md), [`../backend/src/services/README.md`](../backend/src/services/README.md), and [`../frontend/features/README.md`](../frontend/features/README.md)
7. Use [`FEATURE_INDEX.json`](FEATURE_INDEX.json) for machine-readable feature-to-code mapping
8. Use [`maintainers/README.md`](maintainers/README.md) for retained maintainer-only guidance
9. Use [`DEPENDENCY_OVERRIDES.md`](DEPENDENCY_OVERRIDES.md) for the npm override register and monthly shed policy
10. Follow contribution flow in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
11. Use CI visibility details in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and workflow summaries

---

## For Users and Operators

| Document                                                                                       | Audience                 | Purpose                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../README.md`](../README.md)                                                                 | Everyone                 | Product overview, highlights, and quick start                                                                                                   |
| [`USAGE_GUIDE.md`](USAGE_GUIDE.md)                                                             | Users                    | Navigation, playback behavior, keyboard shortcuts, and administration                                                                           |
| [`DEPLOYMENT.md`](DEPLOYMENT.md)                                                               | Self-hosters/operators   | Docker run/compose deployment modes, release channels, and updates                                                                              |
| [`UPGRADING.md`](UPGRADING.md)                                                                 | Users/operators          | Operator-facing notes for upgrades that need action, newest first; unlisted releases are drop-in                                                |
| [`UPGRADING_TO_2.0.0.md`](UPGRADING_TO_2.0.0.md)                                               | Users/operators          | Focused migration and compatibility notes for the 2.0.0 upgrade                                                                                 |
| [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md)                               | Operators/admins         | External-access config, secret handling, and security hardening                                                                                 |
| [`OIDC_SSO.md`](OIDC_SSO.md)                                                                   | Operators/admins         | OIDC provider setup, account linking, role management, app passwords, and recovery                                                              |
| [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md)                                         | Operators/admins         | Complete env var reference by container with defaults and status labels                                                                         |
| [`INTEGRATIONS.md`](INTEGRATIONS.md)                                                           | Operators/admins         | Setup guides for Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, and OpenSubsonic                                                       |
| [`ADVANCED_ANALYSIS_AND_GPU.md`](ADVANCED_ANALYSIS_AND_GPU.md)                                 | Power users/operators    | DCLAP vibe provider details and optional MusiCNN GPU acceleration                                                                               |
| [`KUBERNETES.md`](KUBERNETES.md)                                                               | Kubernetes operators     | Helm and manual Kubernetes deployment guidance                                                                                                  |
| [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md)                                 | Operators/network admins | Reverse proxy and Cloudflare Tunnel routing guidance                                                                                            |
| [`MIGRATING_FROM_LIDIFY.md`](MIGRATING_FROM_LIDIFY.md)                                         | Operators/maintainers    | Step-by-step migration runbook for moving a Lidify deployment to soundspan                                                                      |
| [`NATIVE_AUDIO_ENGINE.md`](NATIVE_AUDIO_ENGINE.md)                                             | Users/operators          | Native `<audio>`-element playback engine (default as of 1.8.0): selection precedence, platform pins, and how to opt back into the legacy engine |
| [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md) (deprecated)      | Operators                | Segmented-streaming guidance (experimental feature)                                                                                             |
| [`kima-hub-v1.6.3-to-v1.7.5-adoption-report.md`](kima-hub-v1.6.3-to-v1.7.5-adoption-report.md) | Maintainers              | Archival adoption report; retained for historical reference, not current work tracking                                                          |

## For Contributors and Maintainers

| Document                                                                         | Audience                 | Purpose                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                             | Contributors/agents      | Service topology, request flows, service communication map                                                                                     |
| [`DATA_MODEL.md`](DATA_MODEL.md)                                                 | Contributors/agents      | Entity relationships (mermaid ERD), classification, resolution chains                                                                          |
| [`TEST_MATRIX.md`](TEST_MATRIX.md)                                               | Contributors/agents      | Domain-to-test-file mapping for fast targeted verification                                                                                     |
| [`matrix.md`](matrix.md)                                                         | Contributors/agents      | Playback-surface button availability matrix, plus enforced hard caps, pagination defaults, and UI display limits, each with file:line pointers |
| [`FEATURE_INDEX.json`](FEATURE_INDEX.json)                                       | Agents                   | Machine-readable feature-to-code mapping for navigation and verification                                                                       |
| [`TESTING.md`](TESTING.md)                                                       | Contributors/operators   | Test frameworks, directory structure, commands, CI coverage visibility, and manual-vs-automated boundaries                                     |
| [`SECURITY.md`](SECURITY.md)                                                     | Contributors             | Security reporting, supported versions, and contributor security requirements                                                                  |
| [`DEPENDENCY_OVERRIDES.md`](DEPENDENCY_OVERRIDES.md)                             | Contributors/maintainers | Active npm override register, add-new-override policy, removal conditions, and monthly shed procedure                                            |
| [`../AGENTS.md`](../AGENTS.md)                                                   | Contributors/agents      | Active AWM repo contract and task loop                                                                                                         |
| [`AWM_FEATURE_PLANS.md`](AWM_FEATURE_PLANS.md)                                   | Contributors/agents      | Visible repo-local schema for formal feature plans stored in AWM                                                                               |
| [`modernization-roadmap.md`](modernization-roadmap.md)                           | Contributors/maintainers | Canonical index of modernization review findings (F1-F54), grouped into epics, with per-finding status tracking                                |
| [`maintainers/README.md`](maintainers/README.md)                                 | Maintainers              | Index of retained maintainer-only guidance                                                                                                     |
| [`maintainers/LOGGING_STANDARDS.md`](maintainers/LOGGING_STANDARDS.md)           | Maintainers              | Current shared logging guidance for runtime code                                                                                               |
| [`maintainers/RELEASE_NOTES_TEMPLATE.md`](maintainers/RELEASE_NOTES_TEMPLATE.md) | Maintainers              | Machine-consumed release-notes template used by the guarded generation helper                                                                  |

## Design Documents

| Document                                                                                                     | Status       | Purpose                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| [`designs/loudness-and-transitions.md`](designs/loudness-and-transitions.md)                                 | Design phase | Loudness normalization (LUFS/ReplayGain) and analysis-driven smart transitions  |
| [`designs/federation-protocol-compat.md`](designs/federation-protocol-compat.md)                             | Approved     | Tolerant envelope parsing and capability advertisement for additive federation fields |
| [`designs/natural-language-music.md`](designs/natural-language-music.md)                                     | Design phase | Local-LLM natural-language playlists: compile-not-generate trust boundary       |
| [`designs/blends-and-federated-discovery.md`](designs/blends-and-federated-discovery.md)                     | Design phase | Taste vectors, max-min fairness Blends, peer catalogs as discovery surface      |
| [`designs/vibe-embedding-provider.md`](designs/vibe-embedding-provider.md)                                   | Design phase | Pluggable vibe embedding provider, versioned embedding spaces, DCLAP default    |
| [`designs/provider-strategy-track-mapping.md`](designs/provider-strategy-track-mapping.md)                   | Design phase | Provider strategy overhaul, browse redesign, TrackMapping data model            |
| [`designs/explore-page-consolidation.md`](designs/explore-page-consolidation.md)                             | Design phase | Merge Home/Browse/Radio/Discovery into single Explore page                      |
| [`designs/durable-track-identity.md`](designs/durable-track-identity.md)                                     | Shipped      | Durable local track identity, soft removal, revival, and retention purge design |
| [`designs/federated-library-sharing.md`](designs/federated-library-sharing.md)                               | Shipped      | Federated library-sharing product and protocol design                           |
| [`designs/federated-library-sharing-implementation.md`](designs/federated-library-sharing-implementation.md) | Implemented  | Delivery plan and implementation record for federated library sharing           |

## Compatibility and Brand

| Document                                                         | Purpose                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`../CHANGELOG.md`](../CHANGELOG.md)                             | Canonical release and feature change log for this repository                                                                    |
| [`release-notes/`](release-notes/)                               | Per-release human-readable notes (summary, known issues, compatibility notes), generated from the CHANGELOG at release-cut time |
| [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) | Supported `/rest` compatibility contract, known gaps, and validation evidence                                                   |
| [`BRAND_POLICY.md`](BRAND_POLICY.md)                             | Brand usage rules, naming constraints, and attribution guidance for soundspan                                                   |

---

Key AWM helper commands:

- `awm context --project soundspan --task-text "<task>" --phase plan` starts scoped work.
- `awm verify --project soundspan --phase review --file-changed <path>` runs repo-defined verification; backend changes stay receipt-scoped and targeted here.
- `awm review --run --project soundspan --receipt-id <receipt-id>` satisfies repo-defined workflow gates when `.awm/awm-workflows.yaml` selects the current task.
- `awm review --run --project soundspan --receipt-id <receipt-id>` also promotes full backend `build` + `test:coverage` when the active receipt includes backend or shared media-contract changes.
- `awm verify --project soundspan --receipt-id <receipt-id> --phase review --file-changed <path>` selects `awm-feature-plan-validate` for feature-relevant work and runs it with active receipt/plan context.
- `python3 scripts/awm-feature-plan-validate.py` is the repo-local validator behind that verify check and can be run directly for debugging.
- `awm health --project soundspan --include-details` checks AWM index/rules health.
- `awm work search --project soundspan --scope all --query "<topic>"` finds current and historical work by topic.
- `awm work list --project soundspan --scope all` lists the broader work inventory when you need to browse history.
