# AGENT_RULES.md

Human-readable behavioral contract for LLM agents in this repository.

Machine-readable canonical policy remains `.github/policies/agent-governance.json`.

## Rule ID Catalog (Machine Cross-Reference)

These IDs are stable cross-references for enforceable behavior and map to policy contracts/checks.

- `rule_startup_read_order`: Follow startup read order and run session preflight before non-trivial implementation.
- `rule_context_index_usage`: Use `docs/CONTEXT_INDEX.json` as the machine-readable map for context lookup.
- `rule_execution_queue_required`: Maintain canonical machine-readable execution queue in `.agents/EXECUTION_QUEUE.json`.
- `rule_queue_plan_before_execution`: Plan all execution work into queue entries before changing any entry to active execution state.
- `rule_queue_single_source_of_truth`: Use `.agents/EXECUTION_QUEUE.json` as the only queue/scope authority across orchestrator and subagents.
- `rule_queue_scoped_context_read`: Read only queue fields/items relevant to the active feature/item scope to preserve context efficiency.
- `rule_queue_archive_on_complete`: Move completed task/feature work from hot queue into feature-sharded archive artifacts.
- `rule_scope_tight_no_overbroad_refactor`: Keep changes narrowly scoped unless the user explicitly requests broad refactors.
- `rule_hybrid_machine_human_contract`: Use machine-readable contracts as authority with concise human nuance addenda when needed.
- `rule_policy_sync_required`: When process expectations change, update policy + enforcement + human docs together.
- `rule_continuity_required`: Read and maintain `.agents/CONTINUITY.md` as canonical continuity context.
- `rule_post_compaction_rebootstrap`: Treat compaction recovery as full startup and run preflight.
- `rule_repo_index_preflight_gate`: Require preflight index readiness checks (build if missing, strict verify if present) before implementation starts.
- `rule_context_index_drift_guard`: Keep `docs/CONTEXT_INDEX.json` synchronized with policy/documentation contracts and fail checks on drift.
- `rule_canonical_agents_root`: Treat `/home/joshd/git/soundspan/.agents` as the single canonical local agent-context root.
- `rule_worktree_root_required`: Keep all non-primary Git worktrees under `/home/joshd/git/soundspan/.worktrees`.
- `rule_tdd_default`: Prefer true TDD and document deviations when strict TDD is impractical.
- `rule_coverage_default_100`: Treat 100% coverage as default bar unless user-approved exception exists.
- `rule_scope_completeness_gate`: Explicitly map outcomes to all in-scope user requests before closeout.

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

### Container-First Policy (Required)

- Never install system packages on the host unless explicitly instructed by the user.
- Use containers by default for project tooling and dependency workflows.
- Prefer existing project container workflows (`Dockerfile`, compose files, Make targets) for tool/runtime dependencies.
- If a needed workflow has no containerized path, create a minimal containerized path and document it here.
- Keep repo-specific container details in `docs/AGENT_CONTEXT.md`.

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

- When operating in Codex CLI, prefer Git worktrees for non-trivial parallelizable tasks instead of stacking unrelated edits in one working tree.
- Prefer parallel agents/subagents for independent task slices when available.
- Canonical shared `.agents` root is `/home/joshd/git/soundspan/.agents` (git-ignored local context).
- Treat `.agents/**` as shared multi-writer state; reconcile concurrent edits using semantic merges instead of blind overwrite.
- All non-primary Git worktrees must live under `/home/joshd/git/soundspan/.worktrees`.
- For worktree execution, copy required local `.gitignore`d context files into the worktree (for example `.agents/**`, `.agents/plans/**`, and other local context files needed for correctness), keep them untracked, and never commit/push them.

### Orchestrator/Subagent Instruction Contract (Required)

- Canonical enforceable source for orchestrator/subagent behavior: `.github/policies/agent-governance.json` at `contracts.orchestratorSubagent`.
- Keep this section concise for humans; machine-enforceable rule text, required payload fields, and default CLI routing live in policy.
- Contract IDs (policy-canonical):
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

Machine vs human guidance split for orchestration:

- Machine-readable payload/config drives execution and validation.
- Human-readable addendum captures nuance, rationale, and caveats not encoded in schema fields.
- Default Codex subagent model is `gpt-5.3-codex-spark` unless the user explicitly overrides model selection.

## Policy-as-Code Enforcement

Critical agent/process rules are enforced by executable checks instead of prose-only guidance.

- Policy manifest (canonical enforceable contracts + checks): `.github/policies/agent-governance.json`
- Enforcement runner: `.github/scripts/enforce-agent-policies.mjs`
- Local command: `node .github/scripts/enforce-agent-policies.mjs`
- Session preflight command: `npm run agent:preflight`
- CI gate: `.github/workflows/pr-checks.yml` job `policy-as-code` (runs before frontend lint/docker build checks)

When policy expectations change, update all relevant governance artifacts in the same change set:

