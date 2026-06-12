# ACM Feature Plans

This file defines the repo-local feature planning convention that sits on top of ACM's built-in plan/task schema.

ACM remains the system of record for active plans and task state. This document makes the expected structure visible in the repo so feature planning is not "only in the database."

## When It Applies

Use this contract for net-new feature work and large user-facing capability expansions.

Do not force it onto small bugfixes, review-only tasks, workflow-governance work, or narrow maintenance changes. Those can keep using thinner ACM plans.

## Root Feature Plan

Create one root ACM plan with:

- `kind=feature`
- `objective`
- `in_scope`
- `out_of_scope`
- `constraints`
- `references`
- `stages.spec_outline`
- `stages.refined_spec`
- `stages.implementation_plan`

The root plan should model the whole feature, not one implementation slice.

## Root Task Shape

Root feature plans must include these top-level tasks:

- `stage:spec-outline`
- `stage:refined-spec`
- `stage:implementation-plan`
- `verify:tests`

The three `stage:*` tasks are grouping tasks. They stay top-level and do not set `parent_task_key`.
Their task status should mirror the corresponding plan stage status.

Place concrete planning or implementation tasks underneath them with `parent_task_key`. Example child task keys:

- `spec:library-empty-states`
- `spec:playback-fallbacks`
- `impl:backend-contract`
- `impl:frontend-surface`

Leaf tasks should carry explicit `acceptance_criteria`.

## Feature Streams

If the feature splits into parallel workstreams, create child plans with:

- `kind=feature_stream`
- `parent_plan_key=<root feature plan key>`
- their own `objective`
- their own `in_scope`
- their own `out_of_scope`
- their own `references`
- their own task list, including `verify:tests`

The root feature plan holds the whole feature contract. Child stream plans hold a bounded slice of execution.

## Example

Root feature plan:

```bash
acm work --project soundspan --receipt-id <feature-receipt-id> --mode merge \
  --plan-json '{
    "title":"Offline playlist downloads",
    "kind":"feature",
    "objective":"Add bounded offline playlist downloads across backend, frontend, and operator surfaces.",
    "status":"in_progress",
    "stages":{
      "spec_outline":"complete",
      "refined_spec":"complete",
      "implementation_plan":"in_progress"
    },
    "in_scope":["Playlist download UX", "Backend download job orchestration"],
    "out_of_scope":["DRM bypass", "mobile-native packaging"],
    "constraints":["Keep existing streaming playback stable during rollout"],
    "references":["docs/USAGE_GUIDE.md", "backend/src/routes/playlists.ts"]
  }' \
  --tasks-json '[
    {"key":"stage:spec-outline","summary":"Spec outline","status":"complete"},
    {"key":"spec:download-capabilities","summary":"Define required capabilities","status":"complete","parent_task_key":"stage:spec-outline","acceptance_criteria":["Capability list covers UX, backend, and operator impacts"]},
    {"key":"stage:refined-spec","summary":"Refined spec","status":"complete"},
    {"key":"spec:rollout-constraints","summary":"Define rollout and failure boundaries","status":"complete","parent_task_key":"stage:refined-spec","acceptance_criteria":["Failure handling and rollout constraints are explicit"]},
    {"key":"stage:implementation-plan","summary":"Implementation plan","status":"in_progress"},
    {"key":"impl:backend-jobs","summary":"Implement backend job flow","status":"in_progress","parent_task_key":"stage:implementation-plan","acceptance_criteria":["Job flow is implemented with targeted regression coverage"]},
    {"key":"verify:tests","summary":"Run verification for feature work","status":"pending"}
  ]'
```

Child stream plan:

```bash
acm work --project soundspan --receipt-id <stream-receipt-id> --mode merge \
  --plan-json '{
    "title":"Offline playlist downloads - backend stream",
    "kind":"feature_stream",
    "parent_plan_key":"plan:<feature-receipt-id>",
    "objective":"Implement the backend slice of offline playlist downloads.",
    "status":"in_progress",
    "in_scope":["Backend job flow", "download state persistence"],
    "out_of_scope":["Frontend download controls"],
    "references":["backend/src/routes/playlists.ts", "backend/src/services"]
  }' \
  --tasks-json '[
    {"key":"impl:queue-jobs","summary":"Queue offline download jobs","status":"in_progress","acceptance_criteria":["Jobs persist and retry deterministically"]},
    {"key":"impl:download-state","summary":"Persist download state","status":"pending","depends_on":["impl:queue-jobs"],"acceptance_criteria":["State transitions are visible to the frontend contract"]},
    {"key":"verify:tests","summary":"Run backend verification for the stream","status":"pending"}
  ]'
```

## Verification

Use `acm verify` with the active receipt and changed files so the repo-local validator is selected:

```bash
acm verify --project soundspan --receipt-id <receipt-id> --phase review --file-changed backend/src/routes/social.ts
```

That verify check executes `scripts/acm-feature-plan-validate.py` with the active receipt and plan context.

For plans in the feature schema, it fails when required metadata, stage grouping, hierarchy links, or leaf-task acceptance criteria are missing. For non-feature plans, the script exits cleanly and the gate is not selected.
