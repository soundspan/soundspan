# kima-hub v1.6.3 → v1.7.5 adoption candidates for soundspan

## Scope

- Upstream reviewed: `Chevron7Locked/kima-hub` from `v1.6.3` through `v1.7.5`
- Local comparison target: current `soundspan` repo state
- Goal: identify worthwhile items that are either net-new in soundspan or strong enhancement candidates

## Quick take

Most of the high-value upstream work in this range is already present in soundspan or has been surpassed here (background import jobs, playlist import UX, synced lyrics, PWA/service-worker support, Audiobookshelf sync, cover healing, OpenSubsonic work, and broad playback hardening). The best remaining adoption candidates are targeted enhancements rather than wholesale feature ports.

## Classification rubric

- **Net-new**: I found no equivalent capability in soundspan.
- **Enhancement-worthy**: soundspan has adjacent functionality, but the upstream change would improve UX or reliability.
- **Already present / lower priority**: upstream item is already shipped here, or soundspan already has a stronger version.

## Recommended adoption candidates

| Priority | Candidate | Classification | Why it looks worth adopting | soundspan evidence | kima-hub source |
| --- | --- | --- | --- | --- | --- |
| High | Public share links with expiry / usage controls | Enhancement-worthy | kima-hub added token-based share links with expiry and play limits for tracks/albums/playlists. soundspan currently has authenticated playlist sharing via `isPublic`, but playlist routes are still gated by `requireAuthOrToken`, so this is not the same as anonymous, revocable public sharing. | `backend/src/routes/playlists.ts:4-16`, `backend/src/routes/playlists.ts:201`, `frontend/app/playlist/[id]/page.tsx:281-304` | v1.6.1 changelog: share links with token/expiry/play limits — <https://github.com/Chevron7Locked/kima-hub/blob/b67dad2b5cc2c7fd321600a5896f411cdfe4dd99/CHANGELOG.md>
| Medium | Full-text search fallback for stop words like "the" / "a" | Net-new | kima-hub explicitly fixed PostgreSQL FTS misses by falling back to `ILIKE` for stop-word-heavy queries. soundspan's search service appears to rely on `to_tsquery('english', ...)` throughout, which suggests the same failure mode is plausible here. This is a small but high-leverage search-quality fix. | `backend/src/services/search.ts:175-177`, `backend/src/services/search.ts:274-277`, `backend/src/services/search.ts:379-383`, `backend/src/services/search.ts:422-424`, `backend/src/services/search.ts:519-522`, `backend/src/services/search.ts:564-566` | v1.7.4 changelog: FTS stop-word fallback — <https://github.com/Chevron7Locked/kima-hub/blob/b67dad2b5cc2c7fd321600a5896f411cdfe4dd99/CHANGELOG.md#L4-L50> |
| Medium | Richer health payloads (uptime/version emphasis) | Enhancement-worthy | soundspan already exposes health/live/ready endpoints with dependency snapshots, which is good. kima-hub's addition of explicit DB/Redis ping diagnostics plus uptime/version fields would make operator debugging and support snapshots easier, especially in container/Kubernetes environments. | `backend/src/index.ts:275-283`, `backend/src/index.ts:298-329`, `backend/src/routes/openapiSupplement.ts:158-188` | v1.7.4 changelog: enhanced `/health` diagnostics — <https://github.com/Chevron7Locked/kima-hub/blob/b67dad2b5cc2c7fd321600a5896f411cdfe4dd99/CHANGELOG.md#L4-L50> |
| Low-Medium | Operator-triggered cover repair flow after wipes / permission issues | Enhancement-worthy | soundspan already has native cover healing and fallback sources, but I did not find a dedicated operator-facing repair endpoint/workflow equivalent to kima-hub's `/enrichment/repair-covers`. If operators hit storage wipes or permission drift, an explicit repair action could reduce support friction. | `CHANGELOG.md:318`, `backend/src/routes/admin.ts:12-27` | v1.7.3 changelog: cover repair endpoint after 404s / disk issues — <https://github.com/Chevron7Locked/kima-hub/blob/b67dad2b5cc2c7fd321600a5896f411cdfe4dd99/CHANGELOG.md#L52-L60> |

## Suggested implementation order

1. **Public share links** — biggest product-surface gain with the clearest current gap.
2. **FTS stop-word fallback** — small scope, immediate search-quality payoff.
3. **Health payload improvements** — cheap operator-quality improvement.
4. **Explicit cover repair action** — useful operational tooling, but lower urgency because automatic healing already exists.

## Primary upstream references

- Compare view: <https://github.com/Chevron7Locked/kima-hub/compare/v1.6.3...v1.7.5>
- Latest release in reviewed range: <https://github.com/Chevron7Locked/kima-hub/releases/tag/v1.7.5>
- v1.7.0 release: <https://github.com/Chevron7Locked/kima-hub/releases/tag/v1.7.0>
- Upstream changelog snapshot used during review: <https://github.com/Chevron7Locked/kima-hub/blob/b67dad2b5cc2c7fd321600a5896f411cdfe4dd99/CHANGELOG.md>