1. `AGENTS.md` (bootstrap contract)
2. `docs/AGENT_RULES.md` (human-readable rules contract)
3. `docs/AGENT_CONTEXT.md` (human-readable context contract, when impacted)
4. `docs/CONTEXT_INDEX.json` (machine-readable context map)
5. `.github/policies/agent-governance.json` (machine-readable source of truth)
6. `.github/scripts/enforce-agent-policies.mjs` (enforcement logic)

## LLM Continuity and Execution Discipline

### Persistent Rules

- If the user adds or changes a process rule, update `AGENTS.md` and `docs/AGENT_RULES.md` in the same change set and enforce it via policy-as-code (`.github/policies/agent-governance.json` and `.github/scripts/enforce-agent-policies.mjs`).
- Work exhaustively with zero guesswork: if a required fact is unknown, explicitly look it up/verify it before proceeding.
- Do not trim or skip relevant context; preserve complete context for correctness-critical work unless the user explicitly asks to narrow scope.
- Record material findings/decisions in persistent context artifacts (`.agents/CONTINUITY.md`, `.agents/EXECUTION_QUEUE.json`, and plan files) to survive context compaction.
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
- Detailed plans must break work into atomic tasks with explicit status: `Pending`, `In Progress`, `Complete`.
- Mark a task `In Progress` before implementation; when marked `Complete`, add a short completion summary (files changed + verification result).
- Work in small batches and checkpoint frequently; if you cannot commit directly, instruct the user to commit at logical milestones.
- Before moving to a new task/session/phase, update current task summaries to reflect actual work and verification status.
- For large/ambiguous initiatives, get explicit user approval before entering implementation.
- Do not execute non-trivial implementation work until planning detail is sufficient and user approval to proceed is explicit.
- For very large or vague requests, break work into smaller subtasks; if still unclear, ask the user to narrow scope.
- For non-trivial phase transitions, pause and confirm direction with the user before proceeding.
- Explicit queue gate: before execution starts, add/update atomic work items in `.agents/EXECUTION_QUEUE.json` with `planned_at` metadata and acceptance criteria.
- Plan architecture is intentionally simple:
  - required per active feature directory: `PLAN.md`
  - optional as needed: `HANDOFF.md`, `PROMPT_HISTORY.md`, `EVIDENCE.md`
  - legacy `*_PLAN.md` and `LLM_SESSION_HANDOFF.md` files remain valid historical formats.

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
  1. Re-read `AGENTS.md`, `docs/AGENT_RULES.md`, `docs/CONTEXT_INDEX.json`, and `docs/AGENT_CONTEXT.md`.
  2. Confirm branch + workspace state (`git rev-parse --abbrev-ref HEAD`, `git status --short`).
  3. Load `.agents/EXECUTION_QUEUE.json` and `.agents/CONTINUITY.md`; both are required startup artifacts.
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
  - Canonical shared `.agents` root is `/home/joshd/git/soundspan/.agents` (git-ignored local context).
  - If running from a worktree, `.agents` in that worktree must be a symlink to the canonical root.
  - Keep all non-primary worktrees under `/home/joshd/git/soundspan/.worktrees`.
- Keep canonical machine-readable execution queue in `.agents/EXECUTION_QUEUE.json`:
  - top-level: `version`, `created_at`, `updated_at`, `last_updated`, `state`, `feature_id`, `task_id`, `objective`, `in_scope`, `out_of_scope`, `acceptance_criteria`, `constraints`, `references`, `open_questions`, `deferred_reason`, `cancel_reason`, `items`.
  - top-level `state` values: `active`, `deferred`, `pending`, `complete`.
  - each item: `id`, `idempotency_key`, `feature_id`, `subscope`, `title`, `type`, `state`, `created_at`, `updated_at`, `planned_at`, `owner`, `acceptance_criteria`, `constraints`, `references`, `depends_on`, `plan_ref`, `execution_started_at`, `completed_at`, `claimed_by`, `claimed_at`, `lease_expires_at`, `attempt_count`, `last_attempt_at`, `last_error`, `retry_after`, `outputs`, `evidence`, `resolution_summary`, `deferred_reason`, `cancel_reason`.
  - item `state` values: `active`, `deferred`, `pending`, `complete`.
- Single queue authority:
  - `.agents/EXECUTION_QUEUE.json` is the only active scope/queue authority for orchestrator and subagents.
  - Do not maintain parallel queue/scope state files.
- Plan-to-queue synchronization:
  - `npm run agent:preflight` must auto-register every `.agents/plans/current/*/PLAN.md` and `.agents/plans/deferred/*/PLAN.md` as queue items (state defaults: `pending` for current, `deferred` for deferred).
  - Policy enforcement must fail if any current/deferred plan directory lacks a corresponding queue item `plan_ref`.
  - `npm run agent:preflight` must also backfill archived feature plans (`.agents/plans/archived/*/PLAN.md`) into `.agents/EXECUTION_ARCHIVE_INDEX.json` and the corresponding `.agents/archives/<feature_id>.jsonl` shard.
