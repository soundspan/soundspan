# AGENT_CONTEXT.md

Human-readable project/product/architecture context for LLM agents in this repository.

## Project Overview

soundspan is a self-hosted music server with streaming integration. Users manage a local music library and can fill gaps with streams from TIDAL and YouTube Music. The app also supports podcasts, audiobooks, vibe-based search (CLAP embeddings), and programmatic playlist generation.

**License:** GPL-3.0  
**Repository:** `soundspan/soundspan`

Canonical machine-readable context map: `docs/CONTEXT_INDEX.json`

## Architecture

```
Browser → Frontend (Next.js :3030) → Backend (Express.js :3006) → PostgreSQL + Redis
                                         ├── YT Music Streamer (FastAPI :8586)
                                         ├── TIDAL Sidecar (FastAPI :8585)
                                         ├── Audio Analyzer (MusiCNN)
                                         └── Audio Analyzer CLAP
```

- **Frontend** and **Backend** are the two primary workspaces.
- **Sidecars** (YT Music, TIDAL) are Python FastAPI services — the backend proxies requests to them. They never connect directly to the database.
- **Audio analyzers** are optional GPU-accelerated services that communicate via Redis job queues.

## Tech Stack

### Backend (`/backend`)

| Concern | Technology |
|---|---|
| Runtime | Node.js with TypeScript (`tsx` for dev, `tsc` for prod) |
| Framework | Express.js |
| ORM | Prisma (`/backend/prisma/schema.prisma`) |
| Database | PostgreSQL with pgvector extension |
| Cache / Queues | Redis + Bull |
| Auth | JWT (access + refresh tokens), express-session, bcrypt |
| Audio probing | `music-metadata` (dynamic import, skip covers) |
| Transcoding | ffmpeg via `fluent-ffmpeg` |
| Validation | Zod |
| API docs | Swagger (swagger-jsdoc + swagger-ui-express) |
| Testing | Jest + ts-jest |
| Scheduled tasks | node-cron |

**tsconfig:** `target: ES2020`, `module: commonjs`, `strict: true`

### Frontend (`/frontend`)

| Concern | Technology |
|---|---|
| Framework | Next.js (App Router) — port 3030 |
| Language | TypeScript (`strict: false`) |
| Styling | Tailwind CSS |
| State / Queries | React Query (`@tanstack/react-query`) |
| Audio playback | Howler.js via custom engine (`/frontend/lib/howler-engine.ts`) |
| Icons | Lucide React |
| Animations | Framer Motion |
| Toasts | Sonner |
| Virtualization | react-virtuoso |
| E2E testing | Playwright |
| Path alias | `@/*` maps to the frontend root |

### Sidecar Services

| Service | Language | Framework | Port |
|---|---|---|---|
| YT Music Streamer | Python | FastAPI | 8586 |
| TIDAL Sidecar | Python | FastAPI | 8585 |
| Audio Analyzer | Python | — | — |
| Audio Analyzer CLAP | Python | — | — |

## Project Structure

