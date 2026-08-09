# Backend Routes

Start-here guide for API route handlers in `backend/src/routes`.

## Start Here

1. Mount points and middleware chain: `backend/src/index.ts`.
2. Route runtime tests: `backend/src/routes/__tests__/`.
3. Shared business logic called by routes: `backend/src/services/`.

## Error & Response Conventions (Canonical)

All route error responses use one shape — the single-field JSON envelope:

```json
{ "error": "human-readable message" }
```

Errors raised as an `AppError` additionally carry `code` and `category` (and,
in development only, `details`). Do not invent `{ message }`, `{ detail }`,
`{ success: false }`, or raw-string error bodies. `{ success, ... }` is reserved
for **2xx domain-result** payloads (e.g. a retry that created a job but could not
start the download), never for error responses.

How to write a handler:

1. **Wrap async handlers in `asyncHandler`** (`../middleware/asyncHandler`) so a
   rejected promise is forwarded to the shared `errorHandler`
   (`../middleware/errorHandler`) instead of hanging the request.
2. **Deliberate client errors** (400/401/403/404/409/…) — call
   `sendRouteError(res, status, message)` from `./routeErrorResponse`.
3. **Unexpected/internal failures** — either let the error propagate to the
   shared `errorHandler` (which logs once and returns a generic 500 in
   production, hiding stack/SQL/secret detail), or, when a safe static label is
   preferable, `catch`, `logger.error(...)`, and return
   `sendInternalRouteError(res, "Failed to …")`. Never swallow an error silently
   and never echo raw internal/exception text to the client.
4. **Status mapping** is owned by `errorHandler`: an `AppError.httpStatus` wins;
   otherwise `ErrorCategory` maps RECOVERABLE→400, TRANSIENT→503, FATAL→500.
5. **Request validation** uses `zod` at the trust boundary (see
   `vibeJourneyRequest.ts`), producing a typed value or a 400 `{ error }`.

Reference exemplars: `vibe.ts`, `vibeJourneyRequest.ts`, `notifications.ts`,
`library.ts`.

**Enforcement (ratchet):** `scripts/ci/check-route-error-canon.mjs`
(`npm run check:error-canon`) runs two independent per-file ratchets and fails
if either regresses:

1. **500-literal ratchet** — freezes the current per-file count of ad-hoc
   `res.status(500).json(...)` literals and fails when a route file adds new
   ones.
2. **Raw-error leak ratchet** — freezes the per-file count of raw caught-error
   text echoed into a response body (`error.message` / `error?.message` /
   `error.stack` used as a property value, e.g. `details: error?.message` or
   `error: error.message || "…"`). Echoing raw exception text to clients is an
   OWASP info-disclosure risk; return a static curated message and log the raw
   error server-side instead. `discover.ts`, `enrichment.ts`, and `library.ts`
   are at zero. The remaining routers still carrying the pattern
   (`downloads.ts`, `listenTogether.ts`, `notifications.ts`,
   `playbackState.ts`, `playlists.ts`, `podcasts.ts`) are frozen at their
   current counts and remediated as follow-up.

Both baselines can only DECREASE: when you canonicalize a route, lower its
baseline in that script; new route files start at zero. Full migration of every
route file is intentionally incremental (per touched file), not a big-bang.

## Mounted Route Modules

