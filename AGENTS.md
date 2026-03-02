# AGENTS.md - Repository Agent Bootstrap

IMPORTANT: This file defines the mandatory startup sequence for ALL agent work in this repository. You MUST complete the full startup order below before doing ANY work — including answering questions, reading code, or making changes. This is a blocking requirement that applies to every agent (Claude, Codex, or any other LLM agent), every session, and every task regardless of complexity. Do not skip, defer, or partially complete the startup sequence under any circumstances.

After every context compaction or session reset, treat it as a fresh startup: re-read this file and complete the full startup order again, including re-reading `.agents/MEMORY.md` and any relevant submemory files, before resuming work.

## Quick Reference (Startup)

1. Follow `## Required Startup Order` and run `npm run agent:preflight`.
2. Treat preflight policy failures as blocking before implementation.
3. Plan execution work in `.agents/EXECUTION_QUEUE.json` before changing code.
4. Use `### Definition of Done` in `.agents-config/docs/AGENT_RULES.md` as the closeout gate.
5. Use the remaining sections below as full reference when needed.

## Full Contract Reference

## Local AGENTS Mode Picker

Local repository naming is the definitive mode selector:

- Override mode: if `AGENTS.override.md` exists, treat it as the authoritative local AGENTS contract and ignore `AGENTS.append.md`.
- Additive mode (default): if `AGENTS.override.md` is absent, use canonical `AGENTS.md` plus optional additive deltas in `AGENTS.append.md`.

## Required Startup Order

Always read these in order, no matter how trivial the work:

1. `AGENTS.md`
2. `AGENTS.override.md` (when present; override mode, then skip step 3)
3. `AGENTS.append.md` (when present and `AGENTS.override.md` is absent; additive-only local deltas)
4. `.agents-config/docs/AGENT_RULES.md`
5. `.agents-config/docs/CONTEXT_INDEX.json`
6. `.agents-config/docs/AGENT_CONTEXT.md`
7. `.agents/EXECUTION_QUEUE.json` (when present)
8. `.agents/MEMORY.md`
9. Run `npm run agent:preflight` to refresh `.agents/SESSION_BRIEF.json`

## Canonical Sources and Precedence

- Machine-readable canonical policy: `.agents-config/policies/agent-governance.json`
- Upstream bootstrap-source path for this document: `.agents-config/templates/AGENTS.md`
- Enforcement runner: `.agents-config/scripts/enforce-agent-policies.mjs`
- Session preflight generator: `.agents-config/scripts/agent-session-preflight.mjs`
- Canonical rule catalog: `.agents-config/contracts/rules/canonical-ruleset.json`
- Local rule override schema: `.agents-config/rule-overrides.schema.json`
- Optional local rule overrides file: `.agents-config/rule-overrides.json`
- Managed workflow manifest: `.agents-config/agent-managed.json`
- Managed workflow template seed: `.agents-config/tools/bootstrap/managed-files.template.json`
- Optional local AGENTS override file: `AGENTS.override.md`
- Optional local AGENTS append file: `AGENTS.append.md`
- Release notes source of truth: `CHANGELOG.md`
- Release notes template artifact: `.agents-config/docs/RELEASE_NOTES_TEMPLATE.md`
- Release notes generator: `.agents-config/scripts/generate-release-notes.mjs`
- Project tooling config for template-managed scripts: `.agents-config/config/project-tooling.json`
- Feature index artifact: `.agents-config/docs/FEATURE_INDEX.json`
- Test matrix artifact: `.agents-config/docs/TEST_MATRIX.md`
- Route map artifact: `.agents-config/docs/ROUTE_MAP.md`
- JSDoc coverage artifact: `.agents-config/docs/JSDOC_COVERAGE.md`
- OpenAPI coverage artifact: `.agents-config/docs/OPENAPI_COVERAGE.md`
- Logging standards source of truth: `.agents-config/docs/LOGGING_STANDARDS.md`
- Runtime logging rule: everything in project runtime code should be logged appropriately through shared logging helpers.
- Domain start-here readmes: `backend/src/routes/README.md`, `backend/src/services/README.md`, `frontend/features/*/README.md`
- Human-readable rules contract: `.agents-config/docs/AGENT_RULES.md`
- Human-readable project context: `.agents-config/docs/AGENT_CONTEXT.md`
- Context map index: `.agents-config/docs/CONTEXT_INDEX.json`

