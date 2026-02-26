# Testing Guide

This document is the canonical testing reference for soundspan.

It defines:

- testing frameworks by component,
- test directory structure and naming conventions,
- CI visibility/gating behavior,
- manual vs automated test boundaries.

## Frameworks by Component

| Component | Framework | Primary command(s) | Notes |
| --- | --- | --- | --- |
| Backend (`backend/`) | Jest + ts-jest | `npm --prefix backend test`, `npm --prefix backend run test:coverage` | Unit/integration/contract/runtime tests under `backend/src/**/__tests__` |
| Frontend (`frontend/`) | Node test runner (unit + component + coverage), Playwright (E2E), ESLint | `npm --prefix frontend run test:unit`, `npm --prefix frontend run test:coverage`, `npm --prefix frontend run test:component`, `npm --prefix frontend run test:component:coverage`, `npm --prefix frontend run test:component:coverage:changed`, `npm --prefix frontend run test:coverage:social`, `npm --prefix frontend run test:e2e`, `npm --prefix frontend run test:predeploy`, `npm --prefix frontend run lint` | Unit specs under `frontend/tests/unit`; component specs under `frontend/tests/component`; E2E specs under `frontend/tests/e2e` |
| Python sidecars (`services/*`) | `pytest` (scaffolded) | N/A | `tests/` directories are in place; runnable sidecar test cases are still to be added |

## Directory Structure (Canonical)

### Backend (automated Jest tests)

The backend uses colocated `__tests__` directories under `backend/src/`.

| Path | Scope |
| --- | --- |
| `backend/src/__tests__/` | entrypoint/runtime/contract behavior crossing domains |
| `backend/src/routes/__tests__/` | route compatibility and API contract tests |
| `backend/src/services/__tests__/` | service-level behavior/regression tests |
| `backend/src/services/discovery/__tests__/` | discovery subsystem tests |
| `backend/src/workers/__tests__/` | worker orchestration/scheduler/claim behavior |
| `backend/src/workers/processors/__tests__/` | queue processor behavior tests |
| `backend/src/jobs/__tests__/` | background job modules |
| `backend/src/middleware/__tests__/` | middleware auth/rate-limit behavior |
| `backend/src/utils/__tests__/` | utility-level tests |

### Backend (manual/diagnostic scripts, not part of Jest suite)

Manual scripts live under `backend/scripts/manual-tests/`.

| Path | Purpose | Command |
| --- | --- | --- |
| `backend/scripts/manual-tests/artistNormalization.ts` | artist normalization diagnostics | `npm --prefix backend run test:manual:artist-normalization` |
| `backend/scripts/manual-tests/downloadDedup.ts` | end-to-end download dedup diagnostics | `npm --prefix backend run test:manual:download-dedup` |

These scripts intentionally run outside Jest because they are operator diagnostics and may require live DB/service state.

### Frontend

| Path | Scope |
| --- | --- |
| `frontend/tests/unit/*.test.ts` | lightweight unit/logic tests (Node test runner + TS strip-types) |
| `frontend/tests/component/*.test.ts` | server-rendered component regressions for targeted UI surfaces |
| `frontend/tests/e2e/*.spec.ts` | high-level smoke and user-flow tests |
| `frontend/tests/e2e/predeploy/*.spec.ts` | release-readiness/predeploy flows |
| `frontend/tests/e2e/fixtures/` | Playwright helper fixtures |

## Naming Conventions

### Backend Jest tests

- `*Compat.test.ts`: API/client compatibility contracts.
- `*Contract.test.ts`: explicit protocol/behavior contracts.
- `*Runtime.test.ts`: runtime bootstrap/lifecycle behavior with mocks.
- domain-specific descriptive names for targeted regressions.

### Frontend Playwright tests

