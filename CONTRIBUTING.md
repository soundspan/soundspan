# Contributing to soundspan

First off, thanks for taking the time to contribute! 🎉

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Set up the development environment and learn how to reproduce the CI gates locally — see **Local Setup & Pre-PR Verification** in [AGENTS.md](AGENTS.md). (There is no root install; each package builds on its own, and all Node packages require Node ≥ 24.)
4. Create a new branch from `main` for your changes

## Git Hooks

The `.githooks` directory is optional, local-only, gitignored, and not tracked.
Create it manually if you want to maintain a local pre-commit hook, then enable
it with:

```bash
mkdir -p .githooks
git config core.hooksPath .githooks
```

Your local hook can run `awm verify` on staged code files before each commit.

## Branch Strategy

All development happens on the `main` branch:

- **All PRs should target `main`**
- Every push to `main` triggers a nightly Docker build
- Stable releases are created via version tags

## Versioning Notes

- Current development target: **`Unreleased`**
- Use `nightly` images for testing unreleased features
- Keep docs current with behavior changes (update `README.md` and `CHANGELOG.md` in the same PR when applicable)

## Making Contributions

### Bug Fixes

1. Check existing issues to see if the bug has been reported
2. If not, open a bug report issue first
3. Fork, branch, fix, and submit a PR referencing the issue

### Small Enhancements

1. Open a feature request issue to discuss first
2. Keep changes focused and minimal

### Large Features

Please open an issue to discuss before starting work.

## Coding Standards

All contributions must follow the [coding-handbook](https://github.com/BonzTM/coding-handbook): the `typescript/` module for TS/JS and the `python/` module for the `services/**` sidecars. See **Coding Standards & Handbook** in [AGENTS.md](AGENTS.md) for the full policy and precedence — that section is the authority.

## Code Style

### Frontend

The frontend uses ESLint. Before submitting a PR:

```bash
cd frontend
npm run lint
```

### Backend

Follow existing code patterns and TypeScript conventions.

## Testing Frameworks and Structure

Canonical testing guide:

- [`docs/TESTING.md`](docs/TESTING.md)

Summary:

- Backend automated tests: Jest + ts-jest under `backend/src/**/__tests__/`
- Frontend CI-gated tests: unit tests under `frontend/tests/unit/`, component tests under `frontend/tests/component/`, and the standalone typecheck
- Frontend Playwright tests: local/on-demand E2E flows under `frontend/tests/e2e/`
- Backend manual diagnostics (not Jest): `backend/scripts/manual-tests/`
- Python sidecars: all five sidecars have `pytest` suites under `services/*/tests/`

Key backend commands:

```bash
npm --prefix backend test
npm --prefix backend run test:coverage
npm --prefix backend run test:smoke
```

Manual backend diagnostics:

```bash
npm --prefix backend run test:manual:artist-normalization
npm --prefix backend run test:manual:download-dedup
```

Key frontend commands:

```bash
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:unit
npm --prefix frontend run test:component
npm --prefix frontend run test:coverage
npm --prefix frontend run test:e2e
npm --prefix frontend run test:predeploy
```

## Full-Stack Validation Requirements

For features or fixes involving APIs, auth, routing/proxying, or external client integrations:

1. Validate backend-direct behavior (route works when called against backend base URL).
2. Validate frontend-base-URL behavior for the same flow in split deployments.
3. Confirm docs tell users the correct URL to configure for their deployment mode.
4. For client-compatibility work, run at least one real-client handshake test or client-profile emulation that matches documented user setup.
5. If the change touches Subsonic/OpenSubsonic routing, run `cd backend && npm run test:smoke:subsonic-proxy`.

If behavior differs between AIO and split deployments, call it out explicitly in the PR description and docs.

## CI Quality Workflow

The **Quality Visibility** workflow (`.github/workflows/quality-visibility.yml`) runs on pull requests to `main`, on pushes to `main`, `develop`, and `feature/**`, and on manual dispatch. Its jobs fall into two groups.

Enforcement jobs do not set `continue-on-error`. A failure in any of these jobs always fails the workflow run:

- Backend Tests + Coverage: backend Jest tests, the coverage summary and coverage gate, and the coverage artifact upload
- Backend Typecheck
- Frontend Typecheck
- Python Quality
- Enforcement Gates
- Enforcement Gates Build

Visibility jobs set `continue-on-error` unless the repository variable `CI_NON_BLOCKING_TEST_VISIBILITY` is `false`. With the variable unset or set to any other value, their failures do not fail the workflow run:

- Backend PostgreSQL Integration
- Frontend Quality Visibility: frontend lint, build, targeted unit coverage, and component tests
- Python Sidecar Tests: one job for each of the four sidecars
- Helm Chart Visibility

Branch protection, not this workflow, decides which checks must pass before a merge. `AGENTS.md` lists the local command for each job. `docs/TESTING.md` describes what each job checks.

### Backend coverage gate

When the gate is on, the Backend Tests + Coverage job fails if any coverage total is below its floor. These repository variables control the gate:

- `CI_ENFORCE_TEST_GATE`: the gate is on when the variable is unset or `true`. Any other value turns the gate off, and the job only reports coverage.
- `COVERAGE_LINE_MIN`, `COVERAGE_BRANCH_MIN`, `COVERAGE_FUNCTION_MIN`, `COVERAGE_STATEMENT_MIN`: these override the floors that the workflow sets.

### Backend coverage artifacts

Each run uploads `backend/coverage/` as the `backend-coverage-*` artifact. It contains:

- `lcov.info`
- `coverage-summary.json`
- `jest-results.json`
- generated markdown summary (`coverage-summary.md`)

The workflow summary includes:

- total statement/branch/function/line coverage
- test suite and test counts
- lowest-coverage files
- zero-percent coverage file list
- the coverage gate result when the gate is on

## AWM Repo Contract

Repository workflow and verification now run through AWM rather than the legacy agents-template toolchain.

- Repo contract: `AGENTS.md`
- AWM rules: `.awm/awm-rules.yaml`
- AWM tests: `.awm/awm-tests.yaml`
- AWM workflow gates: `.awm/awm-workflows.yaml`
- AWM feature plan schema: `docs/AWM_FEATURE_PLANS.md`

Run locally before pushing:

```bash
awm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .
awm verify --project soundspan --phase review --file-changed <path>
awm health --project soundspan --include-details
```

For backend or `packages/media-metadata-contract/` changes, `awm verify` remains receipt-scoped and targeted. The full backend `build` + `test:coverage` gate is promoted through the runnable review step below before `done`.

When the active receipt matches a repo-defined review gate, also run:

```bash
awm review --run --project soundspan --receipt-id <receipt-id>
```

For net-new feature work, use the repo-local AWM feature plan schema from `docs/AWM_FEATURE_PLANS.md`: root plans use `kind=feature`, split execution streams use `kind=feature_stream`, and `awm verify` enforces the required hierarchy and metadata through `scripts/awm-feature-plan-validate.py`.

## Pull Request Process

1. **Target the `main` branch**
2. Fill out the PR template completely
3. Ensure the Docker build check passes
4. Include docs updates in `CHANGELOG.md` and `README.md` when behavior is user-facing
5. Wait for review - we'll provide feedback or approve

## Questions?

Open a Discussion thread for questions that aren't bugs or feature requests.

Thanks for contributing!