| Route File | Mounted Prefixes |
| --- | --- |
| `backend/src/routes/analysis.ts` | `/api/analysis` |
| `backend/src/routes/analysisInternal.ts` | `/api/analysis` (machine callbacks, mounted via `analysis.ts` and directly when the flag is off) |
| `backend/src/routes/admin.ts` | `/api/admin` |
| `backend/src/routes/apiKeys.ts` | `/api/api-keys` |
| `backend/src/routes/artists.ts` | `/api/artists` |
| `backend/src/routes/audiobooks.ts` | `/api/audiobooks` |
| `backend/src/routes/auth.ts` | `/api/auth` |
| `backend/src/routes/browse.ts` | `/api/browse` |
| `backend/src/routes/deviceLink.ts` | `/api/device-link` |
| `backend/src/routes/discover.ts` | `/api/discover` |
| `backend/src/routes/downloads.ts` | `/api/downloads` |
| `backend/src/routes/enrichment.ts` | `/api/enrichment` |
| `backend/src/routes/homepage.ts` | `/api/homepage` |
| `backend/src/routes/library.ts` | `/api/library` |
| `backend/src/routes/listeningState.ts` | `/api/listening-state` |
| `backend/src/routes/listenTogether.ts` | `/api/listen-together` |
| `backend/src/routes/lyrics.ts` | `/api/lyrics` |
| `backend/src/routes/mixes.ts` | `/api/mixes` |
| `backend/src/routes/notifications.ts` | `/api/notifications` |
| `backend/src/routes/offline.ts` | `/api/offline` |
| `backend/src/routes/onboarding.ts` | `/api/onboarding` |
| `backend/src/routes/openapiSupplement.ts` | (doc-only: @openapi coverage for index.ts health/readiness and /api/docs.json endpoints; not mounted) |
| `backend/src/routes/playbackState.ts` | `/api/playback-state` |
| `backend/src/routes/playlistImport.ts` | `/api/import` |
| `backend/src/routes/playlists.ts` | `/api/playlists` |
| `backend/src/routes/plays.ts` | `/api/plays` |
| `backend/src/routes/podcasts.ts` | `/api/podcasts` |
| `backend/src/routes/recommendations.ts` | `/api/recommendations` |
| `backend/src/routes/releases.ts` | `/api/releases` |
| `backend/src/routes/routeErrorResponse.ts` | (not found in `backend/src/index.ts` mounts) |
| `backend/src/routes/search.ts` | `/api/search` |
| `backend/src/routes/shareLinks.ts` | `/api/share-links` |
| `backend/src/routes/settings.ts` | `/api/settings` |
| `backend/src/routes/social.ts` | `/api/social` |
| `backend/src/routes/soulseek.ts` | `/api/soulseek` |
| `backend/src/routes/spotify.ts` | `/api/spotify` |
| `backend/src/routes/streaming.ts` | `/api/streaming` |
| `backend/src/routes/subsonic.ts` | `/rest` |
| `backend/src/routes/system.ts` | `/api/system` |
| `backend/src/routes/systemSettings.ts` | `/api/system-settings` |
| `backend/src/routes/tidalStreaming.ts` | `/api/tidal-streaming` |
| `backend/src/routes/trackMappings.ts` | `/api/track-mappings` |
| `backend/src/routes/vibe.ts` | `/api/vibe` |
| `backend/src/routes/webhooks.ts` | `/api/webhooks` |
| `backend/src/routes/youtube.ts` | `/api/youtube` |
| `backend/src/routes/youtubeMusic.ts` | `/api/ytmusic` |

## Feature-Gated Prefixes

Some prefixes are mounted only when their coarse feature flag (see
`config.features` in `backend/src/config.ts`) is enabled; otherwise the prefix
stays rate limited (`apiLimiter`) and returns
`404 {"error":"feature disabled","code":"FEATURE_DISABLED"}`:

- `AUDIO_ANALYSIS_ENABLED`: `/api/analysis`, `/api/vibe`
- `DISCOVERY_ENABLED`: `/api/discover`, `/api/recommendations`
- `AUTO_PLAYLISTS_ENABLED`: `/api/mixes`

Exception: the CLAP analyzer machine callbacks in
`backend/src/routes/analysisInternal.ts` (`/api/analysis/vibe/failure`,
`/api/analysis/vibe/success`) remain mounted even when
`AUDIO_ANALYSIS_ENABLED=false`, so analyzers draining in-flight work can still
report results.

## Conventions

- **One module per mounted prefix.** Each file here owns a single `/api/*` (or `/rest`) prefix listed above; add a new prefix as a new `camelCase` module and register it in `backend/src/index.ts` and in the table above.
- **Routes orchestrate; services decide.** Keep parsing, validation, authorization decisions, and data access in `backend/src/services/` (and background processors in `backend/src/workers/`); route handlers coordinate and stay within the repository function-size gate.
- **Data access.** Use Prisma. Raw SQL is limited to the pgvector / full-text-search / row-locking exceptions defined in [`AGENTS.md`](../../../AGENTS.md) and must use parameterized tagged templates.
- **`/rest` OpenAPI exemption.** `subsonic.ts` implements the Subsonic-compatible `/rest` surface, which is contract-documented in [`docs/OPENSUBSONIC_COMPATIBILITY.md`](../../../docs/OPENSUBSONIC_COMPATIBILITY.md) rather than per-endpoint `@openapi` annotations (see `AGENTS.md`). Update that document when `/rest` behavior changes.
- **Tests assert behavior.** Prefer runtime tests in `backend/src/routes/__tests__/`; do not add source-scraping `*Contract` tests that `readFileSync` a module and assert on its text (deprecated pattern — see `AGENTS.md`).

## Update Rule

- When adding, removing, or changing endpoints in this directory, update this README if the entrypoint or test-navigation guidance changes and keep impacted route tests current in the same change set.
