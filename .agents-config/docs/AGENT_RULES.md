# AGENT_RULES.md

Human-readable behavioral contract for LLM agents in this repository.

Machine-readable canonical policy remains `.agents-config/policies/agent-governance.json`.

## Rule ID Catalog (Machine Cross-Reference)

These IDs are stable cross-references for enforceable behavior and map to policy contracts/checks.

- `rule_startup_read_order`: Follow startup read order and run session preflight before non-trivial implementation.
- `rule_context_index_usage`: Use `.agents-config/docs/CONTEXT_INDEX.json` as the machine-readable map for context lookup.
- `rule_execution_queue_required`: Maintain canonical machine-readable execution queue in `.agents/EXECUTION_QUEUE.json`.
- `rule_queue_plan_before_execution`: Plan all execution work into queue entries before changing any entry to active execution state.
- `rule_queue_single_source_of_truth`: Use `.agents/EXECUTION_QUEUE.json` as the only queue/scope authority across orchestrator and subagents.
- `rule_queue_scoped_context_read`: Read only queue fields/items relevant to the active feature/item scope to preserve context efficiency.
- `rule_queue_archive_on_complete`: Move completed task/feature work from hot queue into feature-sharded archive artifacts.
- `rule_plan_machine_contract_required`: Maintain machine-readable plan lifecycle + authoritative narrative context (including enforced pre-spec purpose/non-goals fields) in `PLAN.json` for each active/deferred/archived feature plan directory.
- `rule_plan_step_reference_required`: Require at least one concrete reference in every `PLAN.json` implementation step.
- `rule_plan_non_goals_status_gate`: Require non-empty `narrative.pre_spec_outline.non_goals` for policy-configured plan statuses (default: `ready`, `deferred`).
- `rule_plan_placeholder_deliverables_forbidden`: Forbid placeholder implementation-step deliverables using policy deny patterns.
- `rule_plan_complete_step_summary_required`: For complete implementation steps, require non-empty completion-summary arrays for delivered work, touched files/functions/hooks, and verification/testing.
- `rule_plan_status_coherence_required`: Enforce policy-driven coherence between top-level plan status and implementation-step statuses.
- `rule_scope_tight_no_overbroad_refactor`: Keep changes narrowly scoped unless the user explicitly requests broad refactors.
- `rule_hybrid_machine_human_contract`: Use machine-readable contracts as authority with concise human nuance addenda when needed.
- `rule_policy_sync_required`: When process expectations change, update policy + enforcement + human docs together.
- `rule_continuity_required`: Use `.agents/MEMORY.md` as the canonical memory reference point and submemory index, and route timestamped implementation traces to `.agents/SESSION_LOG.md`.
- `rule_post_compaction_rebootstrap`: Treat compaction recovery as full startup and run preflight.
- `rule_context_index_drift_guard`: Keep `.agents-config/docs/CONTEXT_INDEX.json` synchronized with policy/documentation contracts and fail checks on drift.
- `rule_canonical_ruleset_contract_required`: Maintain canonical rule IDs/statements in `.agents-config/contracts/rules/canonical-ruleset.json` with hash lineage tied to policy and rules docs.
- `rule_local_rule_overrides_contract_required`: Allow local-only override IDs only through `.agents-config/rule-overrides.json`, validated against `.agents-config/rule-overrides.schema.json`.
- `rule_managed_files_canonical_contract_required`: Keep managed workflow manifests (`.agents-config/agent-managed.json` and `.agents-config/tools/bootstrap/managed-files.template.json`) canonical with explicit `canonical_contract` defaults and authority modes.
- `rule_managed_files_known_overrides_only`: Permit managed-file override payloads only for explicitly allowlisted template-authority entries (`allow_override=true`), enforce one override mode per managed path, and fail unknown/non-allowlisted payload files (adjacent `.override`/`.append`) including deprecated `.replace` naming.
- `rule_canonical_agents_root`: Treat `.agents` as the canonical project-local agent-context path; bootstrap defaults to external workfiles mode where `.agents` symlinks to `<agents-workfiles-path>/<project-id>` (default path `../agents-workfiles`), and local `.agents` mode is explicit via `--agents-mode local`.
- `rule_worktree_root_required`: Keep all non-primary Git worktrees under `../<repo-name>.worktrees`.
- `rule_agents_semantic_merge_required`: `.agents/**` is shared multi-session state; every `.agents/**` edit must be semantically merged against latest on-disk state.
- `rule_tdd_default`: Prefer true TDD and document deviations when strict TDD is impractical.
- `rule_coverage_default_100`: Treat 100% coverage as default bar unless user-approved exception exists.
- `rule_scope_completeness_gate`: Explicitly map outcomes to all in-scope user requests before closeout.

Profile-scoped rule IDs (enforced only when the profile is active):

`typescript`/`javascript`:
- `rule_feature_index_required`: Maintain `.agents-config/docs/FEATURE_INDEX.json` as the canonical machine-readable feature map.
- `rule_test_matrix_required`: Maintain `.agents-config/docs/TEST_MATRIX.md` as the canonical targeted test-command matrix.
- `rule_route_map_required`: Maintain `.agents-config/docs/ROUTE_MAP.md` as the canonical generated backend/frontend route map.
- `rule_domain_readmes_required`: Maintain per-domain start-here READMEs in `backend/src/routes`, `backend/src/services`, and `frontend/features/*`.
- `rule_jsdoc_coverage_required`: Maintain `.agents-config/docs/JSDOC_COVERAGE.md` as the generated exported-symbol documentation drift tracker.
- `rule_logging_contract_required`: Maintain `.agents-config/docs/LOGGING_STANDARDS.md` and enforce logging compliance checks across frontend/backend/python runtime code.

