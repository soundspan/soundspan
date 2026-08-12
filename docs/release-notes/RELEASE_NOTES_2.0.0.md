# [2.0.0] Release Notes - 2026-08-12

Soundspan 2.0.0 is a security- and reliability-hardening major release: the
consumer-facing result of a systematic, multi-month security review. It tightens
credentials, sessions, authorization, network boundaries, and filesystem access
and bounds more database, sidecar, and background work. The major version reflects
the operator and client actions below; complete the checklist before rollout.

## Before you upgrade — required checklist

- **Set all split-stack secrets explicitly before startup.**
  `docker-compose.yml` now requires `POSTGRES_PASSWORD`, `SESSION_SECRET`,
  `SETTINGS_ENCRYPTION_KEY`, and `INTERNAL_API_SECRET`; published defaults are
  rejected. Generate new application secrets with `openssl rand -base64 32`,
  keep the same `INTERNAL_API_SECRET` on the backend and sidecars, and do not
  reuse the retired `soundspan-internal-secret-change-me` value.
- **Pass split-stack database settings as `POSTGRES_*` components.** Compose
  deployments now build `DATABASE_URL` inside the application and safely
  percent-encode credentials, including passwords with URL-reserved
  characters. An explicit `DATABASE_URL` still takes precedence for custom
  deployments.
- **Strengthen weak custom secrets before starting 2.0.0.** Encryption and
  internal-auth secrets must be at least 32 characters. An operator-supplied
  `JWT_SECRET` must also be at least 32 characters; deployments that omit it
  continue to use the validated `SESSION_SECRET`.
- **Reissue API keys older than 90 days and plan recurring rotation.** Keys now
  expire 90 days after creation or rotation. API-key management, linked-device
  revocation, and MFA setup or changes require a logged-in interactive session;
  an `X-API-Key` client can no longer perform those actions.
- **Reconfigure OpenSubsonic token-auth clients once.** Token authentication
  (`t` + `s`) no longer derives from a reversibly stored account password. Set a
  dedicated per-user Subsonic password through
  `POST /api/auth/subsonic-password`, or switch the client to password auth.
  Changing an account password clears the dedicated Subsonic secret.
- **Set an explicit production CORS policy for cross-origin frontends.** An
  unset `ALLOWED_ORIGINS` now denies cross-origin browser requests in
  production. Same-origin frontend-proxy deployments need no change; otherwise
  set the allowed frontend origins. `CORS_ALLOW_ALL=true` is a temporary legacy
  escape hatch.
- **Configure the Lidarr webhook secret.** `POST /api/webhooks/lidarr` now
  returns 401 when no webhook secret is configured. Use
  `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` only as a temporary compatibility
  escape hatch.
- **Review remote access to Compose PostgreSQL and Redis.** Their host ports now
  bind to `127.0.0.1` instead of all interfaces. Same-host tooling is unchanged;
  remote tooling needs the documented Compose override or, preferably, a
  private authenticated path.
- **Repair frontend volume ownership when needed.** The production frontend
  image now runs as UID/GID 1000. Re-chown existing `.next/cache` or other
  frontend volumes owned by 1001 to 1000, or recreate them. AIO processes also
  run as UID/GID 1000 and require writable bind mounts, although standard AIO
  volume paths are repaired automatically at boot.
- **Review Helm capacity and accelerator settings.** AIO requests/limits now
  default to `2Gi`/`8Gi`; ensure the cluster can place it. Analyzer probes are
  enabled in individual mode. GPU flags now create a real
  `nvidia.com/gpu` limit, so clusters using them need the NVIDIA device plugin
  and any required runtime class.
- **Update scripts for the new authorization gates.** Global enrichment
  failures, shared-library download operations, Spotify import session logs,
  Soulseek-backed retries, Lidarr queue clearing, and library-wide or
  single-item enrichment now require an administrator. Artist discovery and
  preview plus audiobook cover access require authentication. Refresh tokens
  are accepted only by the refresh exchange, not as access credentials.
- **Update custom sidecar clients to the hardened request contracts.** TIDAL
  admin calls now carry credentials in headers; legacy query credentials remain
  temporarily supported. YouTube Music video ids and quality values are
  strictly validated, sidecar and route errors now use the canonical
  `{ "error": ... }` envelope, and OpenSubsonic cover sizes snap to the supported
  allowlist instead of honoring arbitrary dimensions.
