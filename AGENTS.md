# AGENTS.md

Repository contract for soundspan.

## Quick Start

1. Read this file for repo rules and conventions.
2. See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test, and PR workflow.
3. If your agent runtime provides ACM, see [.acm/AGENTS-ACM.md](.acm/AGENTS-ACM.md) for the enhanced workflow.  If you are unaware or unsure of what ACM is, do not read the file.
4. If using Claude, also read [CLAUDE.md](CLAUDE.md).

## Source Of Truth

- Follow this file first.
- `CLAUDE.md` and `.claude/acm-broker/**` are tool-specific companions. If they disagree with this file, this file wins.

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
- **Storage:** SQLite at `.acm/context.db` by default. Configure `ACM_PG_DSN` for multi-agent coordination.

## Local Setup & Pre-PR Verification

There is **no root install** — `backend/`, `frontend/`, and `packages/media-metadata-contract/` are each installed and built on their own. A PR is gated by the CI checks in the table below; reproduce all of them locally before pushing.

### Prerequisites

- **Node.js ≥ 20.9** — the frontend is Next.js 16 and will not build on older Node (Node 18 fails with `Node.js version ">=20.9.0" is required`). CI uses Node **20** for the backend job and Node **24** for the frontend job. Match ≥ 20.9 locally.
- **npm 9+** — each package commits its own lockfile; use `npm ci` for reproducible installs.
- **Python 3.11+** — only when changing the `services/**` sidecars.

### First-time setup (from the repo root, in this order)

```bash
# 1. Build the shared contract FIRST. The backend depends on it via a `file:`
#    path, which npm COPIES (not symlinks) at install time — so its dist/ must
#    exist before you install the backend, or the copy will lack it.
npm --prefix packages/media-metadata-contract run build

# 2. Install the apps (their copy of the contract now includes dist/).
npm --prefix backend install
npm --prefix frontend install
```

> Gotcha: if `npm --prefix backend test` reports `Cannot find module '@soundspan/media-metadata-contract'`, the backend was installed before the contract's `dist/` existed. Rebuild it (`npm --prefix packages/media-metadata-contract run build`) and re-run `npm --prefix backend install`.

### Reproduce the CI gates locally (run before every PR)

| CI check (`quality-visibility.yml` / `pr-checks.yml`) | Local command | Catches |
| --- | --- | --- |
| Backend Tests + Coverage | `npm --prefix backend run test:coverage` | backend Jest unit/runtime tests + coverage |
| Frontend Quality Visibility | `npm --prefix frontend run lint` **and** `npm --prefix frontend run build` **and** `npm --prefix frontend run test:coverage` | ESLint, **TypeScript type-check (the `build` step)**, targeted unit coverage |
| Helm Chart Visibility | `./scripts/helm-chart-render-check.sh` | chart lint + render assertions |
| ACM Health | `acm health --project soundspan --include-details` | repo contract / receipts |

Notes:

- **The frontend `npm run build` is the type-check gate.** `next build` runs `tsc` over the build graph (`app/`, `lib/`, `components/`, `hooks/`, `features/`). `npm run lint` (ESLint) and the `node --test`/`tsx` unit runners transpile without type-checking, so they will **not** catch a type error — `build` is what fails CI for one. Always run `build` (needs Node ≥ 20.9) before pushing.
- **RAM:** per the targeted-testing rule above, iterate with `npm --prefix backend test -- <file>`; run the full `test:coverage` once before opening the PR.
- **No Node ≥ 20.9 handy?** At minimum type-check the frontend directly: `(cd frontend && npx tsc --noEmit -p tsconfig.json)`. Only errors under `app/`, `lib/`, `components/`, `hooks/`, `features/` gate the build — `next build` does not type-check standalone `tests/**` files, which may carry pre-existing fixture type-noise.

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