- Scoped queue read discipline:
  - Load required top-level fields first (`state`, `feature_id`, `task_id`, `objective`, `last_updated`, `updated_at`, `in_scope`, `out_of_scope`, `open_questions`), then select only relevant queue items for the current work item/feature.
  - Prefer selectors `id`, `plan_ref`, `owner`, and dependency closure via `depends_on`; avoid loading the full `items` array when not required.
- Queue execution-state gate:
  - no item may enter execution states unless it was first planned in queue with valid `planned_at`.
  - item states `active`/`complete` require `execution_started_at`; state `complete` requires `completed_at`, non-empty `outputs`/`evidence`, and non-empty `resolution_summary`.
  - item state `active` requires a valid claim lease triplet: `claimed_by`, `claimed_at`, `lease_expires_at`.
  - queue or item state `deferred` requires `deferred_reason`.
- Archive-on-complete gate:
  - when an item enters `complete`, move it out of `.agents/EXECUTION_QUEUE.json` into `.agents/archives/<feature_id>.jsonl` in the same session.
  - when a feature/top-level queue enters `complete`, archive the feature snapshot and reset hot queue state from `complete`.
  - maintain `.agents/EXECUTION_ARCHIVE_INDEX.json` as lookup metadata for archived records.
  - do not read archive shards during normal startup; load archive files only for explicit historical/regression lookup.
- Repository index readiness gate:
  - `npm run agent:preflight` must check branch/worktree index readiness.
  - If the active namespaced index is missing, preflight builds it before continuing.
  - If the active namespaced index exists, preflight runs strict verify before implementation starts.
  - If strict verify fails, treat it as a blocking failure unless policy explicitly sets warn mode.
- End-of-task index verification:
  - When feasible, run `npm run index:verify` before final handoff.
  - If verify reports drift, run `npm run index:build` and re-run verify in the same session.
- CONTEXT_INDEX drift guard:
  - Keep `docs/CONTEXT_INDEX.json` synchronized with `AGENTS.md`, policy contracts, and command map entries.
  - Policy checks must fail if `docs/CONTEXT_INDEX.json` paths/headings/commands drift from canonical contracts.
- Idempotency contract:
  - `id` and `idempotency_key` must be stable and unique per item.
  - retries/restarts must update the same queue item identity rather than creating duplicate logical work.
- Consolidation boundary:
  - `.agents/EXECUTION_QUEUE.json` is authoritative for atomic execution state.
  - `.agents/CONTINUITY.md` records decisions/outcomes/history, not queue status.
  - `PLAN.md` files provide human detail and should reference queue item IDs instead of duplicating status tracking.
- Stale-link hygiene:
  - Run an automated stale reference scan for `.agents/plans/**` paths; unresolved references must fail preflight/policy checks by default.
- Treat `.agents/SESSION_BRIEF.json` as a generated artifact from preflight, not a hand-authored policy source.
- Validate `.agents/SESSION_BRIEF.json` schema when present; stale brief age beyond policy threshold is a CI/local failure until refreshed via preflight.

### CONTINUITY.md Contract (Required)

Maintain one canonical continuity file for this workspace: `.agents/CONTINUITY.md`.

- Read `.agents/CONTINUITY.md` at the start of every assistant turn before acting.
- Treat `.agents/CONTINUITY.md` as canonical context after compaction; do not rely on prior chat/tool output unless reflected there.
- Update it only when there is a meaningful delta in:
  - `[PLANS]`
  - `[DECISIONS]`
  - `[PROGRESS]`
  - `[DISCOVERIES]`
  - `[OUTCOMES]`
- Keep continuity entries factual only (no transcripts, no raw logs).
- Every continuity entry must include:
  - ISO timestamp (for example `2026-01-13T09:42Z`)
  - provenance tag: `[USER]`, `[CODE]`, `[TOOL]`, or `[ASSUMPTION]`
  - `UNCONFIRMED` label when uncertain (never guess)
- If a fact changes, add a superseding entry; do not silently rewrite history.
- Keep the file short and high-signal; compress older detail into `[MILESTONE]` bullets when it grows.

### Definition of Done

A task is done when all of the following are true:

- Requested change is implemented (or question answered) and behavior impact is explained (what changed, where, why).
- Verification is reported:
  - build attempted when code changed,
  - linting run when code changed,
  - tests/typecheck run as applicable,
  - `npm run index:verify` run when index-backed retrieval was used or index-governance artifacts changed (with rebuild + re-verify if drifted),
  - remaining warnings/errors are either fixed or explicitly listed as out-of-scope.
- Documentation is updated for impacted areas.
- Follow-ups are listed for intentionally deferred work.
- `.agents/CONTINUITY.md` is updated when goal/state/decisions materially changed.
- Scope-completeness check is reported against the user request, with no in-scope requested item left unaccounted for.