```
/
├── backend/
│   ├── prisma/              # Schema + migrations
│   ├── src/
│   │   ├── config.ts        # Central config (env vars, defaults)
│   │   ├── index.ts         # Express app entry point
│   │   ├── routes/          # Express route handlers (one file per domain)
│   │   ├── services/        # Business logic (one file per domain)
│   │   ├── middleware/       # Auth, rate limiting, error handling
│   │   ├── jobs/            # Bull queue job processors
│   │   ├── workers/         # Background worker processes
│   │   ├── utils/           # Shared helpers
│   │   └── types/           # TypeScript type definitions
│   ├── scripts/             # One-off CLI scripts (backfills, seed data)
│   └── seeds/               # Database seeders
├── frontend/
│   ├── app/                 # Next.js App Router pages
│   │   ├── api/             # API proxy routes (server-side)
│   │   └── [domain]/        # Page routes (album/, artist/, search/, etc.)
│   ├── components/
│   │   ├── player/          # MiniPlayer, FullPlayer, HowlerAudioElement
│   │   ├── layout/          # TopBar, Sidebar, navigation
│   │   ├── ui/              # Reusable UI components (badges, buttons, etc.)
│   │   ├── providers/       # React context providers
│   │   └── activity/        # Activity panel components
│   ├── features/            # Domain-specific components + hooks + types
│   │   ├── album/
│   │   ├── artist/
│   │   ├── library/
│   │   ├── search/
│   │   ├── settings/
│   │   └── discover/
│   ├── hooks/               # Shared custom hooks
│   ├── lib/                 # Core libraries (api client, audio engine, contexts)
│   └── utils/               # Formatting, helpers
├── services/
│   ├── audio-analyzer/      # MusiCNN-based audio analysis
│   └── audio-analyzer-clap/ # CLAP embedding generation
├── docker-compose.yml       # Primary compose file
├── docker-compose.local.yml # Local host-run dependencies (+1 ports)
├── docker-compose.aio.yml   # All-in-one deployment
└── docker-compose.services.yml  # Optional external Lidarr service
```

## Key Conventions

### Backend

- **Route files** live in `backend/src/routes/` — one per domain (e.g., `library.ts`, `search.ts`, `artists.ts`). Routes are Express routers mounted in `index.ts`.
- **Service files** live in `backend/src/services/` — business logic extracted from routes.
- **Prisma** is the sole database access layer. Always use `prisma` client methods. Raw SQL is acceptable only for full-text search (`tsvector`/`tsquery`) and pgvector operations.
- **Database migrations** use `prisma migrate dev` for development and `prisma migrate deploy` for production. Never edit migration files after they've been committed.
- **Auth middleware** uses JWT. Most routes require `requireAuth` middleware. Admin routes additionally use role checks.
- **Redis caching** uses key prefixes by domain (e.g., `search:library:`, `stream:info:`). Always set a TTL.
- **Error handling:** Routes should catch errors and return appropriate HTTP status codes with `{ error: string }` JSON bodies.
- **Environment variables** are read through `backend/src/config.ts` — never read `process.env` directly in route/service files.

### Frontend

- **API client** is centralized in `frontend/lib/api.ts`. All backend calls go through this module. Never use `fetch` directly in components.
- **React Query** is the data-fetching layer. Query hooks live in `frontend/hooks/useQueries.ts` or domain-specific `hooks/` folders under `features/`.
- **Path alias:** Use `@/` for imports (e.g., `@/lib/api`, `@/components/ui/Button`).
- **Page components** live in `frontend/app/[route]/page.tsx` (Next.js App Router convention).
- **Feature modules** in `frontend/features/[domain]/` contain domain-specific components, hooks, and types together.
- **Shared hooks** in `frontend/hooks/` are used across multiple features.
- **Styling:** Tailwind utility classes only. No CSS modules or styled-components. Use `clsx` or `tailwind-merge` for conditional classes.
- **Icons:** Use Lucide React (`lucide-react`). Import individual icons.
- **Toasts:** Use Sonner's `toast` function for user notifications.
- **Audio playback** is managed through context providers in `frontend/lib/audio-*-context.tsx`. The `HowlerAudioElement` component wraps the Howler.js engine.

### General

- **TypeScript everywhere.** Backend uses strict mode; frontend does not, but still use proper types.
- **No default exports** in library/utility files. Components use default exports only for Next.js pages.
- **Prefer shared helpers/utilities.** Before adding bespoke logic, look for an existing helper/service/hook. If logic is duplicated (or likely to be reused) across 2+ call sites, extract/extend a common helper and test it.
- **Commit messages** follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `perf:`, `refactor:`, `test:`.
- **Branch strategy:** All PRs target `main`. Feature branches use `feature/[name]`.
- **Docker:** The primary deployment method. All components have individual Dockerfiles and are orchestrated via docker-compose.
- **Docker lock-step policy:** If any individual image Dockerfile or image build dependency is changed (for example `backend/Dockerfile`, `frontend/Dockerfile`, `services/*/Dockerfile`, related `requirements.txt`, `package*.json`, or image build workflow wiring), update the AIO root `Dockerfile` and relevant AIO workflow/docs in the same change set, or explicitly document why parity is intentionally not required.