Conflict resolution order:

1. Latest explicit user instruction.
2. `AGENTS.override.md` (when present).
3. `AGENTS.append.md` (when present and `AGENTS.override.md` is absent).
4. Machine-readable policy contracts/checks.
5. Human-readable rules contract.
6. Human-readable context contract.

## Session Context Artifacts

Canonical local artifact roots are under `.agents/`:

- Canonical execution queue: `.agents/EXECUTION_QUEUE.json`
- Feature-sharded cold archive: `.agents/archives/<feature_id>.jsonl`
- Archive index for historical lookup: `.agents/EXECUTION_ARCHIVE_INDEX.json`
- Generated startup brief: `.agents/SESSION_BRIEF.json`
- Memory ledger: `.agents/MEMORY.md` (canonical reference point for persistent memories and the submemory index; must be re-read after every context compaction before resuming work)
- Topic memory root: `.agents/memory/` (indexed submemory directories; re-read task-relevant submemories after compaction)
- Session implementation log: `.agents/SESSION_LOG.md`
- Submemory convention: each memory directory uses a short ID (`mNNN`) and stores freeform content in `_submemory.md`.
- Plan roots: `.agents/plans/current/`, `.agents/plans/deferred/`, `.agents/plans/archived/`
- Shared queue authority for orchestrator and subagents: `.agents/EXECUTION_QUEUE.json` (single source of truth)
- Bootstrap defaults to external workfiles mode: `.agents` is a symlink to `<agents-workfiles-path>/<project-id>` (default path `../agents-workfiles`).
- Local `.agents` directory mode is available only when bootstrap is explicitly set to `--agents-mode local`.
- Treat `.agents/**` as shared multi-writer state and apply semantic merges (preserve concurrent entries; never clobber with blind overwrite).
- `.agents/**` may be concurrently modified by other agent sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- All additional Git worktrees must be created under `../<repo-name>.worktrees`.
- In non-primary worktrees, `.agents` must be a symlink to the canonical shared root.

Queue-first execution rule:

- Before implementation/investigation execution starts, all planned work must exist as atomic entries in `.agents/EXECUTION_QUEUE.json`.
- `.agents/EXECUTION_QUEUE.json` is authoritative for task state/order; `PLAN.json` is the machine-authoritative lifecycle companion for each plan, and `PLAN.md` is legacy historical context only.
- `npm run agent:preflight` auto-syncs `.agents/plans/current/*/PLAN.json` and `.agents/plans/deferred/*/PLAN.json` into queue items, and normalizes legacy plan artifacts into canonical `PLAN.json` state.
- Detailed PLAN machine-contract fields and status-gate rules are canonical in `.agents-config/policies/agent-governance.json` at `contracts.sessionArtifacts.planMachineContract`; use that contract as source of truth instead of restating field-by-field schema here.
- Policy enforcement requires each current/deferred plan directory to have a corresponding queue item via `plan_ref`.
- `npm run agent:preflight` also maintains `.agents/EXECUTION_ARCHIVE_INDEX.json` and feature shard archives from `.agents/plans/archived/*/PLAN.json`.
- Queue state model is explicit and idempotent: top-level and per-item `state` use `active`/`deferred`/`pending`/`complete`, and items keep stable `id` + `idempotency_key`.
- When a task or feature becomes `complete`, move it from hot queue into feature shard archive.
- Do not read archive shards during normal startup; read archive on-demand for historical lookup only.
- In multi-agent sessions, read only queue fields/items relevant to the current feature/item scope (selector examples: `id`, `plan_ref`, `owner`, `depends_on`) instead of loading the entire queue.
- Preflight performs a stale `.agents/plans/**` reference scan and fails when unresolved links are detected.
- Session brief contract is machine-validated and required via `.agents/SESSION_BRIEF.json`; missing/stale freshness beyond policy threshold fails policy checks until refreshed.
- Preflight queue-quality gate blocks archival/closeout when required queue metadata is missing (`deferred_reason`, execution/completion timestamps, outputs/evidence/resolution summary).
- Completion evidence for `complete` items must include explicit verification trace entries prefixed `verify:`.

