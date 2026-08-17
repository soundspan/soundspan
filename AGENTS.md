# AGENTS.md

Repository contract for soundspan.

## Quick Start

1. Read this file for repo rules and conventions.
2. See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test, and PR workflow.
3. If your agent runtime provides AWM, see [.awm/AGENTS-AWM.md](.awm/AGENTS-AWM.md) for the enhanced workflow. If you are unaware or unsure of what AWM is, do not read the file.
4. If using Claude, also read [CLAUDE.md](CLAUDE.md).

## Source Of Truth

- Follow this file first.
- `CLAUDE.md` and `.claude/awm-broker/**` are tool-specific companions. If they disagree with this file, this file wins.

## Coding Standards & Handbook

- The canonical external engineering-standards baseline for soundspan is the [coding-handbook](https://github.com/BonzTM/coding-handbook) repo (local sibling checkout at `~/git/coding-handbook` when available).
- All contributors and AI agents — including any tools they drive (e.g. codex) — must follow the handbook's language module for the code they touch:
    - `typescript/` for TS/JS (backend, frontend, packages)
    - `python/` for the `services/**` sidecars
- Precedence, so this composes with the rules below:
    1. This AGENTS.md and its repository-specific rules win.
    2. Then the coding-handbook language module.
    3. Then general industry best practice.

    Handbook guidance that conflicts with an explicit rule in this file defers to this file.

- The handbook is the baseline the codebase's enterprise-standards refactor was aligned to; new work must not regress below it.

## Working Rules

- **Read before edit.** Read the full relevant source before making changes. Do not guess at file contents or structure.
- **Smallest safe change.** Make the minimum change that solves the problem. Preserve existing style and conventions. Do not refactor adjacent code, add unsolicited features, or "improve" what wasn't asked for.
- **TDD for executable changes.** For code, schema, or behavior changes, write or update a failing test first, then implement until it passes. Deviations require explicit user approval. Non-executable work (docs, config review, planning, workflow governance) is exempt.
- **No invented requirements.** Do not invent product requirements, compatibility guarantees, or migration behavior when the repo does not define them. Surface the decision and wait for direction.
- **Targeted testing only.** Do not run the full test suite — it maxes out available RAM. Run only the test files and suites relevant to the current changes.
- **Prefer small, reviewable changes** over broad cleanup.

## Repository-Specific Rules

- **API boundary:** Use `frontend/lib/api.ts` as the frontend API boundary. No direct `fetch` calls from components.
- **Backend config:** Read env through `backend/src/config.ts`.
- **Database access:** Prefer Prisma for all DB access. Raw SQL (`$queryRaw`/`$executeRaw`) is permitted **only** for the classes of query Prisma cannot express, namely:
    - **pgvector similarity / ANN** — ivfflat probe tuning and `<=>`/`<->` distance ordering over embedding columns (e.g. `backend/src/utils/annQuery.ts`, `backend/src/services/trackEmbeddings.ts`, `backend/src/services/hybridSimilarity.ts`).
    - **PostgreSQL full-text search** — `tsvector`/`to_tsquery`/`ts_rank` ranking (e.g. `backend/src/services/search.ts`).
    - **Row-level & advisory locking** — `FOR UPDATE SKIP LOCKED` job claiming and `pg_advisory_*` locks (e.g. `backend/src/routes/downloads.ts`, worker claim loops).

    Constraints on any permitted raw SQL: use Prisma tagged-template `$queryRaw`/`$executeRaw` so every value is bound as a parameter; **never** `$queryRawUnsafe`/`$executeRawUnsafe` with interpolated external input (dynamic identifiers must come from code-owned allowlists); back it with a behavioral test against real PostgreSQL, not a source-text assertion (see Testing below). Anything a Prisma query can express — plain filters, counts, existence checks — must use Prisma, not raw SQL.

- **Logging helpers:** Use shared logging helpers in runtime code, and scope logs with `logger.child("Scope")` rather than ad hoc `[bracket-tag]` message prefixes so scope is a structured field:
    - frontend: `frontend/lib/logger.ts`
    - backend: `backend/src/utils/logger.ts`
    - python sidecars: `services/common/logging_utils.py`
- **Naming & placement conventions:** `camelCase` TypeScript source files; one route module per mounted prefix under `backend/src/routes/` (indexed in `backend/src/routes/README.md`); frontend domain modules live under `frontend/features/<domain>/` and are indexed in `frontend/features/README.md`; scheduled/background processors belong in `backend/src/workers/`. Known drift (colocated vs. tree tests, `components/vibe` placement) is documented in the relevant README rather than silently tolerated — follow the README when extending an area.
- **File-size guardrail:** `scripts/ci/check-file-size.mjs` scans non-test production source under `backend/src`, the frontend `app`/`components`/`features`/`hooks`/`lib` trees, Python files under `services`, and each package's `src` tree. Files over 3,000 lines fail unconditionally. Files over 1,500 lines may not be added or grow beyond the frozen per-file baseline; lower or remove baseline entries as files are split. This root contract is the policy home because the gate spans backend, frontend, sidecars, and packages.
- **Changelog:** Keep `CHANGELOG.md` updated for user-visible or behavior-changing work.
- **Testing conventions:** Assert on **behavior**, not source text. The source-scraping `*Contract` suites that `readFileSync` a module and `.toContain(...)` a code snippet (for example, the remaining `clapTextEmbedRecoveryContract.test.ts`) are **deprecated**: do not add new tests of that shape, and replace an existing one with a behavioral test whenever you touch the code it guards.
- **Documentation coverage:** Exported TypeScript symbols, runtime Python modules, and implemented OpenAPI routes should remain fully documented when touched. **Exemption:** the Subsonic-compatible `/rest` surface (`backend/src/routes/subsonic/`, re-exported through `backend/src/routes/subsonic.ts`) is contract-documented in [`docs/OPENSUBSONIC_COMPATIBILITY.md`](docs/OPENSUBSONIC_COMPATIBILITY.md) instead of per-endpoint OpenAPI annotations; keep that document current in lieu of `@openapi` blocks for `/rest`.
- **Storage:** SQLite at `.awm/context.db` by default. Configure `AWM_PG_DSN` for multi-agent coordination.

## Local Setup & Pre-PR Verification

There is **no root install** — `backend/`, `frontend/`, and `packages/media-metadata-contract/` are each installed and built on their own. A PR is gated by the CI checks in the table below; reproduce all of them locally before pushing.

### Prerequisites

- **Node.js ≥ 24** — the custom frontend proxy requires Node 24 and every Node-based image and CI job runs Node 24. Match the `.nvmrc` locally.
- **npm 9+** — each package commits its own lockfile; use `npm ci` for reproducible installs.
- **Python 3.13+** — only when changing the `services/**` sidecars (the tidal-downloader toolchain's `tiddl` dependency requires Python >=3.13; ruff/mypy still check Python 3.11 semantics via `pyproject.toml`).

### First-time setup (from the repo root)

```bash
# One command: installs + builds the shared contract FIRST (the backend
# depends on it via a `file:` path that npm symlinks at install time, so
# its dist/ must exist), then installs both apps.
npm run setup        # npm run setup:ci for lockfile-exact installs

# Node version: `.nvmrc` pins 24 for local dev; `engines` in every
# package declares the same Node 24 floor.
```

Equivalent manual sequence (what `npm run setup` runs):

```bash
npm --prefix packages/media-metadata-contract install
npm --prefix packages/media-metadata-contract run build
npm --prefix backend install
npm --prefix frontend install
```

> Gotcha: if the backend reports `Cannot find module '@soundspan/media-metadata-contract'`, the contract's `dist/` doesn't exist yet (the symlinked package is present but unbuilt). Build it with `npm --prefix packages/media-metadata-contract run build`.

### Reproduce the CI gates locally (run before every PR)

**`npm run verify:ci`** (from the repo root) reproduces every CI gate, including the Python gates (requires Python 3.13+ with each sidecar's `requirements-test.txt` and `services/requirements-quality.txt` installed). When you are not touching `services/**`, **`npm run verify`** runs the Node + Helm subset. Per-gate equivalents:

| CI job (`quality-visibility.yml`) | Blocking?   | Local command                                                                                                   | Catches                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend Tests + Coverage          | Visibility  | `npm run verify:backend`                                                                                        | backend Jest unit/runtime tests + coverage                                                                                                                                                                                                                                                                                  |
| Frontend Quality Visibility       | Visibility  | Non-typecheck part of `npm run verify:frontend`: frontend `lint` + `build` + `test:coverage` + `test:component` | ESLint, Next build, targeted unit coverage, and component tests                                                                                                                                                                                                                                                             |
| Python Sidecar Tests (matrix)     | Visibility  | `npm run verify:python`                                                                                         | pytest suites for the five `services/*` sidecars plus the root AIO image-hardening suite                                                                                                                                                                                                                                    |
| Python Quality                    | Enforcement | `npm run verify:python-quality`                                                                                 | ruff lint, ruff format check, mypy (+ tidal-downloader standalone)                                                                                                                                                                                                                                                          |
| Enforcement Gates                 | Enforcement | `npm run verify:gates`                                                                                          | route-error canonicalization + self-test, source-file-size ratchet + self-test, npm override staleness + self-test, Dockerfile hygiene, infrastructure/release helper tests, frontend hardcoded-hex baseline, OpenAPI route sync, and repo-wide Prettier format check; local `verify:gates` also runs the infrastructure/release helper tests that the CI enforcement job does not currently run |
| Backend Typecheck                 | Visibility  | `npm --prefix backend exec -- tsc --noEmit`                                                                     | backend TypeScript checking                                                                                                                                                                                                                                                                                                 |
| Frontend Typecheck                | Visibility  | `npm --prefix frontend run typecheck` (also part of `verify:frontend`)                                          | complete frontend source/test TypeScript checking                                                                                                                                                                                                                                                                           |
| Helm Chart Visibility             | Visibility  | `npm run verify:helm`                                                                                           | chart lint + render assertions                                                                                                                                                                                                                                                                                              |

Only **Enforcement Gates** and **Python Quality** block a PR on every run; the remaining jobs run as visibility (`continue-on-error`) unless the repo variable `CI_NON_BLOCKING_TEST_VISIBILITY` is set to `false`.

Notes:

- **The frontend has two type-check gates.** `next build` checks the Next build graph (`app/`, `lib/`, `components/`, `hooks/`, `features/`), while `npm run typecheck` checks the complete frontend TypeScript project, including standalone `tests/**` files, without reusing incremental state. `npm run lint` and the `node --test`/`tsx` runners transpile without type-checking.
- **RAM:** per the targeted-testing rule above, iterate with `npm --prefix backend test -- <file>`; run the full `test:coverage` once before opening the PR.
- **No Node ≥ 24 handy?** Type-checking still requires the repository's supported Node/npm toolchain and installed frontend dependencies; use `npm --prefix frontend run typecheck` for the standalone gate.

## Verification Evidence Protocol

- Run the verification command. Read the COMPLETE output. Do not assume success.
- Prefix all evidence claims with `verify:` (e.g., "verify: backend-build exit 0, 0 errors").
- Never use: "should work", "probably fine", "looks correct", "appears to pass".
- Evidence is stale after any subsequent code change. Re-verify after edits.
- If verification fails, fix the issue OR report the failure honestly. Never claim success.

## Debugging Protocol

1. **Investigate**: Read full error output. Reproduce the issue. Trace data flow.
2. **Analyze**: Compare to working code. Identify what changed.
3. **Hypothesize**: Form ONE specific root-cause hypothesis.
4. **Implement**: Apply targeted fix. Verify root cause resolved, not symptoms masked.
5. **Escalate**: If 3 consecutive fix attempts fail, stop. Document what was tried and why each failed. Ask the user before continuing.

## Definition of Done

Before reporting completion, confirm ALL:

- Requested change implemented; behavior explained (what, where, why).
- Verification passed for code/config/schema changes (paste evidence with `verify:` prefix).
- Tests added or updated for behavioral changes.
- `CHANGELOG.md` updated for behavior-visible changes.
- No scope expansion beyond original request.
- Documentation updated for new/changed exports, routes, or schemas.