### Engineering Best Practices (Default)

- Keep changes small and cohesive: one concern per change set where practical.
- Prefer composition over copy-paste: centralize shared behavior in helpers/services/hooks with clear names.
- Make contracts explicit: type API inputs/outputs, validate boundaries, and avoid ambiguous return shapes.
- Design for retries and restarts: background jobs, queue handlers, and scheduled tasks must be idempotent.
- Add bounded resilience for IO: use explicit timeouts, bounded retries, and jitter/backoff for transient failures.
- Fail clearly and safely: return actionable errors to operators/users, avoid swallowing root causes, and never leak secrets/tokens in logs.
- Preserve compatibility by default: treat existing API/UI behavior as stable unless a change is explicitly intended and documented.
- Keep observability practical: log with operation context/correlation IDs and include enough detail to debug production failures.
- Protect performance hot paths: avoid N+1 DB patterns, expensive per-item loops when batching is possible, and unbounded cache growth.
- Keep tests deterministic: avoid timing flakiness, external-network dependencies in unit tests, and non-deterministic assertions.

## Reuse and Consolidation Atlas

Use this section as the first-stop index for shared patterns and consolidation opportunities before adding new code.

### Core frameworks and entry points (discoverability index)

- Backend runtime/framework: `backend/src/index.ts`, Express route modules under `backend/src/routes/`, services under `backend/src/services/`.
- Backend data layer: Prisma schema at `backend/prisma/schema.prisma`; DB access via `backend/src/utils/db.ts`.
- Backend config and settings: `backend/src/config.ts`, `backend/src/utils/systemSettings.ts`.
- Backend queues/workers: `backend/src/workers/`, `backend/src/jobs/`, queue wiring in `backend/src/workers/queues.ts`.
- Frontend framework/runtime: Next.js App Router under `frontend/app/`.
- Frontend API boundary: `frontend/lib/api.ts` (required client-side API entrypoint).
- Frontend state/query boundary: React Query hooks under `frontend/hooks/` and `frontend/features/*/hooks/`.
- Frontend shared UI/patterns: reusable components under `frontend/components/ui/`, feature components under `frontend/features/`.
- Audio state/control system: `frontend/lib/audio-context.tsx`, related audio contexts in `frontend/lib/audio-*-context.tsx`, player surfaces under `frontend/components/player/`.

### Common reusable patterns (prefer these before creating new ones)

- Backend route pattern: thin route handlers in `backend/src/routes/*` delegating business logic to `backend/src/services/*`.
- Backend error contract: HTTP status + JSON `{ error: string }` from route handlers.
- Backend caching pattern: Redis keys namespaced by domain with explicit TTL.
- Backend validation pattern: Zod schemas for input validation where needed.
- Backend auth pattern: `requireAuth`/`requireAdmin`/`requireAuthOrToken` middleware from `backend/src/middleware/auth.ts`.
- Backend test pattern for route compatibility: route-level handler extraction from router stack in `backend/src/routes/__tests__/*Compat.test.ts`.
- Frontend API consumption pattern: route all backend calls through `frontend/lib/api.ts`; never direct `fetch` in components.
- Frontend data-fetching pattern: React Query for request lifecycle/caching.
- Frontend route/link helper pattern: shared URL/route helpers under `frontend/utils/` (for example artist route param helpers) instead of re-implementing link assembly.
- Frontend notification pattern: Sonner `toast` flows for user feedback.
- Player parity pattern: when changing player behavior, validate all three surfaces:
  - `frontend/components/player/MiniPlayer.tsx`
  - `frontend/components/player/FullPlayer.tsx`
  - `frontend/components/player/HowlerAudioElement.tsx`