`typescript-openapi`:
- `rule_openapi_endpoint_docs_required`: Maintain `.agents-config/docs/OPENAPI_COVERAGE.md` as the generated OpenAPI endpoint/spec coverage drift tracker.

`python`:
- No additional profile-specific rule IDs are currently required beyond base contracts.

Global rule IDs (all profiles):

- `rule_release_notes_template_required`: Enforce canonical release-notes template + generator workflow, section order, and plain-English non-jargon summaries through policy checks.
- `rule_release_notes_changelog_source_required`: Treat `CHANGELOG.md` as release-notes source of truth and rotate `Unreleased` during `release:prepare`.
- `orch_single_orchestrator_authority`: Enforce exactly one orchestrator context owner per session; subagents do not orchestrate.
- `orch_operator_subagent_default`: Delegate discovery and implementation work to subagents whenever possible; orchestrators retain decision authority and coordination only.
- `orch_subagent_delegation_required_when_possible`: Subagent delegation is mandatory whenever delegation is feasible, including both investigation/discovery and implementation execution.
- `orch_release_idle_subagents_required`: Idle subagents must be released once they are no longer actively executing work.
- `orch_concise_subagent_briefs`: Enforce concise subagent payload/addendum shape with explicit verbosity budgets.
- `orch_spec_refined_plan_verbosity`: Enforce concise spec outline/refined spec/implementation-plan verbosity ladder.
- `orch_claude_model_default`: Claude model routing is role/risk-based: orchestrator uses `claude-opus-4-6`, subagents use `claude-opus-4-6` (or `claude-sonnet-4-6` for lighter tasks), and `claude-haiku-4-5` is reserved for low-risk loops. Claude orchestrators may delegate to Codex subagents via `codex exec`.

Framework-specific rule IDs are profile-scoped in policy contracts.

## Global Operating Agreements (All LLMs)

These rules are cross-agent defaults for this workspace and apply unless the user explicitly overrides them.

### Accuracy, Recency, and Sourcing (Required)

- If a request depends on recency (`latest`, `current`, `today`, `as of now`), establish and state current time in ISO format first (preferred: `date -Is`).
- For dependency/framework/runtime behavior, prefer upstream vendor documentation and primary sources.
- For compatibility or safety-sensitive details, cross-check at least two reputable sources and capture source/release dates.
- Prefer newest stable/versioned docs, release notes, and changelogs over tertiary summaries.

### Context7 MCP and Web Search Policy

- Use Context7 for targeted library/API docs when possible.
- If known, pin the library using slash syntax (example: `/supabase/supabase`) and mention the target version.
- Fetch only minimal sections needed for correctness; summarize findings rather than dumping large raw excerpts.
- Use web search only when it materially improves correctness (for example: recent API changes, advisories, release notes).
- Prefer official docs first; otherwise use reputable widely cited references.

### Default Autonomy and Safety

- Default to read-only exploration first; edit only when required by the task.
- Keep edits workspace-scoped and inside this repository unless explicitly instructed otherwise.
- Remote API interactions must be read-only by default. If the user requests write operations, perform a dry-run first and require explicit confirmation before non-read calls.
- Never run destructive operations against remote APIs or production data sources unless the user explicitly requests and confirms them.

### Editing Files

- Make the smallest safe change that solves the issue.
- Preserve existing style and conventions.
- Prefer patch-style, reviewable diffs over broad full-file rewrites.
- After code changes, run standard project checks when feasible (format/lint, unit tests, build/typecheck).

### Reading Project Documents

- Read the full source document before drafting output.
- Draft the output.
- Before finalizing, re-read the original source and verify:
  - factual accuracy,
  - no invented details,
  - wording/style preservation unless rewrite was explicitly requested.
- If paraphrasing is required, label it explicitly as a paraphrase.

### Release Notes Format (Required)

- Treat `CHANGELOG.md` as the source of truth for release-note content (not commit subjects).
- Prepare releases with `npm run release:prepare -- --version <X.Y.Z>` before generating release notes.
- `release:prepare` must promote `## [Unreleased]` into `## [<version>] - <date>` and recreate a fresh empty `## [Unreleased]` scaffold with `### Added`, `### Changed`, and `### Fixed`.
- Treat `.agents-config/docs/RELEASE_NOTES_TEMPLATE.md` as the canonical release-notes structure.
- Generate release notes with `npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>] [--summary <text>] [--known-issue <text>] [--compat-note <text>]`.
- `release:notes` validates `--version` as semver without a `v` prefix and requires `--from`/`--to` to resolve as commit refs.
- `release:notes` resolves repo web URL from `git remote.origin.url`, then falls back to `.agents-config/config/project-tooling.json.releaseNotes.defaultRepoWebUrl` when needed.
- `release:notes` must read Fixed/Added/Changed/Admin/Breaking bullets from the matching `CHANGELOG.md` version section.
- Keep section order fixed: `Release Summary`, `Fixed`, `Added`, `Changed`, `Admin/Operations`, `Deployment and Distribution`, `Breaking Changes`, `Known Issues`, `Compatibility and Migration`, `Full Changelog`.
- Summarize release-note items in plain English for operators/users; do not copy raw commit-jargon wording as release-note bullets.
- Use exact Helm release references in release notes:
  - repository URL: `https://example.github.io/project`
  - chart name: `project`
  - chart reference: `project/project`

