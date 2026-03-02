# OWNERSHIP.md

Managed ownership matrix for bootstrap/sync behavior.
Generated from `.agents-config/tools/bootstrap/managed-files.template.json`.

## Summary

- Managed entries: 44
- Template-owned managed entries: 31
- Structured managed entries: 11
- Project-owned managed entries: 2
- Overrideable managed entries: 3

## Overrideable Managed Files

| Path | Profiles | Default Authority | Local Modes |
| --- | --- | --- | --- |
| `.agents-config/contracts/rules/canonical-ruleset.json` | `base` | `template` | adjacent `.override` or `.append` |
| `AGENTS.md` | `base` | `template` | adjacent `.override` or `.append` |
| `CLAUDE.md` | `base` | `template` | adjacent `.override` or `.append` |

## Project-Owned After Initial Seed

| Path | Profiles | Authority |
| --- | --- | --- |
| `.agents-config/config/project-tooling.json` | `base` | `project` |
| `.agents-config/policies/logging-compliance-baseline.json` | `typescript, javascript` | `project` |

## Structured Managed Files

| Path | Profiles | Authority |
| --- | --- | --- |
| `.agents-config/docs/AGENT_CONTEXT.md` | `base` | `structured` |
| `.agents-config/docs/AGENT_RULES.md` | `base` | `structured` |
| `.agents-config/docs/CONTEXT_INDEX.json` | `base` | `structured` |
| `.agents-config/docs/FEATURE_INDEX.json` | `typescript, javascript` | `structured` |
| `.agents-config/docs/LOGGING_STANDARDS.md` | `typescript, javascript` | `structured` |
| `.agents-config/docs/RELEASE_NOTES_TEMPLATE.md` | `base` | `structured` |
| `.agents-config/docs/TEST_MATRIX.md` | `typescript, javascript` | `structured` |
| `.agents-config/policies/agent-governance.json` | `base` | `structured` |
| `backend/src/routes/README.md` | `typescript, javascript` | `structured` |
| `backend/src/services/README.md` | `typescript, javascript` | `structured` |
| `frontend/features/README.md` | `typescript, javascript` | `structured` |

## Template-Owned Managed Files

| Path | Profiles | Authority |
| --- | --- | --- |
| `.agents-config/contracts/rules/canonical-ruleset.json` | `base` | `template` |
| `.agents-config/OWNERSHIP.md` | `base` | `template` |
| `.agents-config/rule-overrides.schema.json` | `base` | `template` |
| `.agents-config/scripts/agent-queue-lifecycle.mjs` | `base` | `template` |
| `.agents-config/scripts/agent-session-preflight.mjs` | `base` | `template` |
| `.agents-config/scripts/changelog-utils.mjs` | `base` | `template` |
| `.agents-config/scripts/enforce-agent-policies.mjs` | `base` | `template` |
| `.agents-config/scripts/generate-release-notes.mjs` | `base` | `template` |
| `.agents-config/scripts/generate-subagent-payload-stub.mjs` | `base` | `template` |
| `.agents-config/scripts/prepare-helm-chart-release.mjs` | `base` | `template` |
| `.agents-config/scripts/release-contract-check.mjs` | `base` | `template` |
| `.agents-config/scripts/release-version-sync.mjs` | `base` | `template` |
| `.agents-config/scripts/repair-queue-verification-evidence.mjs` | `base` | `template` |
| `.agents-config/scripts/verify-logging-compliance.mjs` | `typescript, javascript` | `template` |
| `.agents-config/tools/bootstrap/agent-managed-files.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/agent-sync.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/bootstrap-project.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/bootstrap-runtime.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/bootstrap.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/check-template-impact.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/generate-ownership-matrix.mjs` | `base` | `template` |
| `.agents-config/tools/bootstrap/managed-files.template.json` | `base` | `template` |
| `.agents-config/tools/docs/feature-index-check.mjs` | `typescript, javascript` | `template` |
| `.agents-config/tools/docs/generate-domain-readmes.mjs` | `typescript, javascript` | `template` |
| `.agents-config/tools/docs/generate-jsdoc-coverage.mjs` | `typescript, javascript` | `template` |
| `.agents-config/tools/docs/generate-openapi-coverage.mjs` | `typescript-openapi` | `template` |
| `.agents-config/tools/docs/generate-route-map.mjs` | `typescript, javascript` | `template` |
| `.agents-config/tools/rules/verify-canonical-ruleset.mjs` | `base` | `template` |
| `.github/workflows/pr-checks.yml` | `base` | `template` |
| `AGENTS.md` | `base` | `template` |
| `CLAUDE.md` | `base` | `template` |

## Notes

- Project-owned managed files are seeded once and then maintained locally.
- Structured managed files keep template-defined required sections/paths while preserving project-authored content.
- Template-owned managed files continue to follow template sync behavior.
- Generated artifacts may still be policy-required even when they are not managed entries.