- **Verify the music mount before running a library scan.** Scans now remove
  database tracks that are missing from disk regardless of the “Allow library
  deletion” setting. A completely empty mount is protected, but a partially
  mounted or incomplete library can still reconcile missing paths away.

## Playback reliability and telemetry

- Queue auto-advance is fixed across the full track-end path. The native engine
  now accepts the browser's end-of-stream pause, listeners remain stable while
  playback state changes, and a one-shot watchdog recovers a lost end event.
- If a browser blocks the next track in a hidden or unfocused window, bounded
  retries run on a timer and again on visibility or focus. The player also
  preserves the load's autoplay intent, so a successful advance no longer
  pauses itself immediately after the next track starts.
- Server-visible client telemetry now records `load_autoplay_decision`,
  `track_end_*`, and `playback_start_blocked` events. Operators can alert on
  the `autoplay_intent_conflict` tripwire to catch future load/play intent
  regressions.

## Cover art and session UX

- Cover art and segmented-streaming assets no longer return 404 when a cache
  lives in a dot-directory such as `/music/.soundspan`. Cover files are served
  from an explicitly pinned root with stronger containment checks.
- Failed media-server **Test connection** attempts for Audiobookshelf,
  Fanart.tv, Last.fm, Soulseek, Spotify, and TIDAL no longer end the current
  Soundspan session. Upstream credential failures return 502, while the web
  client logs out only for responses carrying the explicit `AUTH_REQUIRED`
  marker. Wrong current-password entries now stay inline instead of being
  mistaken for session expiry.

## Security hardening

- The pre-release CodeQL backlog is fully dispositioned: every alert was fixed
  or recorded with an owned justification and re-evaluation condition.
- Access-token verification is centralized, pins HS256, validates payloads,
  and rejects refresh tokens outside the refresh exchange. TOTP moved from the
  unmaintained `speakeasy` package to `otplib` while preserving existing 2FA
  enrollments.
- Account, 2FA, Subsonic credential, admin queue-dashboard, and playback-state
  synchronization routes now have route-specific rate limits; the playback
  tier remains generous enough for its normal high-frequency cadence.
- Authorization was tightened across API-key and device management, MFA,
  enrichment, shared downloads, import logs, artist discovery, audiobook
  covers, Listen Together group ending, and recovery or retry operations.
- Client-facing failures now use curated messages across backend routes,
  segmented streaming, stored download jobs, and TIDAL/YouTube Music sidecars;
  raw paths, upstream bodies, and exception details remain in server logs.
- Native streams, share-link streams, downloads, cache files, cover-image
  storage, and analyzer or repair paths enforce root containment. Podcast
  audio, remote images, and Audiobookshelf cover access gained DNS-aware SSRF,
  redirect, namespace, and input validation.
- Playlist imports accept only canonical HTTP(S) links, text normalization and
  delimited-content stripping now run in linear time, and audiobook preflight
  handling uses the centralized deny-by-default CORS policy.
- Secret-bearing `.env` writes are atomic and owner-only. YouTube Music OAuth
  files are also mode `0600`, and chart-managed workloads drop Linux
  capabilities, use `RuntimeDefault` seccomp, and do not mount service-account
  tokens.
- Operators can move integration credentials fully into encrypted settings with
  `SECRETS_DB_ONLY=true`. Legacy decrypt fail-closed mode remains opt-in and
  should be enabled only after the secrets-status endpoint reports zero legacy
  rows.

## Observability migration

Update saved searches, dashboards, and alerts that use the renamed player
signals:

| Previous name | 2.0.0 name | Scope |
| --- | --- | --- |
| `player.howler_startup` | `player.engine_startup` | Audio-engine startup |
| `route.client.signal` | `playback.client.signal` | Ingested client signals |
| `[SegmentedStreaming.Trace] client.signal` | `[Playback.Trace] client.signal` | Client trace logs |
| `[SegmentedStreaming][Metric] client.signal` | `[Playback.Metric] client.signal` | Client metric logs |

Manifest, segment, session, and DASH lifecycle traces that are genuinely
specific to segmented streaming keep their existing names.