### Feature and Test Discoverability (Required)

- For `typescript` and `javascript` profiles, treat `.agents-config/docs/FEATURE_INDEX.json` as the canonical machine-readable feature map and ownership/findability index.
- For `typescript` and `javascript` profiles, treat `.agents-config/docs/TEST_MATRIX.md` as the canonical map from feature domains to targeted test commands.
- For `typescript` and `javascript` profiles, treat `.agents-config/docs/ROUTE_MAP.md` as the canonical generated map for backend endpoints and frontend routes.
- For `typescript` and `javascript` profiles, keep `.agents-config/docs/JSDOC_COVERAGE.md` current via `npm run jsdoc-coverage:verify` whenever exported-symbol surface changes.
- For `typescript-openapi` profile, keep `.agents-config/docs/OPENAPI_COVERAGE.md` current via `npm run openapi-coverage:verify` whenever OpenAPI spec or route surface changes.
- For `typescript` and `javascript` profiles, regenerate route map artifacts with `npm run route-map:generate` whenever backend route handlers, route mounts, or frontend app routes change.
- For `typescript` and `javascript` profiles, maintain per-domain start-here READMEs in `backend/src/routes/README.md`, `backend/src/services/README.md`, and `frontend/features/*/README.md`.
- For `typescript` and `javascript` profiles, whenever a feature is introduced, changed significantly, or removed, update or explicitly verify the impacted entry in `.agents-config/docs/FEATURE_INDEX.json`.
- For `typescript` and `javascript` profiles, whenever test entrypoints or reliable targeted commands change, update `.agents-config/docs/TEST_MATRIX.md` in the same change set.

### Logging Standards Contract (Required)

- For `typescript` and `javascript` profiles, treat `.agents-config/docs/LOGGING_STANDARDS.md` as the canonical logging policy for frontend, backend, and Python sidecars.
- Everything in project runtime code should be logged appropriately with shared logging helpers; do not leave silent failure paths or raw logging drift.
- Use shared logging helpers by default:
  - frontend: `frontend/lib/logger.ts`
  - backend: `backend/src/utils/logger.ts`
  - python sidecars: `services/common/logging_utils.py`
- Prefer reusable wrappers/decorators (`with*Timing`, `log_exceptions`, `log_timing`) over repeated inline timing and try/catch logging blocks.
- Enforce raw logging drift checks with:
  - `npm run logging:compliance:verify` (strict)
  - `npm run logging:compliance:generate` (baseline refresh after intentional migrations)
- Logging compliance verification scans tracked files from `git ls-files`, excludes test/script/helper logger paths, and supports inline allow markers (`logging-allow: raw`) on the same or previous line for intentional exceptions.
- Logging baseline metadata identity is project-owned via `.agents-config/config/project-tooling.json.loggingCompliance.baselineMetadataId`.

### Container-First Policy (Required)

- Never install system packages on the host unless explicitly instructed by the user.
- Use containers by default for project tooling and dependency workflows.
- Prefer existing project container workflows (`Dockerfile`, compose files, Make targets) for tool/runtime dependencies.
- If a needed workflow has no containerized path, create a minimal containerized path and document it here.
- Keep repo-specific container details in `.agents-config/docs/AGENT_CONTEXT.md`.

### Secrets and Sensitive Data

- Never print secrets/tokens/credentials/private keys in terminal output.
- Never ask users to paste secrets when existing local auth/context can be used.
- Avoid broad secret-revealing commands (for example bulk env dumps or key directory dumps).
- Prefer existing authenticated CLIs/workflows over ad hoc secret handling.
- Redact sensitive strings in any displayed output.

### Baseline Workflow (Required)

At task start, explicitly determine:

1. Goal and acceptance criteria.
2. Constraints (scope, safety, timeline).
3. Required inspection set (files, commands, docs, tests).
4. Whether the task is recency-sensitive (if yes, apply recency rules above).
5. Ambiguities needing clarification before irreversible changes.

### CLI Worktree Parallelism (Required)

- When operating in an agent CLI (for example Codex CLI or Claude Code CLI), prefer Git worktrees for non-trivial parallelizable tasks instead of stacking unrelated edits in one working tree.
- Whenever delegation is feasible, prefer operator/subagent execution and parallel agents/subagents for independent task slices when available.
- Bootstrap defaults to external workfiles mode: `.agents` is a symlink to `<agents-workfiles-path>/<project-id>` (default path `../agents-workfiles`).
- Local `.agents` directory mode is allowed only when bootstrap is explicitly set to `--agents-mode local`.
- Treat `.agents/**` as shared multi-writer state; reconcile concurrent edits using semantic merges instead of blind overwrite.
- `.agents/**` may be concurrently modified by other agent sessions; every `.agents/**` edit must be semantically merged against latest on-disk state before write.
- All non-primary Git worktrees must live under `../<repo-name>.worktrees`.
- For worktree execution, copy required local `.gitignore`d context files into the worktree (for example `.agents/**`, `.agents/plans/**`, and other local context files needed for correctness), keep them untracked, and never commit/push them.

### Managed Files Canonical Contract (Required)