Simplified plan architecture:

- required per active feature: `PLAN.json`
- optional legacy historical artifact: `PLAN.md` (non-authoritative)
- Optional when needed: `HANDOFF.md`, `PROMPT_HISTORY.md`, `EVIDENCE.md`
- Legacy `*_PLAN.md` and `LLM_SESSION_HANDOFF.md` files are valid historical formats.
- Treat `.agents-config/policies/agent-governance.json` `contracts.sessionArtifacts` as the authoritative machine schema + status-gate contract.
- Treat `.agents-config/docs/AGENT_RULES.md` `### Planning and Small-Batch Execution` as the authoritative human-readable planning contract.
- `npm run agent:preflight` remains the canonical command that normalizes and enforces plan-machine contract shape before execution.

## Orchestrator/Subagent Contract Pointer

Canonical enforceable source for orchestrator/subagent behavior:
`contracts.orchestratorSubagent` in `.agents-config/policies/agent-governance.json`

For the full orchestrator rule-ID catalog and behavioral contract details, see `.agents-config/docs/AGENT_RULES.md` `### Orchestrator/Subagent Instruction Contract (Required)`.

Single-orchestrator topology is required: one orchestrator agent owns cross-task coordination/context and subagents execute delegated atomic tasks only.
Orchestrators should make complex decisions, but must delegate discovery and implementation work to subagents whenever possible.
Operator/subagent execution is mandatory whenever delegation is feasible; direct single-agent execution is allowed only for trivial coordination/meta tasks or explicit infeasibility cases.
Subagent assignments must be strict and atomic with clear objective, context, acceptance criteria, and verification expectations.
Release/close subagents immediately once they are complete or no longer actively executing delegated work.
Subagent handoff brevity and spec/refined-spec/plan verbosity budgets are defined in `contracts.orchestratorSubagent.verbosityBudgets`.
Default model routing is policy-defined by role/risk:
- orchestrator: `gpt-5.3-codex` with `xhigh` reasoning effort
- subagents: `gpt-5.3-codex` with `high` reasoning effort
- low-risk fast loops only: `gpt-5.3-codex-spark` with explicit verification commands
Claude model routing is policy-defined by role/risk:
- orchestrator: `claude-opus-4-6`
- subagents: `claude-opus-4-6` (or `claude-sonnet-4-6` for lighter tasks)
- low-risk fast loops only: `claude-haiku-4-5`
Claude-to-Codex delegation: prefer `codex exec` for atomic tasks; use interactive `codex` for iterative work.
Default CLI routing is policy-defined in `contracts.orchestratorSubagent.defaultCliRouting`:
- Codex agents: `codex`
- Claude agents: `claude`

## Policy-as-Code Enforcement

