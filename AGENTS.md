# AGENTS.md

Repository contract for soundspan.

## Quick Start

1. Read this file for repo rules and conventions.
2. See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test, and PR workflow.
3. If your agent runtime provides AWM, see [.awm/AGENTS-AWM.md](.awm/AGENTS-AWM.md) for the enhanced workflow.  If you are unaware or unsure of what AWM is, do not read the file.
4. If using Claude, also read [CLAUDE.md](CLAUDE.md).

## Source Of Truth

- Follow this file first.
- `CLAUDE.md` and `.claude/awm-broker/**` are tool-specific companions. If they disagree with this file, this file wins.

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
- **Database access:** All DB access through Prisma. No raw SQL.
- **Logging helpers:** Use shared logging helpers in runtime code:
  - frontend: `frontend/lib/logger.ts`
  - backend: `backend/src/utils/logger.ts`
  - python sidecars: `services/common/logging_utils.py`
- **Changelog:** Keep `CHANGELOG.md` updated for user-visible or behavior-changing work.
- **Documentation coverage:** Exported TypeScript symbols, runtime Python modules, and implemented OpenAPI routes should remain fully documented when touched.
- **Storage:** SQLite at `.awm/context.db` by default. Configure `AWM_PG_DSN` for multi-agent coordination.

## Local Setup & Pre-PR Verification

There is **no root install** — `backend/`, `frontend/`, and `packages/media-metadata-contract/` are each installed and built on their own. A PR is gated by the CI checks in the table below; reproduce all of them locally before pushing.

### Prerequisites

- **Node.js ≥ 24** — the custom frontend proxy requires Node 24 and every Node-based image and CI job runs Node 24. Match the `.nvmrc` locally.
- **npm 9+** — each package commits its own lockfile; use `npm ci` for reproducible installs.
- **Python 3.11+** — only when changing the `services/**` sidecars.

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

One command reproduces every CI gate: **`npm run verify`** (from the repo root). Per-gate equivalents:

| CI check (`quality-visibility.yml`) | Local command | Catches |
| --- | --- | --- |
| Backend Tests + Coverage | `npm run verify:backend` (= `npm --prefix backend run test:coverage`) | backend Jest unit/runtime tests + coverage |
| Frontend Quality Visibility + Typecheck | `npm run verify:frontend` (= frontend `lint` + `build` + `test:coverage` + `test:component` + `typecheck`) | ESLint, Next build/type-check, targeted unit coverage, component tests, and standalone source/test TypeScript checking |
| Python Sidecar Tests (matrix) | `npm run verify:python` (requires Python 3.11+ with each sidecar's `requirements-test.txt` installed) | pytest suites for the four `services/*` sidecars |
| Helm Chart Visibility | `npm run verify:helm` (= `./scripts/helm-chart-render-check.sh`) | chart lint + render assertions |

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