- Treat `.agents-config/agent-managed.json` and `.agents-config/tools/bootstrap/managed-files.template.json` as canonical machine-readable workflow surface declarations.
- Keep `canonical_contract.default_authority` as `template` and explicitly declare any non-template behavior using the per-entry `authority` field.
- Override payload files are adjacent to managed files by default (`<managed-file>.override.<ext>` for full replacement, `<managed-file>.append.<ext>` for additive merge) and are valid only when the managed entry sets `allow_override=true` on a template-authority entry.
- Bootstrap must not auto-seed managed override payloads; overrides are opt-in local artifacts (`.override`/`.append`) when local divergence is intentional.
- Do not keep both override modes for one managed path (`.override` and `.append` simultaneously).
- Unknown or non-allowlisted override payload files (adjacent `.override`/`.append`) must fail `npm run agent:managed -- --mode check`; deprecated `.replace` naming is rejected.
- Structured markdown contracts can declare `placeholder_patterns` with `placeholder_failure_mode` (`warn` or `fail`) to detect unfilled template placeholders in required sections.
- Structured JSON contracts can declare `forbidden_paths` so managed sync removes deprecated machine-only keys while keeping required project-local structure intact.

### Orchestrator/Subagent Instruction Contract (Required)

- Canonical enforceable source for orchestrator/subagent behavior: `.agents-config/policies/agent-governance.json` at `contracts.orchestratorSubagent`.
- Keep this section concise for humans; machine-enforceable rule text, required payload fields, and default CLI routing live in policy.
- Contract IDs (policy-canonical):
  - `orch_hybrid_instruction_contract`
  - `orch_scope_tightness`
  - `orch_machine_payload_authoritative`
  - `orch_delegate_substantive_work`
  - `orch_operator_subagent_default`
  - `orch_subagent_delegation_required_when_possible`
  - `orch_human_nuance_addendum`
  - `orch_atomic_task_delegation`
  - `orch_dual_channel_result_envelope`
  - `orch_orchestrator_coordination_only`
  - `orch_release_idle_subagents_required`
  - `orch_default_cli_routing`
  - `orch_unconfirmed_unknowns`
  - `orch_atomic_single_objective_scope`
  - `orch_single_orchestrator_authority`
  - `orch_concise_subagent_briefs`
  - `orch_spec_refined_plan_verbosity`
  - `orch_codex_model_default`
  - `orch_claude_model_default`

Machine vs human guidance split for orchestration:

- Machine-readable payload/config drives execution and validation.
- Human-readable addendum captures nuance, rationale, and caveats not encoded in schema fields.
- One orchestrator agent owns cross-task coordination/context in a session; subagents execute delegated atomic tasks and do not recursively orchestrate.
- Operator/subagent delegation is mandatory whenever possible for both discovery and implementation work; direct single-agent execution is only for trivial coordination/meta steps or explicit infeasibility cases.
- Orchestrators make complex decisions, then delegate investigation and implementation as strict atomic subagent tasks with explicit objective, inputs, acceptance criteria, and verification.
- Idle or completed subagents must be released/closed immediately once they are no longer actively executing delegated work.
- Subagent payload brevity is mandatory: one concrete objective, bounded context input, bounded completion summary.
- Spec outline, refined spec, and detailed implementation plan sections must follow policy-defined verbosity budgets.
- Model routing defaults are role/risk specific:
  - orchestrator: `gpt-5.3-codex` with `xhigh` reasoning effort,
  - subagents: `gpt-5.3-codex` with `high` reasoning effort,
  - low-risk loops only (`single-file edits`, `grep/triage`, `draft rewrites`): `gpt-5.3-codex-spark`.
- Claude model routing defaults are role/risk specific:
  - orchestrator: `claude-opus-4-6`,
  - subagents: `claude-opus-4-6` (or `claude-sonnet-4-6` for lighter tasks),
  - low-risk loops only: `claude-haiku-4-5`.
- Claude orchestrators may delegate to Codex subagents via `codex exec` (preferred) or interactive `codex` session.
- Default CLI routing is policy-defined: Codex agents via `codex` CLI and Claude agents via `claude` CLI unless user-overridden.
- Spark low-risk loops require explicit verification commands in the delegated payload/result workflow.

## Policy-as-Code Enforcement

Critical agent/process rules are enforced by executable checks instead of prose-only guidance.

- Policy manifest (canonical enforceable contracts + checks): `.agents-config/policies/agent-governance.json`
- Enforcement runner: `.agents-config/scripts/enforce-agent-policies.mjs`
- Local command: `node .agents-config/scripts/enforce-agent-policies.mjs`
- CI-safe policy command: `npm run policy:check:ci`
- Session preflight command: `npm run agent:preflight`
- Canonical ruleset verify command: `npm run rules:canonical:verify`
- Canonical ruleset sync command: `npm run rules:canonical:sync`
- `.agents-config/contracts/rules/canonical-ruleset.json` is template-managed; when local profile/policy derivation diverges, `rules:canonical:sync` refreshes adjacent override payload `.agents-config/contracts/rules/canonical-ruleset.override.json`.
- Full downstream sync/fix/verify command: `npm run agent:sync`
- Managed workflow command (check): `npm run agent:managed -- --mode check`
- Managed workflow command (fix + recheck): `npm run agent:managed -- --fix --recheck`
- Use `agent:sync` when pulling template updates, refreshing profiles/scripts, or changing template refs.
- Use `agent:managed -- --fix --recheck` only when manifest/template source settings are already correct and only managed drift needs repair.
- Managed workflow canonical contract source: `.agents-config/agent-managed.json` + `.agents-config/tools/bootstrap/managed-files.template.json` (`canonical_contract`, per-entry `authority`, `allow_override`, and `structure_contract`).
- Template-impact declaration gate: `npm run agent:template-impact:check -- --base-ref origin/<base-branch>`
- Logging compliance command: `npm run logging:compliance:verify`
- OpenAPI coverage command: `npm run openapi-coverage:verify`
- Release runtime contract command: `npm run release:contract:check`
- CI gate: `.github/workflows/pr-checks.yml` job `policy-as-code` (policy + managed drift + template-impact + release-runtime checks)
- CI template gate: meaningful workflow-path changes require `Template-Impact` PR metadata (`yes` + `Template-Ref`, or `none` + `Template-Impact-Reason`).