## Reliability and performance

- Rediscover uses a bounded indexed candidate pool, Subsonic playlist durations
  use one aggregate query, playlist listings paginate with database-side counts,
  and browse or list limits are clamped to prevent full-library work.
- Shared keyed single-flight now coalesces transcode caching, vibe calibration,
  and TIDAL/YouTube Music credential restores. OAuth logout is fenced against
  in-flight restore or refresh work so cleared credentials stay cleared.
- Sidecar network and filesystem work moves off async event loops, gains bounded
  deadlines and cache sizes, and releases upstream connections on errors or
  client disconnects. Stream and browse caches are lock-guarded against
  concurrent mutation.
- Analyzer batch timeouts preserve completed results, requeue work that never
  started without consuming retries, and retry genuinely in-flight failures.
  CLAP workers are supervised, resources close deterministically, and model
  unload cannot race inference.
- Import jobs now run durably on the worker queue with recovery and
  deduplication, while queue cleaning is claimed by workers instead of repeated
  by every API replica.
- Token refresh, visibility-aware polling, and Listen Together recovery
  received focused fixes so long sessions, hidden tabs, large queues, and
  cross-replica ready gates recover more predictably.

## Quality and maintainability

- The frontend now compiles in TypeScript strict mode. Python sidecars run
  mypy in strict mode, with measured and documented exceptions where the
  pinned analyzer stack requires them.
- The large library router is decomposed into named per-resource routers and
  typed helper modules without changing its mounted URLs or behavior.
- Backend environment reads continue moving behind the typed configuration
  boundary; its temporary allowlist shrank from 39 production files to 19.
- Component network calls now go through the shared frontend API layer, with a
  ratchet that prevents new direct `fetch()` calls in app, component, and
  feature modules.

## Platform and deployment

- The standalone MusiCNN analyzer moves from Ubuntu 20.04/Python 3.8 to
  Python 3.11 with the same TensorFlow 2.15.1 and Essentia model stack as AIO.
  The supported Essentia artifact matrix and deterministic inference baseline
  are documented without changing model behavior.
- AIO now persists operator-supplied master secrets, secures embedded PostgreSQL
  on loopback with SCRAM-SHA-256, checks both frontend and backend readiness,
  and runs application processes under the fixed `soundspan` UID/GID 1000.
- Analyzer health probes and GPU scheduling are now effective in the Helm chart,
  while PostgreSQL credentials are safely encoded and application images can be
  pinned by digest.
- API-key settings show each key's expiry date and flag keys that are expired or
  expiring soon, making the 90-day rotation policy visible before clients stop
  authenticating.
- Base images and build inputs are digest- or hash-pinned, Python quality and
  sidecar test lanes are part of CI, and the remaining mutable GitHub Actions
  and scanner image references are pinned.
- CodeQL analysis and the release quality/enforcement gates now run as blocking
  required checks rather than visibility-only signals.

## Also in this release

- The player seek slider, modal and confirmation flows, queue reordering, track
  rows, and Vibe map gained stronger keyboard and screen-reader behavior.
- Playback context and progress subscriptions were split so status-only screens
  and the audio orchestrator avoid clock-driven rerenders. Visibility-aware
  polling also stops unnecessary work in hidden tabs.
- Settings actions use consistent in-app confirmation dialogs, theme colors have
  accessible contrast and focus guards.

## Deployment and distribution

- Docker images: `ghcr.io/soundspan/*:2.0.0`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.0.0
```

The chart is published only after all eight `2.0.0` image tags are available.

## Known issues and compatibility notes

- The TensorFlow 2.15 dependency line shared by the analyzer and AIO images
  keeps its documented `pip-audit` exceptions (Keras 2.15.0 and protobuf
  4.25.9); their removal conditions live in `docs/SECURITY.md`, and new
  advisory IDs still fail CI.
- Standard Docker and Helm upgrades preserve existing data and apply Prisma
  migrations automatically. Custom deployments remain responsible for database
  backups, migration ordering, and consistent sidecar secrets.

## Full changelog

- Compare changes: [1.9.0...2.0.0](https://github.com/soundspan/soundspan/compare/1.9.0...2.0.0)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.0.0/CHANGELOG.md)
