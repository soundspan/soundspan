# Testing Guide

This document is the canonical testing reference for soundspan.

It defines:

- testing frameworks by component,
- test directory structure and naming conventions,
- CI visibility/gating behavior,
- manual vs automated test boundaries.

## Frameworks by Component

| Component                      | Framework                                                                            | Primary command(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Notes                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (`backend/`)           | Jest + ts-jest                                                                       | `npm --prefix backend test`, `npm --prefix backend run test:coverage`                                                                                                                                                                                                                                                                                                                                                                                                                                        | Unit/integration/contract/runtime tests under `backend/src/**/__tests__`                                                                                                                                                                                                                     |
| Frontend (`frontend/`)         | Node test runner (unit + component + coverage), Playwright (E2E), ESLint, TypeScript | `npm --prefix frontend run typecheck`, `npm --prefix frontend run test:unit`, `npm --prefix frontend run test:coverage`, `npm --prefix frontend run test:component`, `npm --prefix frontend run test:component:coverage`, `npm --prefix frontend run test:component:coverage:changed`, `npm --prefix frontend run test:coverage:social`, `npm --prefix frontend run test:config:runtime`, `npm --prefix frontend run test:e2e`, `npm --prefix frontend run test:predeploy`, `npm --prefix frontend run lint` | Standalone typecheck covers source and test files; unit specs live under `frontend/tests/unit`; component specs under `frontend/tests/component`; E2E specs under `frontend/tests/e2e`; the runtime-config smoke reloads production Next.js config after dependency pruning in the AIO image |
| Python sidecars (`services/*`) | `pytest`, Ruff, mypy                                                                 | `npm run verify:python`, `npm run verify:python-quality`, or `pytest services/<service>/tests -q` per service                                                                                                                                                                                                                                                                                                                                                                                                | Test suites run through the `Python Sidecar Tests` matrix; blocking static-analysis and format checks run through `Python Quality`. Counts drift; see CI output for the current totals.                                                                                                      |

## Directory Structure (Canonical)

### Backend (automated Jest tests)

The backend uses colocated `__tests__` directories under `backend/src/`.

| Path                                                  | Scope                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `backend/src/__tests__/`                              | entrypoint/runtime/contract behavior crossing domains             |
| `backend/src/config/__tests__/`                       | configuration-adjacent contract and OpenAPI synchronization tests |
| `backend/src/routes/__tests__/`                       | route compatibility and API contract tests                        |
| `backend/src/scripts/__tests__/`                      | backend maintenance and migration script tests                    |
| `backend/src/services/__tests__/`                     | service-level behavior/regression tests                           |
| `backend/src/services/discovery/__tests__/`           | discovery subsystem tests                                         |
| `backend/src/services/lidarr/__tests__/`              | Lidarr client and helper tests                                    |
| `backend/src/services/segmented-streaming/__tests__/` | segmented-streaming service tests                                 |
| `backend/src/workers/__tests__/`                      | worker orchestration/scheduler/claim behavior                     |
| `backend/src/workers/processors/__tests__/`           | queue processor behavior tests                                    |
| `backend/src/jobs/__tests__/`                         | background job modules                                            |
| `backend/src/middleware/__tests__/`                   | middleware auth/rate-limit behavior                               |
| `backend/src/utils/__tests__/`                        | utility-level tests                                               |

### Backend (manual/diagnostic scripts, not part of Jest suite)

Manual scripts live under `backend/scripts/manual-tests/`.

| Path                                                  | Purpose                               | Command                                                     |
| ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `backend/scripts/manual-tests/artistNormalization.ts` | artist normalization diagnostics      | `npm --prefix backend run test:manual:artist-normalization` |
| `backend/scripts/manual-tests/downloadDedup.ts`       | end-to-end download dedup diagnostics | `npm --prefix backend run test:manual:download-dedup`       |

These scripts intentionally run outside Jest because they are operator diagnostics and may require live DB/service state.

### Frontend

| Path                                     | Scope                                                            |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `frontend/tests/unit/*.test.ts`          | lightweight unit/logic tests (Node test runner + TS strip-types) |
| `frontend/tests/component/*.test.ts`     | server-rendered component regressions for targeted UI surfaces   |
| `frontend/tests/e2e/*.spec.ts`           | high-level smoke and user-flow tests                             |
| `frontend/tests/e2e/predeploy/*.spec.ts` | release-readiness/predeploy flows                                |
| `frontend/tests/e2e/fixtures/`           | Playwright helper fixtures                                       |

## Naming Conventions

### Backend Jest tests

- `*Compat.test.ts`: API/client compatibility contracts.
- `*Contract.test.ts`: explicit protocol/behavior contracts.
- `*Runtime.test.ts`: runtime bootstrap/lifecycle behavior with mocks.
- domain-specific descriptive names for targeted regressions.

### Frontend Playwright tests

- `*.spec.ts` for E2E flows.
- `predeploy/` subtree for release-focused validation paths.
- `predeploy/media-contract.spec.ts` validates media contract behavior (`Range` + `206`, CORS headers, content-type correctness; MP4 responses also get fast-start `moov` sanity checks).
- Segmented-specific rollout and validation guidance is documented separately in [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md).

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

### Repository orchestration

`npm run verify` runs the backend, frontend, Helm, and enforcement-gate checks.
Run `npm run verify:python` and `npm run verify:python-quality` separately for
the Python sidecar tests and blocking Python quality checks.

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
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:unit
npm --prefix frontend run test:coverage
npm --prefix frontend run test:component
npm --prefix frontend run test:component:coverage
npm --prefix frontend run test:component:coverage:changed
npm --prefix frontend run test:coverage:social
npm --prefix frontend run test:config:runtime
npm --prefix frontend run test:e2e
npm --prefix frontend run test:predeploy
```

Notes:

- `test:unit` and `test:coverage` use the `tsx` loader with Node's test runner.
- `typecheck` disables incremental state so local verification matches a clean CI checkout and includes standalone `tests/**` files.
- `lint` enforces the current ESLint warning budget with `--max-warnings=183`.
- `lint:hex` blocks increases above the 130-use baseline for arbitrary hardcoded
  hex utilities; use the centralized Tailwind theme tokens for new colors.

### Python sidecars

Use a Python 3.13+ environment with the quality tools from
`services/requirements-quality.txt` and each sidecar's test requirements
installed. The CI quality job uses Python 3.14 because tiddl requires Python
3.13 or newer, while mypy retains Python 3.11 semantics through `pyproject.toml`;
the shared environment mirrors local verification.

```bash
pip install \
  -r services/requirements-quality.txt \
  -r services/audio-analyzer/requirements-test.txt \
  -r services/vibe-provider-dclap/requirements-test.txt \
  -r services/tidal-downloader/requirements-test.txt \
  -r services/ytmusic-streamer/requirements-test.txt
npm run verify:python
npm run verify:python-quality
```

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

| CI job                                 | Blocking     | Checks                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend Tests + Coverage               | Configurable | Backend Jest tests plus coverage summary and artifacts.                                                                                                                                                                                                                                                               |
| Frontend Quality Visibility            | Configurable | ESLint with the enforced 183-warning ceiling, Next build, targeted unit coverage, component tests, and E2E inventory visibility.                                                                                                                                                                                      |
| Python Sidecar Tests (matrix)          | Configurable | The four sidecar `pytest` suites. The root AIO image-hardening suite runs in Python Quality and is also included by local `npm run verify:python`.                                                                                                                                                                    |
| Backend Typecheck / Frontend Typecheck | Configurable | Standalone TypeScript checks.                                                                                                                                                                                                                                                                                         |
| Helm Chart Visibility                  | Configurable | Helm lint and render assertions.                                                                                                                                                                                                                                                                                      |
| Python Quality                         | **Yes**      | Root AIO image-hardening tests, `ruff check`, `ruff format --check`, the aggregate `mypy` run, and four per-sidecar `mypy` runs that avoid top-level module collisions.                                                                                                                                               |
| Enforcement Gates                      | **Yes**      | Route-error canonicalization and its self-test, Dockerfile hygiene, the 130-use hardcoded-hex baseline, OpenAPI route synchronization, and repository-wide Prettier checks. Local `npm run verify:gates` also runs the infrastructure/release helper tests; the CI enforcement job does not currently run that check. |

The configurable visibility jobs are non-blocking by default and can be made
blocking through repository variables. `Python Quality` and `Enforcement Gates`
do not use `continue-on-error`; failures always fail the workflow.

### Enforced ratchets

- Frontend ESLint runs with `--max-warnings=183`; any warning count above that
  budget fails lint.
- `npm --prefix frontend run lint:hex` blocks increases above the baseline of
  130 arbitrary hardcoded-hex Tailwind utilities.
- `node scripts/ci/check-route-error-canon.mjs` enforces per-route-file
  baselines for ad-hoc `res.status(500).json(...)` responses. New route files
  have a zero baseline; lower a file's baseline when canonicalizing it.
- `openapiRouteSync.test.ts` keeps documented OpenAPI paths under their mounted
  namespaces, rejects known phantom unprefixed paths, and checks that the API
  version matches the backend package version.
- `npm run format:check` applies Prettier checks to the contract, backend,
  frontend, root scripts, and root JSON. `ruff format --check services/` is the
  corresponding blocking Python format check.
- `ruff check services/`, the aggregate mypy invocation, and four per-sidecar
  mypy invocations enforce the configured
  Python lint and typing baseline.

Backend coverage artifacts include:

- `backend/coverage/lcov.info`
- `backend/coverage/coverage-summary.json`
- `backend/coverage/jest-results.json`
- generated markdown summary (`backend/coverage/coverage-summary.md`)

### Recommended gating ratchet (owner-paced)

These steps require owner sign-off and repository branch-protection or variable
changes; they do not require workflow edits:

1. Add `Frontend Typecheck` to the required status checks now. It is green, and
   the historical 92-error budget has been paid down.
2. After one clean week, add the four `Python Sidecar Tests (...)` checks to the
   required status checks.
3. Enable the backend coverage gate with the repository variable
   `CI_ENFORCE_TEST_GATE=true`. Set the `COVERAGE_*_MIN` floors slightly below
   the totals in the current coverage-summary artifact so coverage can only
   ratchet upward.

Known follow-ups are deliberately not gated here: the frontend strict-mode /
ES2020 tsconfig ratchet and enforced coverage for the frontend API boundary.

Module-scope eager ioredis clients in `backend/src/workers/index.ts` and
`backend/src/workers/processors/discoverProcessor.ts` remain test-leak
candidates. They stay outside this change and are covered by the
backend-reliability slice's module-load side-effect work.

AWM repo-contract checks:

- `AGENTS.md`
- `.awm/awm-rules.yaml`
- `.awm/awm-tests.yaml`
- `.awm/awm-workflows.yaml`
- `scripts/awm-cross-review.sh`
- `scripts/awm-feature-plan-validate.py`

Promoted AWM verify quality gates:

- `bash scripts/awm-cross-review.sh --help` (when the AWM review gate surface changes)
- `python3 scripts/test_awm_cross_review.py` (when the AWM review gate flag semantics change)
- `bash scripts/awm-backend-targeted-verify.sh --help` (when the targeted backend verify surface changes)
- `npm --prefix frontend run lint`
- `npm --prefix frontend run build`
- `npm --prefix frontend run test:coverage`
- `./scripts/helm-chart-render-check.sh`

Recommended local AWM validation:

```bash
awm verify --project soundspan --phase review --file-changed <path>
awm health --project soundspan --include-details
```

Backend note:

- `awm verify` now keeps backend validation receipt-scoped and targeted via `scripts/awm-backend-targeted-verify.sh`.
- Full backend `build` and `test:coverage` are promoted by `awm review --run` before completion when the active receipt includes backend or `packages/media-metadata-contract/` changes.
- The runnable review gate stays provider-aware through `.awm/awm-workflows.yaml` `run.argv`, and `scripts/awm-cross-review.sh --yolo` is the shared high-trust shortcut: Codex gets native `--yolo`, while Claude maps it to `--dangerously-skip-permissions`.
- `scripts/awm-cross-review.sh` now embeds an untrimmed scoped review packet, including the workflow context, unified diff, and changed-file snapshots, directly into the nested reviewer prompt so the default zero-tool review packet stays self-contained.

When the active receipt matches a repo-defined review gate in `.awm/awm-workflows.yaml`, run this before `awm done`:

```bash
awm review --run --project soundspan --receipt-id <receipt-id>
```

When the active plan is a repo-local feature plan, keep the plan itself in the AWM `kind=feature` / `kind=feature_stream` schema described in `docs/AWM_FEATURE_PLANS.md`, then run `awm verify` with the active receipt and changed files so the validator is selected:

```bash
awm verify --project soundspan --receipt-id <receipt-id> --phase review --file-changed backend/src/routes/social.ts
```

That verify check executes `scripts/awm-feature-plan-validate.py` with the active receipt and plan context before completion.

Examples:

```bash
awm verify --project soundspan --phase review --file-changed backend/src/routes/social.ts
awm verify --project soundspan --phase review --file-changed frontend/app/page.tsx
awm verify --project soundspan --phase review --file-changed charts/soundspan/Chart.yaml
```

Release helpers remain maintainer-invoked workflows outside `awm verify`; use `scripts/release/*.mjs` when you are preparing an actual release rather than validating ordinary code changes.

## Sidecar Test Standard

Python sidecar `pytest` suites exist for all four sidecars:

- `services/audio-analyzer/tests/`
- `services/vibe-provider-dclap/tests/`
- `services/tidal-downloader/tests/`
- `services/ytmusic-streamer/tests/`

Counts drift; see CI output for current totals.

All four sidecars have a `requirements-test.txt` manifest and run in CI through
the `Python Sidecar Tests` matrix job. Run each sidecar suite in a separate
`pytest` invocation because test module basenames collide across sidecars.

Use this structure consistently when adding sidecar tests:

- `services/<service-name>/tests/`
- files named `test_*.py`
- `pytest` as the default framework
- deterministic tests with external calls mocked/stubbed

This keeps sidecars aligned with framework-native best practice and discoverable test layout.