When policy expectations change, update all relevant governance artifacts in the same change set:

1. `.agents-config/templates/AGENTS.md` (bootstrap contract)
2. `.agents-config/docs/AGENT_RULES.md` (human-readable rules contract)
3. `.agents-config/docs/AGENT_CONTEXT.md` (human-readable context contract, when impacted)
4. `.agents-config/docs/CONTEXT_INDEX.json` (machine-readable context map)
5. `.agents-config/agent-managed.json` and `.agents-config/tools/bootstrap/managed-files.template.json` (managed workflow canonical contract + downstream seed)
6. `.agents-config/config/project-tooling.json` (project-owned tooling defaults consumed by template-managed scripts, when impacted)
7. `.agents-config/docs/FEATURE_INDEX.json` (machine-readable feature map, when impacted)
8. `.agents-config/docs/TEST_MATRIX.md` (targeted test command map, when impacted)
9. `.agents-config/docs/ROUTE_MAP.md` (generated backend/frontend route map, when impacted)
10. `.agents-config/docs/JSDOC_COVERAGE.md` (generated exported-symbol JSDoc coverage tracker, when impacted)
11. `.agents-config/docs/OPENAPI_COVERAGE.md` (generated OpenAPI endpoint/spec coverage tracker, when impacted)
12. `backend/src/routes/README.md`, `backend/src/services/README.md`, and `frontend/features/*/README.md` (domain start-here guides, when impacted)
13. `.agents-config/policies/agent-governance.json` (machine-readable source of truth)
14. `.agents-config/scripts/enforce-agent-policies.mjs` (enforcement logic)

## LLM Continuity and Execution Discipline

### Persistent Rules

- If the user adds or changes a process rule, update `.agents-config/templates/AGENTS.md` and `.agents-config/docs/AGENT_RULES.md` in the same change set and enforce it via policy-as-code (`.agents-config/policies/agent-governance.json` and `.agents-config/scripts/enforce-agent-policies.mjs`).
- Work exhaustively with zero guesswork: if a required fact is unknown, explicitly look it up/verify it before proceeding.
- Do not trim or skip relevant context; preserve complete context for correctness-critical work unless the user explicitly asks to narrow scope.
- Record material findings/decisions in persistent context artifacts (`.agents/MEMORY.md`, `.agents/SESSION_LOG.md`, `.agents/EXECUTION_QUEUE.json`, and plan files) to survive context compaction.
- Reuse shared abstractions by default; avoid duplicate logic when common helpers/hooks/services are available.
- Keep changes small, readable, and scoped; avoid large refactors unless explicitly requested.
- No fallback code and no dummy implementations; fail fast instead of masking broken paths.

### Required Reading and Verification

- Always read full files before editing them.
- For documents (PDFs/uploads/long text/CSV), read fully before drafting and re-read source before finalizing.
- For summaries/paraphrases, ensure factual fidelity and explicitly label paraphrases when the wording is not exact.

### Planning and Small-Batch Execution

- Mandatory planning sequence for non-trivial work:
  1. Spec outline.
  2. Refined spec.
  3. Detailed implementation plan.
- Planning/refinement may span sessions; continue increasing detail until execution is safe.
- Detailed plans must break work into atomic tasks with explicit status values from policy (default: `pending`, `in_progress`, `complete`, `blocked`).
- Apply concise verbosity targets from `contracts.orchestratorSubagent.verbosityBudgets`:
  - spec outline `<= 220` words,
  - refined spec `<= 420` words,
  - per-atomic-task implementation block `<= 160` words.
- If a task requires exceeding a verbosity target for correctness, record a short rationale in `PLAN.json` (and mirror it in `PLAN.md` only when preserving legacy historical context).
- Mark a task `In Progress` before implementation; when marked `Complete`, add a short completion summary (files changed + verification result).
- Work in small batches and checkpoint frequently; if you cannot commit directly, instruct the user to commit at logical milestones.
- Before moving to a new task/session/phase, update current task summaries to reflect actual work and verification status.
- For large/ambiguous initiatives, get explicit user approval before entering implementation.
- Do not execute non-trivial implementation work until planning detail is sufficient and user approval to proceed is explicit.
- For very large or vague requests, break work into smaller subtasks; if still unclear, ask the user to narrow scope.
- For non-trivial phase transitions, pause and confirm direction with the user before proceeding.
- Explicit queue gate: before execution starts, add/update atomic work items in `.agents/EXECUTION_QUEUE.json` with `planned_at` metadata and acceptance criteria.
- Plan architecture is intentionally simple:
  - required per active feature directory: `PLAN.json`
  - optional legacy historical artifact: `PLAN.md` (non-authoritative; do not use as active source of truth)
  - optional as needed: `HANDOFF.md`, `PROMPT_HISTORY.md`, `EVIDENCE.md`
  - legacy `*_PLAN.md` and `LLM_SESSION_HANDOFF.md` files remain valid historical formats.