- Local: `node .agents-config/scripts/enforce-agent-policies.mjs`
- CI-safe local command: `npm run policy:check:ci`
- Session preflight: `npm run agent:preflight`
- Canonical rules verify: `npm run rules:canonical:verify`
- Canonical rules sync: `npm run rules:canonical:sync`
- Canonical ruleset artifact (`.agents-config/contracts/rules/canonical-ruleset.json`) is template-managed with optional adjacent override payload (`.agents-config/contracts/rules/canonical-ruleset.override.json`) when local profile/policy derivation diverges.
- Full downstream sync/fix/verify: `npm run agent:sync`
- Managed workflow check: `npm run agent:managed -- --mode check`
- Managed workflow fix/recheck: `npm run agent:managed -- --fix --recheck`
- Managed workflow canonical contract source: `.agents-config/agent-managed.json` + `.agents-config/tools/bootstrap/managed-files.template.json` (`canonical_contract`, per-entry `authority`, `allow_override`, and `structure_contract` fields).
- Structured markdown contracts may include `placeholder_patterns` and `placeholder_failure_mode` to surface unfilled template placeholders by required section.
- Structured JSON contracts may include `forbidden_paths` to prune deprecated machine-only keys during managed sync while preserving project-owned content.
- Use `agent:sync` when pulling template updates, refreshing profiles/scripts, or switching template refs.
- Use `agent:managed -- --fix --recheck` when manifest/template source settings are already correct and only managed-file drift needs repair.
- `AGENTS.md` is template-managed. Do not hand-edit canonical `AGENTS.md`.
- Use `AGENTS.override.md` for full replacement mode, or `AGENTS.append.md` for additive mode.
- Bootstrap does not auto-seed managed override payloads; overrides are opt-in local artifacts (`.override`/`.append`) when a project intentionally diverges.
- Managed override eligibility: `allow_override=true` is valid only for template-authority entries.
- Managed override exclusivity: do not keep both `<managed-file>.override.*` and `<managed-file>.append.*` for the same managed path.
- Managed override gate: unknown/non-allowlisted managed override payload files (adjacent `.override`/`.append`) fail managed checks, and deprecated `.replace` payload names are rejected.
- Template-impact declaration gate (PR metadata): `npm run agent:template-impact:check -- --base-ref origin/<base-branch>`
- Release prep (changelog rotation): `npm run release:prepare -- --version <X.Y.Z>`
- Release notes generator: `npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>] [--summary <text>] [--known-issue <text>] [--compat-note <text>]`
- Release runtime contract check: `npm run release:contract:check`
- Release workflow rule: `release:prepare` must promote `## [Unreleased]` into `## [<version>] - <date>` and recreate a fresh empty `## [Unreleased]` scaffold (`Added`, `Changed`, `Fixed`).
- Release notes input validation: `--version` must be semver without a `v` prefix, and `--from`/`--to` refs must resolve to commits.
- Release notes URL resolution: prefer `git remote.origin.url`, then fallback to `.agents-config/config/project-tooling.json.releaseNotes.defaultRepoWebUrl`.
- Release notes source rule: `release:notes` must read items from the corresponding `CHANGELOG.md` version section (plain-English changelog bullets are canonical).
- Release notes content rule: summarize changes in plain English and avoid raw commit-jargon wording.
- Profile-scoped governance artifacts and command requirements are enforced from active policy profiles.
- Profile-scoped for `typescript` and `javascript`: `npm run feature-index:verify`, `npm run route-map:verify`, `npm run domain-readmes:verify`, `npm run jsdoc-coverage:verify`, and `npm run logging:compliance:verify`.
- Profile-scoped for `typescript-openapi`: `npm run openapi-coverage:verify`.
- Logging policy requirement: runtime code paths should not ship without appropriate scoped logging coverage.
- Logging baseline metadata identity is project-owned at `.agents-config/config/project-tooling.json.loggingCompliance.baselineMetadataId`.
- CI gate: `.github/workflows/pr-checks.yml` job `policy-as-code` (policy + managed drift + template-impact + release-runtime checks)
- CI template gate: meaningful workflow-path changes must carry `Template-Impact` declaration (`yes` with `Template-Ref`, or `none` with `Template-Impact-Reason`).

# AGENTS.append.md - soundspan Local Addendum

This file is additive to `AGENTS.md` and should contain soundspan-specific deltas only.

## Soundspan Deltas

- Canonical shared `.agents` root for this repo is `../agents-workfiles/soundspan` (resolved on this machine to `/home/joshd/git/agents-workfiles/soundspan`).
- `.agents/**` may be concurrently modified by other Codex sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- Prefer full template sync/fix/verify with:
  - `npm run agent:sync`
- Optional remote-template mode (only when the selected template ref is published remotely):
  - `npm run agent:sync -- --prefer-remote`
- Use managed-only repair when template source/ref and profiles are already correct:
  - `npm run agent:managed -- --fix --recheck`
- Use bootstrap directly only for explicit profile/template-source reconfiguration that is not yet represented in `.agents-config/agent-managed.json`.
