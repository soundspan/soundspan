# [2.2.0] Release Notes - 2026-08-16

## Release Summary

A hardening and architecture release: sitewide Content-Security-Policy, Prometheus metrics, HA-correct rate limiting, cookie-session retirement, multi-file audiobook streaming, and the completion of the god-file decomposition with a CI size guardrail.

## Fixed

- Guarded every Python sidecar against Docker interpreter and uv lock-target
  drift, and documented the TensorFlow 2.15 wheel ceiling that keeps the
  Essentia analyzer on Python 3.11. (#494)
- Fixed broken audiobook navigation for books whose sparse or malformed Audiobookshelf chapter markers do not cover the runtime. Valid multi-file durations now produce named parts, while navigation stays hidden when the current single-file stream proxy cannot play those seek targets. (#487)
- Fixed multi-file audiobooks so playback continues past the first file and seeking works across file boundaries. (#495)
- Fixed broken audiobook navigation for books whose sparse or malformed Audiobookshelf chapter markers do not cover the runtime. Valid multi-file durations now produce named parts. (#487)
- Rate limits for security-sensitive endpoints are now enforced across backend
  replicas and survive backend restarts, while requests degrade open on Redis
  outages instead of failing or hanging. (#489)
- Reaped dead-peer HTTP connections with TCP keepalive, made origin keep-alive
  timeouts reverse-proxy safe, and kept Node's zero idle timeout so paused or
  backpressured streams remain unaffected. (#487)
- [Security] Added a per-request nonce Content Security Policy to every Next-served page, including share pages and PWA navigations. The policy starts in report-only mode and can be enforced with `CSP_ENFORCE=true`; optimized SVG responses retain a separate script-blocking sandbox. (#486)
- [Security] Removed the ambient cookie credential surface from backend API
  authentication. (#491)
- [Security] Startup administrator password resets now invalidate outstanding access and
  refresh JWTs and clear the dedicated Subsonic password. (#491)

## Added

- Added a blocking CI source-file-size guardrail with a 3,000-line hard cap,
  a frozen per-file baseline above 1,500 lines, and ratchet-down guidance after
  intentional splits. (#485)
- Added bearer-protected Prometheus metrics for backend HTTP traffic, Bull queue state, process resources, cache results, and federation sync outcomes, plus optional Helm ServiceMonitors and a starter Grafana dashboard. (#490)

## Changed

- Reverted the audio analyzer's essentia-tensorflow pin to dev1389, the newest
  build publishing CPython 3.11 wheels: the dev1438 bump never took effect
  because the Docker image installs from the lock, which correctly stayed on
  dev1389 (dev1438 ships CPython 3.14 wheels only). Dependabot now ignores
  essentia-tensorflow for this image until a cp311 build appears or the
  interpreter ceiling moves.
- Split the YouTube Music streamer sidecar into focused client, search, auth,
  streaming, library, download, browse, lifecycle, model, and runtime modules
  while preserving its `app:app` entrypoint and HTTP behavior. (#485)
- Documented the npm security-override lifecycle, removed obsolete backend and
  frontend overrides, and added an enforcement gate for dangling overrides with
  non-blocking warnings for shed candidates. (#492)
- Restructured the programmatic playlist service into focused generator modules without changing its public contract or mix behavior.
- Restructured the frontend audio playback orchestrator into focused policy modules and concern hooks without changing playback behavior.
- Restructured the Spotify import service into focused matching, preview, lifecycle, playlist-building, job-management, and pending-track modules without changing its public contract or import behavior. (#485)
- Restructured the authentication routes into per-concern modules without changing the `/api/auth` contract.
- Restructured the Subsonic-compatible routes into per-domain modules without changing the `/rest` contract.
- Restructured the Discover Weekly service into focused generation, recommendation, batch-lifecycle, persistence, and cleanup modules without changing its public contract.
- Documentation drift sweep: corrected environment/deployment/API references across the docs tree and refreshed the route, feature, and test indexes.
- Audiobook detail loads now serve validated sections and metadata from the local cache instead of fetching Audiobookshelf live. Sections are computed during sync when expanded Audiobookshelf data is available and backfilled lazily on first view for books synced before this change or from minified library listings. The retained `numChapters` column is superseded and no longer refreshed.

## Removed

- Retired cookie-session authentication and its Redis store. JWT, API-key,
  Subsonic, and federation transports are unchanged; `SESSION_SECRET` remains
  required as the JWT signing fallback. (#491)
- Removed the never-documented `/api/spotify` endpoints, unused Spotify
  credential settings fields, and unused Link Device settings section. Spotify
  playlist imports through the generic `/api/import` flow are unaffected. (#484)

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- No admin/operations updates documented in this release.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.2.0
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments.

## Full Changelog

- Compare changes: [2.1.0...HEAD](https://github.com/soundspan/soundspan/compare/2.1.0...HEAD)
- Full changelog: https://github.com/soundspan/soundspan/blob/HEAD/CHANGELOG.md