- Legacy `PLAN.md` artifacts (when present) should preserve explicit `Spec outline`, `Refined spec`, and `Detailed implementation plan` sections for historical auditability.
- `PLAN.json` is the machine-authoritative lifecycle record and must include:
  - lifecycle/status metadata (`status`, `updated_at`, `planning_stages`)
  - authoritative narrative context fields (`narrative.spec_outline`, `narrative.refined_spec`, `narrative.implementation_plan`, `narrative.pre_spec_outline`)
  - the plan reference link (`plan_ref`)
  - subagent policy/ownership metadata (`subagent.requirement`, `subagent.primary_agent`, `subagent.execution_agents`, `subagent.last_executor`)
- `PLAN.json.narrative.spec_outline` must be an object: `{ "summary": string, "full_spec_outline": SpecOutlineEntry[] }`.
- `PLAN.json.narrative.refined_spec` must be an object: `{ "summary": string, "full_refined_spec": RefinedSpecEntry[] }`.
- `PLAN.json.narrative.implementation_plan` must be an object: `{ "summary": string, "steps": ImplementationStep[] }`.
- `PLAN.json.narrative.pre_spec_outline` must be an object with required string fields: `{ "purpose_goals": string, "non_goals": string }`.
- `SpecOutlineEntry` contract: required `id` (non-empty string), `objective` (non-empty string), `deliverable` (non-empty string), `acceptance_criteria` (array of non-empty strings; minimum one), and `references` (array of non-empty strings; minimum one).
- `RefinedSpecEntry` contract: required `id` (non-empty string), `decision` (non-empty string), `rationale` (non-empty string), `acceptance_criteria` (array of non-empty strings; minimum one), and `references` (array of non-empty strings; minimum one).
- `ImplementationStep` contract: required `status` (non-empty allowlisted string), `deliverable` (non-empty non-placeholder string), `acceptance_criteria` (array of non-empty strings), `references` (non-empty string array; minimum one concrete reference), and `completion_summary` object containing `delivered` (array), `files_functions_hooks_touched` (array), and `verification_testing` (array).
- Policy status gates:
  - For policy-configured plan statuses requiring structured spec entries (default: `in_progress`, `complete`), `narrative.spec_outline.full_spec_outline` and `narrative.refined_spec.full_refined_spec` must each contain at least the configured minimum entry count (default: `1`).
  - For policy-configured step statuses requiring acceptance criteria (default: `in_progress`, `complete`), `acceptance_criteria` must include at least the configured minimum count of non-empty entries (default: `1`).
  - `narrative.pre_spec_outline.non_goals` must be non-empty for policy-configured statuses (default: `ready`, `deferred`).
  - For complete implementation steps, `completion_summary.delivered`, `completion_summary.files_functions_hooks_touched`, and `completion_summary.verification_testing` must all be non-empty arrays.
  - Status coherence minimums: if any implementation step is `in_progress`, plan `status` must be `in_progress`; if plan `status` is `complete`, all implementation steps must be `complete`; if plan `status` is `deferred`, no implementation step may be `in_progress`.
- Treat `PLAN.json.narrative.*` as the authoritative active planning prose context (replacing active `PLAN.md` prose authority).
- For configured required statuses (default: `in_progress`, `complete`), each required narrative summary must satisfy the policy minimum length (default: `24` characters), meet the configured minimum step count (default: `1`), and `narrative.pre_spec_outline.purpose_goals`/`narrative.pre_spec_outline.non_goals` must satisfy the policy pre-spec minimum length (default: `24` characters each).

### Re-Context and Retrospective Checks

- Before each atomic task in long-running work (and after any context reset), run a re-context checkpoint:
  - current `git status` / recent commits,
  - active plan status,
  - handoff notes,
  - full files to be edited.
- Re-evaluate direction against security, compatibility, contract correctness, observability, performance, testability, and rollback safety.
- If direction needs to change, record recommendation + rationale in active plan/handoff docs before coding.
- After each atomic task, run a retrospective decision check:
  - confirm approach validity,
  - record better alternatives (if any),
  - decide keep/adjust/rollback,
  - request user confirmation before major course correction.
- At each atomic-task closeout, record both technical and plain-English outcome summaries.
- If uncertainty remains after retrospective checks, capture uncertainty explicitly and propose a safer alternative path.

### Post-Compaction Startup Checklist (Required)

- Treat every context-compaction recovery as a fresh startup sequence before doing new implementation work.
- Complete this checklist in order:
  1. Re-read `AGENTS.md`, `.agents-config/docs/AGENT_RULES.md`, `.agents-config/docs/CONTEXT_INDEX.json`, and `.agents-config/docs/AGENT_CONTEXT.md`.
  2. Confirm branch + workspace state (`git rev-parse --abbrev-ref HEAD`, `git status --short`).
  3. Load `.agents/EXECUTION_QUEUE.json` and `.agents/MEMORY.md`; both are required startup artifacts.
  4. Run `npm run agent:preflight` to regenerate `.agents/SESSION_BRIEF.json`.
  5. Re-confirm active user scope, exclusions, and acceptance criteria from the latest user instruction.
  6. Publish a short resume plan naming the exact next atomic task before editing code.
