# AGENTS.md — soundspan Agent Bootstrap

Bootstrap contract for AI coding agents in this repository.

## Required Startup Order

Read these in order before non-trivial work:

1. `AGENTS.md`
2. `docs/AGENT_RULES.md`
3. `docs/CONTEXT_INDEX.json`
4. `docs/AGENT_CONTEXT.md`
5. `.agents/EXECUTION_QUEUE.json` (when present)
6. `.agents/CONTINUITY.md`
7. Run `npm run agent:preflight` to refresh `.agents/SESSION_BRIEF.json` and enforce repository-index readiness

## Canonical Sources and Precedence

- Machine-readable canonical policy: `.github/policies/agent-governance.json`
- Enforcement runner: `.github/scripts/enforce-agent-policies.mjs`
- Session preflight generator: `.github/scripts/agent-session-preflight.mjs`
- Release notes source of truth: `CHANGELOG.md`
- Release notes template artifact: `docs/RELEASE_NOTES_TEMPLATE.md`
- Release notes generator: `.github/scripts/generate-release-notes.mjs`
- Feature index artifact: `docs/FEATURE_INDEX.json`
- Test matrix artifact: `docs/TEST_MATRIX.md`
- Route map artifact: `docs/ROUTE_MAP.md`
- JSDoc coverage artifact: `docs/JSDOC_COVERAGE.md`
- Domain start-here readmes: `backend/src/routes/README.md`, `backend/src/services/README.md`, `frontend/features/*/README.md`
- Human-readable rules contract: `docs/AGENT_RULES.md`
- Human-readable project context: `docs/AGENT_CONTEXT.md`
- Context map index: `docs/CONTEXT_INDEX.json`

Conflict resolution order:

1. Latest explicit user instruction.
2. Machine-readable policy contracts/checks.
3. Human-readable rules contract.
4. Human-readable context contract.

## Session Context Artifacts

Canonical local artifact roots are under `.agents/`:

- Canonical execution queue: `.agents/EXECUTION_QUEUE.json`
- Feature-sharded cold archive: `.agents/archives/<feature_id>.jsonl`
- Archive index for historical lookup: `.agents/EXECUTION_ARCHIVE_INDEX.json`
- Generated startup brief: `.agents/SESSION_BRIEF.json`
- Continuity ledger: `.agents/CONTINUITY.md`
- Plan roots: `.agents/plans/current/`, `.agents/plans/deferred/`, `.agents/plans/archived/`
- Shared queue authority for orchestrator and subagents: `.agents/EXECUTION_QUEUE.json` (single source of truth)
- Canonical shared `.agents` root is `/home/joshd/git/soundspan/.agents` (git-ignored local context).
- Treat `.agents/**` as shared multi-writer state and apply semantic merges (preserve concurrent entries; never clobber with blind overwrite).
- `.agents/**` may be concurrently modified by other Codex sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- All additional Git worktrees must be created under `/home/joshd/git/soundspan/.worktrees`.
- In non-primary worktrees, `.agents` must be a symlink to the canonical shared root.

Queue-first execution rule:

- Before implementation/investigation execution starts, all planned work must exist as atomic entries in `.agents/EXECUTION_QUEUE.json`.
- `.agents/EXECUTION_QUEUE.json` is authoritative for task state/order; `PLAN.md` provides human detail and references queue item IDs.
- `npm run agent:preflight` auto-syncs `.agents/plans/current/*/PLAN.md` and `.agents/plans/deferred/*/PLAN.md` into queue items.
- Policy enforcement requires each current/deferred plan directory to have a corresponding queue item via `plan_ref`.
- `npm run agent:preflight` also backfills `.agents/plans/archived/*/PLAN.md` into `.agents/EXECUTION_ARCHIVE_INDEX.json` + feature shard archives idempotently.
- Queue state model is explicit and idempotent: top-level and per-item `state` use `active`/`deferred`/`pending`/`complete`, and items keep stable `id` + `idempotency_key`.
- When a task or feature becomes `complete`, move it from hot queue into feature shard archive.
- Do not read archive shards during normal startup; read archive on-demand for historical lookup only.
- In multi-agent sessions, read only queue fields/items relevant to the current feature/item scope (selector examples: `id`, `plan_ref`, `owner`, `depends_on`) instead of loading the entire queue.
- Preflight performs a stale `.agents/plans/**` reference scan and fails when unresolved links are detected.
- Session brief contract is machine-validated when `.agents/SESSION_BRIEF.json` is present; stale freshness beyond policy threshold fails policy checks until refreshed.
- Preflight includes repository index readiness gating: always re-index namespaced index and strict-verify before implementation work starts.

Simplified plan architecture:

- required per active feature: `PLAN.md`
- Optional when needed: `HANDOFF.md`, `PROMPT_HISTORY.md`, `EVIDENCE.md`
- Legacy `*_PLAN.md` and `LLM_SESSION_HANDOFF.md` files are valid historical formats.

## Orchestrator/Subagent Contract Pointer

Canonical enforceable source for orchestrator/subagent behavior:
`contracts.orchestratorSubagent` in `.github/policies/agent-governance.json`

Policy-canonical rule IDs:

- `orch_hybrid_instruction_contract`
- `orch_scope_tightness`
- `orch_machine_payload_authoritative`
- `orch_delegate_substantive_work`
- `orch_human_nuance_addendum`
- `orch_atomic_task_delegation`
- `orch_dual_channel_result_envelope`
- `orch_orchestrator_coordination_only`
- `orch_default_cli_routing`
- `orch_unconfirmed_unknowns`
- `orch_atomic_single_objective_scope`
- `orch_codex_model_default`

Default Codex subagent model: `gpt-5.3-codex-spark` unless user-overridden.

## Policy-as-Code Enforcement

- Local: `node .github/scripts/enforce-agent-policies.mjs`
- Session preflight: `npm run agent:preflight`
- Release prep (changelog rotation): `npm run release:prepare -- --version <X.Y.Z>`
- Release notes generator: `npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>]`
- Release workflow rule: `release:prepare` must promote `## [Unreleased]` into `## [<version>] - <date>` and recreate a fresh empty `## [Unreleased]` scaffold (`Added`, `Changed`, `Fixed`).
- Release notes source rule: `release:notes` must read items from the corresponding `CHANGELOG.md` version section (plain-English changelog bullets are canonical).
- Release notes content rule: summarize changes in plain English and avoid raw commit-jargon wording.
- Route map generator: `npm run route-map:generate`
- Domain readmes generator: `npm run domain-readmes:generate`
- JSDoc coverage verify: `npm run jsdoc-coverage:verify`
- CI gate: `.github/workflows/pr-checks.yml` job `policy-as-code`
- If process expectations change, update all of:
  - `AGENTS.md`
  - `docs/AGENT_RULES.md`
  - `docs/AGENT_CONTEXT.md`
  - `docs/CONTEXT_INDEX.json`
  - `docs/FEATURE_INDEX.json`
  - `docs/TEST_MATRIX.md`
  - `docs/ROUTE_MAP.md`
  - `docs/JSDOC_COVERAGE.md`
  - `backend/src/routes/README.md`
  - `backend/src/services/README.md`
  - `frontend/features/README.md`
  - `.github/policies/agent-governance.json`
  - `.github/scripts/enforce-agent-policies.mjs`