- Docs/change-tracking pattern: keep `CHANGELOG.md` and `README.md` synchronized when behavior changes.

### Mandatory consolidation workflow (explicit)

- Before implementing, run a quick reuse scan of nearby modules for existing helpers/hooks/services/components that already solve the problem.
- During planning, include a short `Reuse/Consolidation Check` note listing:
  - existing patterns reused,
  - duplication intentionally kept (with reason),
  - consolidation deferred (with follow-up location).
- While implementing, keep an active eye out for duplicate logic, near-identical types, and repeated API/data-mapping code that can be centralized safely.
- If consolidation is in-scope and low risk, do it in the same change set.
- If consolidation is valuable but out-of-scope/risky, record it explicitly in the active plan/handoff docs as a deferred follow-up opportunity.
- In completion summaries, include a one-line statement of what was reused vs newly introduced so future sessions can discover reuse points quickly.

## Fork Documentation Maintenance

For this repository, documentation updates are part of the definition of done for user-facing or behavior-changing work.

- Always update `CHANGELOG.md` under **`[Unreleased]`** for user-visible or behavior-changing deltas.
- Use `docs/RELEASE_NOTES_TEMPLATE.md` for release notes and GitHub release bodies; generate drafts with `npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>]`.
- In `CHANGELOG.md`, keep the **`Fixed`** section limited to regressions/bugs. Feature additions and behavior upgrades should be documented under **`Added`**/**`Changed`**.
- Keep Helm release references explicit in release notes:
  - chart repo URL: `https://soundspan.github.io/soundspan`
  - chart name: `soundspan`
  - chart reference: `soundspan/soundspan`
- Keep `README.md` aligned with current repository behavior for user-visible features.
- For major implemented features, keep an explicit known-gap ledger and revisit criteria in the canonical feature docs (for example OpenSubsonic gap/non-goal sections in `docs/OPENSUBSONIC_COMPATIBILITY.md`).
- At task start and before phase boundaries, review known-gap ledgers for impacted features and explicitly decide whether any deferred gaps must be promoted to in-scope for the work being planned.
- Maintain canonical continuity in `.agents/CONTINUITY.md` for cross-feature context survivability. This is the first file to read at the start of every assistant turn.
- Canonical shared local agent context root is `/home/joshd/git/soundspan/.agents` (git-ignored).
- Treat `.agents/**` as shared multi-writer context; preserve concurrent updates with semantic merges (no blind overwrite).
- All additional Git worktrees for this repo must be created under `/home/joshd/git/soundspan/.worktrees`.
- In non-primary worktrees, `.agents` must be a symlink to the canonical shared root.
- Keep machine-readable session state current:
  - `.agents/EXECUTION_QUEUE.json` (canonical execution queue + atomic state)
  - `.agents/SESSION_BRIEF.json` (generated from preflight)
- Keep `docs/CONTEXT_INDEX.json` synchronized with policy/documentation contracts; treat it as machine-readable authority, not optional prose.
- Repository index operations contract lives in `docs/REPO_INDEXING.md`; `npm run agent:preflight` now performs index readiness gating (always re-index, then strict verify) before implementation starts.
- Keep queue/continuity/plan boundaries clear:
  - queue: execution plan + state authority
  - continuity: historical decisions/findings/outcomes
  - plan files: human-readable implementation detail tied to queue item IDs
- Multi-agent queue usage:
  - `.agents/EXECUTION_QUEUE.json` is the single scope/queue authority for orchestrator and subagents.
  - `npm run agent:preflight` auto-syncs current/deferred `PLAN.md` tracks into queue items so every active/deferred feature has machine-readable queue representation.
  - `npm run agent:preflight` also backfills archived `PLAN.md` tracks into `.agents/EXECUTION_ARCHIVE_INDEX.json` and feature-sharded archive files.
  - feature-sharded archive files under `.agents/archives/` keep completed task/feature history out of hot context.
  - `.agents/EXECUTION_ARCHIVE_INDEX.json` is the historical lookup index for archived queue records.
  - Archive shards are cold context and should not be loaded in normal startup reads.
  - Queue top-level state/scope contract includes `state`, `feature_id`, `task_id`, `objective`, `updated_at`, `in_scope`, `out_of_scope`, `acceptance_criteria`, `constraints`, `references`, and `open_questions`.
  - Queue items carry idempotent identity via stable `id` + `idempotency_key`, scoped linkage (`feature_id`, `subscope`), and explicit item `state`.
  - Queue item lifecycle metadata includes planning/execution/completion timestamps, claim lease fields (`claimed_by`, `claimed_at`, `lease_expires_at`), retry fields (`attempt_count`, `last_attempt_at`, `last_error`, `retry_after`), and completion evidence (`outputs`, `evidence`, `resolution_summary`).
  - Completed items/features must be moved from hot queue into archive shards as part of completion handling.
  - For context efficiency, agents should read queue slices relevant to the active feature/item (selectors: `id`, `plan_ref`, `owner`, `depends_on`) instead of the entire queue.
  - Preflight includes a stale `.agents/plans/**` reference scan and fails when unresolved links are detected.
- Session preflight command:
  - `npm run agent:preflight`
- Queue lifecycle helper commands:
  - `npm run agent:queue:open -- --id <id> --title <title> --feature-id <feature_id> --plan-ref <ref> --acceptance <criterion>`
  - `npm run agent:queue:start -- --id <id>`
  - `npm run agent:queue:complete -- --id <id> --summary <summary> --output <output> --evidence <evidence>`
  - `npm run agent:queue:close-feature -- --feature-id <feature_id>`
- Plans directory structure:
  - `.agents/plans/current/`: actively executing features only.
  - `.agents/plans/deferred/`: intentionally parked features.
  - `.agents/plans/archived/`: completed features only.
- Simplified per-feature plan architecture (`.agents/plans/current/<feature-name>/`):
  - required: `PLAN.md` (scope, atomic task status, verification notes)
  - optional: `HANDOFF.md`, `PROMPT_HISTORY.md`, `EVIDENCE.md`
  - legacy `*_PLAN.md` and `LLM_SESSION_HANDOFF.md` naming remains valid for historical tracks.
- Move completed feature directories from `.agents/plans/current/` to `.agents/plans/archived/` immediately at closeout, and update any inbound references in the same change.
- All `.agents/plans/**` and `.agents/**` artifacts are local operator/agent context and must not be committed or pushed.
- For small one-off tasks expected to finish in one session, do not create a new feature directory unless continuity risk justifies it; log key outcome/decision deltas in `.agents/CONTINUITY.md` instead.
- Plan-link hygiene is mandatory:
  - At session start, before/after archive moves, and before final handoff, run a stale-link check for `.agents/plans/current/...`, `.agents/plans/deferred/...`, and `.agents/plans/archived/...` references.
  - Fix broken references in the same change where they are discovered.
- Required end-of-feature procedure:
  1. Consolidate docs for the branch (`CHANGELOG.md`, `README.md`) against the merge target.
  2. Ensure `CHANGELOG.md` `Fixed` remains limited to regressions; place feature upgrades under `Added`/`Changed`.
  3. Ensure `.agents/EXECUTION_QUEUE.json` reflects final statuses for completed/deferred/cancelled items in this feature scope.
  4. Archive feature files from `.agents/plans/current/<feature-name>/` into `.agents/plans/archived/<feature-name>/`.
  5. Confirm `.agents/plans/**` and `.agents/**` remain ignored and unstaged.
  6. Run `npm run agent:preflight` to refresh startup artifacts after move/closeout.
  7. Update `AGENTS.md`, `docs/AGENT_RULES.md`, `docs/AGENT_CONTEXT.md`, and `docs/CONTEXT_INDEX.json` if workflow expectations changed.
- Closeout trigger and verification:
  - If the user declares a feature complete, run the end-of-feature procedure in the same session.
  - After closeout, verify no files remain in `.agents/plans/current/<feature-name>/` and report the result.
- Legacy root context files (`*_PLAN.md`, `LLM_SESSION_HANDOFF.md`, `PROMPT_HISTORY.md`) should be migrated into feature directories under `.agents/plans/current/` or `.agents/plans/archived/` when encountered.
- When adding/changing agent process expectations, update `AGENTS.md`, `docs/AGENT_RULES.md`, `.github/policies/agent-governance.json`, and `.github/scripts/enforce-agent-policies.mjs` in the same change set.

## Full-Stack Delivery Gates

For any feature or fix that touches API contracts, auth flows, routing/proxying, external clients, or service-to-service communication, treat implementation as full-stack by default.

- At task start, document the end-to-end request path in active plan/handoff context:
  - client URL/base path
  - reverse proxy/tunnel/ingress behavior (if applicable)
  - frontend runtime rewrite/proxy behavior (if applicable)
  - backend route/middleware/service path
  - downstream dependency path (DB/Redis/sidecar/external API)
- Evaluate behavior across deployment modes that exist in this repo:
  - `docker-compose.aio.yml` (AIO)
  - `docker-compose.yml` (split stack)
  - local dev workflow (`docker-compose.local.yml` + host-run frontend/backend)
- Before marking a feature complete, validate both of these whenever the surface is HTTP/API reachable:
  - backend-direct probe/path
  - frontend-base-URL probe/path
- For every major feature phase, include at least one explicit "full-stack verification checkpoint" task in the active plan file and mark it complete only after recording actual command/output evidence.
- For third-party client compatibility work (for example OpenSubsonic clients), include at least one real-client handshake check or a client-profile emulation check that uses the same URL form users are instructed to configure.
- If any path works only in one deployment mode, do not close as complete until docs and runtime behavior are aligned and the limitation is explicitly documented as a known gap/non-goal.
- In completion summaries, always include a plain-English operator statement of which URL users should configure and in which deployment modes.

### Regression-First Verification Playbook (mandatory)

- Treat every behavior-changing fix as regression-prone until proven otherwise; default to adding a focused regression test in the same change set.
- For API/protocol fixes, verify both success and failure contracts (status code + body/envelope), not only happy paths.
- For stateful queue/worker flows (scan/status/retry/progress), include explicit tests for:
  - active state behavior,
  - inactive/idle state behavior,
  - duplicate-trigger/dedupe behavior.
- For metadata projection/formatting fixes, add assertions on the exact client-consumed fields (for example `genre`, IDs, timestamps), not just object presence.
- For frontend/backend proxy surfaces, always run paired probes:
  - backend-direct path check,
  - frontend-base/proxied path check.
- For compatibility/client bugs discovered in logs or production traces, convert the observed failure into a deterministic automated regression test before closing the issue.
- When a production-only bug is fixed, capture a short root-cause + prevention note in active handoff/prompt history so the same class of defect is not reintroduced.
- Before closing a phase, run a targeted impacted-suite pass (compat tests first) before broad suite runs; record commands and outcomes in the phase completion summary.

## Database

- **ORM:** Prisma with PostgreSQL
- **Schema location:** `backend/prisma/schema.prisma`
- **Key models:** `User`, `UserSettings`, `Artist`, `Album`, `Track`, `Playlist`, `PlaylistTrack`, `Play`, `Podcast`, `PodcastEpisode`, `Audiobook`, `DownloadJob`, `TrackEmbedding` (pgvector)
- **Full-text search:** PostgreSQL `tsvector` columns with GIN indexes on Artist (name), Album (title), Track (title), Podcast, Episode, Audiobook
- **Vector search:** pgvector `vector(512)` for CLAP audio embeddings in `TrackEmbedding`

## Streaming Integration

- **TIDAL** and **YouTube Music** are per-user OAuth integrations stored encrypted in `UserSettings`.
- **Gap-fill:** When viewing an album, unowned tracks (no `filePath`) are matched to available streams.
- **Priority:** TIDAL streams take priority over YouTube Music when both are available.
- **Sidecars** are stateless HTTP services — the backend proxies all requests. They never access PostgreSQL or Redis directly.
- **Quality badges** in the player show real-time audio quality (codec, bitrate, bit depth/sample rate) for all sources.

## Testing

- **Backend:** Jest — `cd backend && npm test`
- **Frontend lint:** ESLint — `cd frontend && npm run lint`
- **E2E:** Playwright — `cd frontend && npm run test:e2e`
- **Pre-deploy:** `cd frontend && npm run test:predeploy`
- **Backend automated test layout:** `backend/src/**/__tests__/` (domain-colocated Jest suites)
- **Backend manual diagnostics layout:** `backend/scripts/manual-tests/` (operator diagnostics outside Jest)
- **Frontend automated test layout:** `frontend/tests/e2e/` (Playwright specs/fixtures)
- **Python sidecar test standard:** `services/<service>/tests/` using `pytest` with `test_*.py` naming when sidecar tests are introduced
- **Mandatory verification default:** Regression prevention tests and contract tests are required for all behavior-changing work unless the user explicitly bypasses this requirement.
- **Coverage bar:** Maintain 100% actual code coverage (lines, branches, functions, statements) unless the user explicitly approves a temporary exception.
- **Coverage target:** Strive for 100% automated test coverage across backend, frontend, workers, and integration surfaces. If full coverage is not feasible for a change, explicitly document the remaining gap and rationale in the completion summary.
- **Development approach:** Default to Test Driven Development (write or update a failing test first, then implement), unless technical constraints make strict TDD impractical. When deviating, document why.
- **True TDD workflow (required by default):** Define the expected outcome with tests first, confirm those tests fail for the current implementation, then adapt production code until the new tests pass.
- **Opportunistic coverage rule:** While implementing any feature/fix, if you encounter adjacent code paths lacking meaningful tests, add focused coverage in the same change set where practical (without broad unrelated refactors).

## Local Testing Bootstrap

- Use `docker-compose.local.yml` for local host-run testing dependencies.
- `docker-compose.local.yml` intentionally does **not** start frontend/backend containers.
- Start local infra:
  - `docker compose -f docker-compose.local.yml up -d postgres redis`
- Optional analyzers (MusicCNN + CLAP):
  - `docker compose -f docker-compose.local.yml --profile audio-analysis up -d`
- Frontend port-collision guard (required): when standing up local frontend services, do not assume `3030` is free. If a local dev instance is already using `3030`, use an alternate port (default `3031`) and keep dependent base URLs aligned.
- Run app services on host with +1 ports:
  - `cd backend && PORT=3007 npm run dev`
  - `cd frontend && PORT=3031 BACKEND_URL=http://127.0.0.1:3007 npm run dev`

## Common Tasks

### Adding a new backend endpoint

1. Add the route handler in the appropriate file under `backend/src/routes/`
2. If complex logic, extract a service in `backend/src/services/`
3. Add types in `backend/src/types/` if needed
4. Add the corresponding API method in `frontend/lib/api.ts`

### Adding a new frontend page

1. Create `frontend/app/[route]/page.tsx`
2. Add feature-specific components in `frontend/features/[domain]/`
3. Add React Query hooks for data fetching
4. Add types in the feature's `types.ts`

### Database schema changes

1. Edit `backend/prisma/schema.prisma`
2. Run `npx prisma migrate dev --name descriptive-name`
3. Update any affected routes/services
4. Update frontend types and API methods

### Adding a new player feature

The player has three views that must stay in sync:
- `frontend/components/player/MiniPlayer.tsx` — mobile + desktop mini player
- `frontend/components/player/FullPlayer.tsx` — desktop bottom bar
- `frontend/components/player/HowlerAudioElement.tsx` — audio engine (no UI)

Audio state is managed through context providers in `frontend/lib/audio-*-context.tsx`.