- Do not proceed with non-trivial edits until the checklist is complete.

### Testing and Quality Expectations

- Prefer true TDD by default: write failing tests first, then implement until tests pass.
- If strict TDD is impractical, document why and add focused regression-first coverage in the same change set.
- Legacy-test trust boundary: for code and tests authored before 2026-02-16 (inclusive), treat existing tests as potentially incomplete or incorrect until validated against current behavior/contracts; line-referential tests in that time range are advisory only until proven.
- Regression prevention tests and contract tests are mandatory for behavior-changing work unless the user explicitly bypasses this requirement.
- Treat 100% actual code coverage as the default bar (lines, branches, functions, statements); only deviate when the user explicitly approves an exception and capture it in the completion summary.
- Add opportunistic nearby coverage when touching thinly tested paths and scope remains manageable.
- After major changes, run linting and applicable build/typecheck/tests. Do not close work without reporting verification outcomes.
- Avoid full local test suite runs in constrained dev environments (for example WSL instability/OOM risk); default to targeted impacted-suite runs unless the user explicitly requests full local suite execution.
- Scope-completeness gate (machine-friendly): before finalizing, explicitly map completed work against every user-requested in-scope item; unresolved items must remain open and be reported. If the user asks "did we miss something?" and in-scope work was missed, treat it as a process failure and tighten AGENTS/policy in the same change set.

### External Library/Tooling Expectations

- Do not rely on stale memory for external libraries; verify current syntax/usage in official docs (Context7 preferred, web search as needed).
- Do not abandon required libraries due to first-pass errors; correct usage patterns first.
- If repeated issues occur, find and document root cause instead of random trial-and-error.
- Read and re-read key context docs for the active feature and deduplicate contradictory/redundant guidance before proceeding.
- Organize code into appropriate files/modules and optimize for readability.
- Preserve existing working behavior as a primary constraint and actively watch for regressions.
- For UI/UX tasks, maintain high standards for usability, visual quality, and interaction design.

### Session Artifact Contracts (Required)

- Workspace layout contract:
  - Bootstrap defaults to external workfiles mode: `.agents` is a symlink to `<agents-workfiles-path>/<project-id>` (default path `../agents-workfiles`).
  - Local `.agents` directory mode is allowed only when bootstrap is explicitly set to `--agents-mode local`.
  - If running from a worktree, `.agents` in that worktree must be a symlink to the canonical root.
  - Keep all non-primary worktrees under `../<repo-name>.worktrees`.
- Keep canonical machine-readable execution queue in `.agents/EXECUTION_QUEUE.json`:
  - top-level: `version`, `created_at`, `updated_at`, `last_updated`, `state`, `feature_id`, `task_id`, `objective`, `in_scope`, `out_of_scope`, `acceptance_criteria`, `constraints`, `references`, `open_questions`, `deferred_reason`, `cancel_reason`, `items`.
  - top-level `state` values: `active`, `deferred`, `pending`, `complete`.
  - each item: `id`, `idempotency_key`, `feature_id`, `subscope`, `title`, `type`, `state`, `created_at`, `updated_at`, `planned_at`, `owner`, `acceptance_criteria`, `constraints`, `references`, `depends_on`, `plan_ref`, `execution_started_at`, `completed_at`, `claimed_by`, `claimed_at`, `lease_expires_at`, `attempt_count`, `last_attempt_at`, `last_error`, `retry_after`, `outputs`, `evidence`, `resolution_summary`, `deferred_reason`, `cancel_reason`.
  - item `state` values: `active`, `deferred`, `pending`, `complete`.
- Single queue authority:
  - `.agents/EXECUTION_QUEUE.json` is the only active scope/queue authority for orchestrator and subagents.
  - Do not maintain parallel queue/scope state files.
- Plan-to-queue synchronization:
  - `npm run agent:preflight` must auto-register every `.agents/plans/current/*/PLAN.json` and `.agents/plans/deferred/*/PLAN.json` as queue items (state defaults: `pending` for current, `deferred` for deferred).
  - Each plan track must include `.agents/plans/<root>/<feature_id>/PLAN.json` as the machine lifecycle contract; preflight seeds/normalizes it and policy checks fail if missing/invalid.
  - If `PLAN.md` exists in current/deferred plan tracks, preflight must convert/migrate it into canonical `PLAN.json`; Markdown remains historical only.
- During migration, preflight should extract `Spec outline`, `Refined spec`, and `Detailed implementation plan`/`Implementation plan` section text into `PLAN.json.narrative.<section>.summary` when present, migrate legacy `spec_outline.steps`/`refined_spec.steps` to `full_spec_outline`/`full_refined_spec`, deterministically normalize legacy spec/refined entry shapes (for example plain strings and `{text: ...}` objects) into required structured entry contracts, normalize legacy implementation-step objects into the required implementation-step shape, backfill missing implementation-step references from concrete context when available, initialize missing implementation-step `acceptance_criteria` deterministically from available step context when possible (otherwise `[]`), and backfill `narrative.pre_spec_outline.purpose_goals` from `narrative.spec_outline.summary` when no explicit pre-spec purpose/goals text is available.
  - `PLAN.json` must keep `plan_ref` aligned to the canonical queue-tracked plan artifact (`PLAN.json`) and include canonical planning stage + narrative + subagent fields (`subagent.last_executor` must be null or a non-empty string, and must be non-empty when plan `status` is `in_progress` or `complete`).
  - Policy enforcement must fail if any current/deferred plan directory lacks a corresponding queue item `plan_ref`.
  - `npm run agent:preflight` must also backfill archived feature plans (`.agents/plans/archived/*/PLAN.json`) into `.agents/EXECUTION_ARCHIVE_INDEX.json` and the corresponding `.agents/archives/<feature_id>.jsonl` shard.