- `*.spec.ts` for E2E flows.
- `predeploy/` subtree for release-focused validation paths.
- `predeploy/media-contract.spec.ts` validates direct and segmented media contracts (`Range` + `206`, CORS headers, and content-type correctness; MP4 responses also get fast-start `moov` sanity checks).

### Frontend Node unit tests

- `*.test.ts` under `frontend/tests/unit/`.
- Keep tests focused on deterministic UI/domain logic helpers.
- For targeted coverage gating, use `npm --prefix frontend run test:coverage`.

### Frontend component tests

- `*.component.test.ts` under `frontend/tests/component/`.
- Use Node test runner with module-mock support and the existing `tsx` loader path.
- For social-surface changed-line coverage gating, use:
  - `npm --prefix frontend run test:component:coverage:changed`
  - Optional base override: `SOCIAL_COVERAGE_BASE=<git-ref> npm --prefix frontend run test:component:coverage:changed`

## Running Tests Locally

### Backend

```bash
npm --prefix backend ci
npm --prefix backend test
npm --prefix backend run test:coverage
```

Optional smoke checks:

```bash
npm --prefix backend run test:smoke
npm --prefix backend run test:smoke:mbid-auth
npm --prefix backend run test:smoke:subsonic-proxy
npm --prefix backend run test:analyzer:phase4
```

### Frontend

```bash
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend run test:unit
npm --prefix frontend run test:coverage
npm --prefix frontend run test:component
npm --prefix frontend run test:component:coverage
npm --prefix frontend run test:component:coverage:changed
npm --prefix frontend run test:coverage:social
npm --prefix frontend run test:e2e
npm --prefix frontend run test:predeploy
```

Notes:

- `test:unit` and `test:coverage` use Node's built-in TypeScript strip-types path and require Node `24+`.

### Frontend E2E on host-run +1 ports (recommended)

When a live/dev stack may already be using canonical ports (`3030`/`3006`), run local validation on `3031`/`3007`.
This section is for host-run source workflows (`npm run dev`), not pre-published production frontend images.

```bash
docker compose -f docker-compose.local.yml up -d postgres-local redis-local
PORT=3007 npm --prefix backend run dev
PORT=3031 BACKEND_URL=http://127.0.0.1:3007 NEXT_PUBLIC_API_URL=http://127.0.0.1:3007 NEXT_PUBLIC_API_PATH_MODE=direct npm --prefix frontend run dev
```

Run Playwright against the explicit +1 frontend URL:

```bash
SOUNDSPAN_UI_BASE_URL=http://127.0.0.1:3031 npm --prefix frontend run test:predeploy
```

Low-memory guidance:

- Prefer targeted impacted specs first.
- Use `--workers=1` for local stability.
- Run full predeploy/full E2E only when requested or when system headroom is sufficient.

## CI Visibility and Coverage

Quality visibility workflow:

- `.github/workflows/quality-visibility.yml`

Current behavior:

- backend Jest tests + coverage summary/artifacts,
- frontend lint/build + targeted unit coverage and E2E inventory visibility,
- non-blocking by default (configurable to blocking via repo vars).

Backend coverage artifacts include:

- `backend/coverage/lcov.info`
- `backend/coverage/coverage-summary.json`
- `backend/coverage/jest-results.json`
- generated markdown summary (`backend/coverage/coverage-summary.md`)

Policy and governance checks:

- `.github/workflows/pr-checks.yml` (`policy-as-code` job)
- `.agents-config/scripts/enforce-agent-policies.mjs`
- `.agents-config/policies/agent-governance.json`

## Sidecar Test Standard

Python sidecar test scaffolds now exist at:

- `services/audio-analyzer/tests/`
- `services/audio-analyzer-clap/tests/`

Use this structure consistently when adding sidecar tests:

- `services/<service-name>/tests/`
- files named `test_*.py`
- `pytest` as the default framework
- deterministic tests with external calls mocked/stubbed

This keeps sidecars aligned with framework-native best practice and discoverable test layout.
