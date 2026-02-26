# Contributing to soundspan

First off, thanks for taking the time to contribute! 🎉

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Set up the development environment (see README.md)
4. Create a new branch from `main` for your changes

## Branch Strategy

All development happens on the `main` branch:

-   **All PRs should target `main`**
-   Every push to `main` triggers a nightly Docker build
-   Stable releases are created via version tags

## Versioning Notes

-   Current development target: **`Unreleased`**
-   Use `nightly` images for testing unreleased features
-   Keep docs current with behavior changes (update `README.md` and `CHANGELOG.md` in the same PR when applicable)

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
- Frontend automated tests: Playwright under `frontend/tests/e2e/`
- Backend manual diagnostics (not Jest): `backend/scripts/manual-tests/`
- Python sidecars: `tests/` scaffolds exist under `services/audio-analyzer/tests/` and `services/audio-analyzer-clap/tests/`; add `pytest` cases there

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
npm --prefix frontend run build
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

## CI Quality Visibility (Non-Blocking by Default)

This repo now includes a dedicated **Quality Visibility** workflow:

- Workflow: `.github/workflows/quality-visibility.yml`
- Purpose: give ongoing visibility into tests and coverage without blocking day-to-day development
- Signals:
  - Backend Jest test run + coverage summary + coverage artifact upload
  - Frontend lint/build quality checks + E2E spec inventory summary

### Backend coverage artifacts

Each run uploads a `backend-coverage-*` artifact containing:

- `coverage/lcov.info`
- `coverage/coverage-summary.json`
- `coverage/jest-results.json`
- generated markdown summary (`coverage/coverage-summary.md`)

The workflow summary includes:

- total statement/branch/function/line coverage
- test suite and test counts
- lowest-coverage files
- zero-percent coverage file list

### Current mode vs future gate mode

By default this workflow is **non-blocking**.

You can switch to stricter behavior with repository variables:

- `CI_NON_BLOCKING_TEST_VISIBILITY=false` to make job failures blocking
- `CI_ENFORCE_TEST_GATE=true` to enforce numeric coverage thresholds
- Optional threshold vars:
  - `COVERAGE_LINE_MIN`
  - `COVERAGE_BRANCH_MIN`
  - `COVERAGE_FUNCTION_MIN`
  - `COVERAGE_STATEMENT_MIN`

Recommended rollout:

1. Keep visibility-only mode while stabilizing coverage.
2. Set thresholds gradually.
3. Make visibility workflow blocking.
4. Add required status checks in branch protection for release branches/tags.

## Policy as Code (Fail-Fast Governance)

Agent/process governance is validated by executable checks, not prose alone.

- Policy manifest: `.agents-config/policies/agent-governance.json`
- Runner: `.agents-config/scripts/enforce-agent-policies.mjs`
- PR gate: `.github/workflows/pr-checks.yml` (`policy-as-code` job)

Run locally before pushing:

```bash
npm run policy:check
```

## Pull Request Process

1. **Target the `main` branch**
2. Fill out the PR template completely
3. Ensure the Docker build check passes
4. Include docs updates in `CHANGELOG.md` and `README.md` when behavior is user-facing
5. Wait for review - we'll provide feedback or approve

## Questions?

Open a Discussion thread for questions that aren't bugs or feature requests.

Thanks for contributing!