- Scoped queue read discipline:
  - Load required top-level fields first (`state`, `feature_id`, `task_id`, `objective`, `last_updated`, `updated_at`, `in_scope`, `out_of_scope`, `open_questions`), then select only relevant queue items for the current work item/feature.
  - Prefer selectors `id`, `plan_ref`, `owner`, and dependency closure via `depends_on`; avoid loading the full `items` array when not required.
- Queue execution-state gate:
  - no item may enter execution states unless it was first planned in queue with valid `planned_at`.
  - item states `active`/`complete` require `execution_started_at`; state `complete` requires `completed_at`, non-empty `outputs`/`evidence`, non-empty `resolution_summary`, and at least one verification evidence entry prefixed `verify:`.
  - item state `active` requires a valid claim lease triplet: `claimed_by`, `claimed_at`, `lease_expires_at`.
  - queue or item state `deferred` requires `deferred_reason`.
- Archive-on-complete gate:
  - when an item enters `complete`, move it out of `.agents/EXECUTION_QUEUE.json` into `.agents/archives/<feature_id>.jsonl` in the same session.
  - when a feature/top-level queue enters `complete`, archive the feature snapshot and reset hot queue state from `complete`.
  - maintain `.agents/EXECUTION_ARCHIVE_INDEX.json` as lookup metadata for archived records.
  - do not read archive shards during normal startup; load archive files only for explicit historical/regression lookup.
- CONTEXT_INDEX drift guard:
  - Keep `.agents-config/docs/CONTEXT_INDEX.json` synchronized with `.agents-config/templates/AGENTS.md`, policy contracts, and command map entries.
  - Policy checks must fail if `.agents-config/docs/CONTEXT_INDEX.json` paths/headings/commands drift from canonical contracts.
- Idempotency contract:
  - `id` and `idempotency_key` must be stable and unique per item.
  - retries/restarts must update the same queue item identity rather than creating duplicate logical work.
- Consolidation boundary:
  - `.agents/EXECUTION_QUEUE.json` is authoritative for atomic execution state.
  - `.agents/MEMORY.md` records durable decisions/outcomes/history, not queue status.
  - `.agents/SESSION_LOG.md` records implementation trace entries, not queue status.
- `PLAN.json` files are machine-authoritative plan lifecycle and narrative-context records.
- Optional `PLAN.md` files are legacy historical context and must not be treated as authoritative state.
- Stale-link hygiene:
  - Run an automated stale reference scan for `.agents/plans/**` paths; unresolved references must fail preflight/policy checks by default.
- Treat `.agents/SESSION_BRIEF.json` as a required generated artifact from preflight, not a hand-authored policy source.
- Validate `.agents/SESSION_BRIEF.json` schema and freshness; stale or missing briefs are CI/local failures until refreshed via preflight.

### MEMORY.md and SESSION_LOG.md Contracts (Required)

Maintain one canonical memory file for this workspace: `.agents/MEMORY.md`.
Maintain one canonical session trace file for this workspace: `.agents/SESSION_LOG.md`.

- Read `.agents/MEMORY.md` at session start and after any context compaction before implementation.
- Do not require re-reading `.agents/MEMORY.md` every turn when no compaction/reset occurred.
- Treat `.agents/MEMORY.md` as canonical context after compaction; do not rely on prior chat/tool output unless reflected there.
- `.agents/MEMORY.md` is curated semantic memory and the reference point for all memory artifacts, not an append-only transcript.
- Keep `.agents/MEMORY.md` bounded and high-signal; edit/remove stale items instead of appending history forever.
- Structure `.agents/MEMORY.md` with curated sections:
  - `## User Directives`
  - `## Architecture Decisions`
  - `## Known Gotchas`
  - `## Submemory Index`
- `## Submemory Index` is the lookup table for memory directories so agents can find one memory without reading all memory files.
- Submemory index entry format (one line per memory):
  - `- mNNN | .agents/memory/mNNN/_submemory.md | One sentence description.`
- Submemory directory naming is required to be short and consistent: `mNNN` (for example `m001`, `m014`).
- Each submemory directory must contain `_submemory.md` as the canonical freeform memory file.
- Route implementation traces to `.agents/SESSION_LOG.md`, not `.agents/MEMORY.md`.
- Keep `.agents/SESSION_LOG.md` under `## [ENTRIES]` and append timestamp/provenance entries using policy-enforced format.

### Definition of Done

A task is done when all of the following are true:

- Requested change is implemented (or question answered) and behavior impact is explained (what changed, where, why).
- Verification is reported:
  - build attempted when code changed,
  - linting run when code changed,
  - tests/typecheck run as applicable,
  - remaining warnings/errors are either fixed or explicitly listed as out-of-scope.
- Documentation is updated for impacted areas.
- Follow-ups are listed for intentionally deferred work.
- `.agents/MEMORY.md` is curated to reflect active directives/decisions/gotchas, and `.agents/SESSION_LOG.md` reflects implementation trace activity.
- Scope-completeness check is reported against the user request, with no in-scope requested item left unaccounted for.
