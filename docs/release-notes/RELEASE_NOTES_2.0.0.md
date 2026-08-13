# [2.0.0] Release Notes - 2026-08-12

Soundspan 2.0.0 is a major release. It makes security and reliability better
across the full application. It is the result of a systematic security review
over several months. The release makes credentials, sessions, authorization,
network boundaries, and filesystem access more strict. It also puts limits on
more database, sidecar, and background work.

This is a major version because you must do the steps below. Do all the steps
before you start the new version.

## Before you upgrade — required steps

Do these steps in order. Each step tells you what to do and why.

### 1. Set all required secrets

`docker-compose.yml` now requires these values before startup:

- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `SETTINGS_ENCRYPTION_KEY`
- `INTERNAL_API_SECRET`

The application rejects the old published default values.

1. Make each new secret with `openssl rand -base64 32`.
2. Set the same `INTERNAL_API_SECRET` on the backend and on all sidecars.
3. Do not use the retired value `soundspan-internal-secret-change-me`.

### 2. Give the database settings as components

Compose deployments now build `DATABASE_URL` inside the application.

1. Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   and `POSTGRES_DB`.
2. The application percent-encodes the credentials. Passwords with special URL
   characters are now safe.
3. If you set an explicit `DATABASE_URL`, the application uses it without
   change. This is correct for custom deployments.

### 3. Make weak custom secrets strong

1. Make sure `SETTINGS_ENCRYPTION_KEY` and `INTERNAL_API_SECRET` have 32
   characters or more.
2. If you set `JWT_SECRET`, make sure it has 32 characters or more.
3. If you do not set `JWT_SECRET`, the application uses the validated
   `SESSION_SECRET`. No action is necessary.

### 4. Replace old API keys and plan rotation

API keys now expire 90 days after you create them or rotate them.

1. Replace each API key that is more than 90 days old.
2. Plan a recurring rotation for all API keys.
3. Log in to a browser session to manage API keys, linked devices, or MFA.
   A client with only an `X-API-Key` header cannot do these actions now.

The settings page shows the expiry date of each key. It also shows a flag when
a key is expired or will expire soon.

### 5. Configure OpenSubsonic clients one time

Token authentication (`t` + `s`) does not use your account password now.

1. Set a dedicated per-user Subsonic password with
   `POST /api/auth/subsonic-password`. As an alternative, set the client to
   password authentication.
2. Note: when you change your account password, the application clears the
   dedicated Subsonic password. Set it again after a password change.

### 6. Set the CORS policy for cross-origin frontends

In production, an unset `ALLOWED_ORIGINS` now denies cross-origin browser
requests.

1. If your frontend uses the same origin as the backend proxy, no action is
   necessary.
2. If your frontend uses a different origin, set `ALLOWED_ORIGINS` to the list
   of allowed frontend origins.
3. `CORS_ALLOW_ALL=true` is a temporary escape hatch only. Do not keep it in
   production.

### 7. Set the Lidarr webhook secret

`POST /api/webhooks/lidarr` now returns 401 when no webhook secret is set.

1. Set the webhook secret in the system settings.
2. Set the same secret in Lidarr.
3. `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` is a temporary escape hatch
   only.

### 8. Examine remote access to PostgreSQL and Redis

The Compose host ports for PostgreSQL and Redis now bind to `127.0.0.1`.

1. Tools on the same host continue to work. No action is necessary.
2. For remote tools, use the documented Compose override. A private
   authenticated path is the better option.

### 9. Repair frontend volume ownership

The production frontend image now runs as UID/GID 1000. Before this release it
ran as 1001.

1. Find frontend volumes with files that UID 1001 owns. One example is
   `.next/cache`.
2. Change the owner of these files to UID 1000, or create the volumes again.
3. AIO processes also run as UID/GID 1000. Make sure bind mounts for AIO are
   writable. The standard AIO volume paths repair themselves at boot.

### 10. Examine Helm capacity and GPU settings

1. AIO requests and limits now default to `2Gi` and `8Gi`. Make sure the
   cluster has space for the AIO pod.
2. Analyzer probes are now active in individual mode.
3. The GPU flags now create a real `nvidia.com/gpu` limit. If you use these
   flags, install the NVIDIA device plugin. Also set the runtime class if your
   cluster requires one.

### 11. Update scripts for the new authorization gates

These operations now require an administrator account:

- Global enrichment failure operations
- Shared-library download operations
- Spotify import session logs
- Soulseek-backed retries
- Lidarr queue clearing
- Library-wide or single-item enrichment

These operations now require authentication:

- Artist discovery and preview
- Audiobook cover access

Refresh tokens are only valid in the refresh exchange. They are not access
credentials.

### 12. Update custom sidecar clients

1. TIDAL admin calls now carry credentials in headers. Legacy query
   credentials operate temporarily.
2. The YouTube Music sidecar strictly validates video ids and quality values.
3. Sidecar and route errors now use the canonical `{ "error": ... }` envelope.
4. OpenSubsonic cover sizes snap to the supported allowlist. The API does not
   honor arbitrary dimensions now.

### 13. Make sure the music mount is correct before a scan

**Caution: a partially mounted library can cause the scan to remove track
records for the missing paths.**

Scans now remove database tracks that are missing from disk. The "Allow
library deletion" setting does not prevent this. A fully empty mount is
protected.

1. Make sure the full music library is mounted.
2. Then start the library scan.

## Playback reliability and telemetry

- Queue auto-advance is fixed across the full track-end path. The native
  engine now accepts the end-of-stream pause from the browser. Listeners stay
  attached while the playback state changes. A watchdog recovers a lost end
  event.
- A browser can block the next track in a hidden or unfocused window. The
  player now retries on a bounded timer, and again when the window gets focus
  or becomes visible. The player also keeps the autoplay intent of each load.
  A successful advance does not pause itself now.
- The server now records these client telemetry events:
  `load_autoplay_decision`, `track_end_*`, and `playback_start_blocked`.
  Operators can set an alert on the `autoplay_intent_conflict` event. This
  event must not occur. If it occurs, it shows a playback-intent regression.

## Cover art and session behavior

- Cover art and segmented-streaming files are correct again for caches in a
  dot-directory, for example `/music/.soundspan`. The server sends cover files
  from a pinned root directory with strong containment checks.
- A failed **Test connection** for Audiobookshelf, Fanart.tv, Last.fm,
  Soulseek, Spotify, or TIDAL does not log you out now. Upstream credential
  failures return 502. The web client only logs out for responses with the
  explicit `AUTH_REQUIRED` marker. A wrong current password shows an inline
  error.

## Security hardening

- All CodeQL alerts from the pre-release review are closed. Each alert is
  fixed, or has a recorded justification and a re-evaluation condition.
- Access-token verification is in one place. It pins HS256, validates the
  payload, and rejects refresh tokens outside the refresh exchange. TOTP moved
  from the unmaintained `speakeasy` package to `otplib`. Existing 2FA
  enrollments continue to operate.
- Account, 2FA, Subsonic credential, admin queue-dashboard, and playback-state
  routes now have route-specific rate limits. The playback limit is large
  enough for the normal high-frequency cadence.
- Authorization is more strict for: API-key and device management, MFA,
  enrichment, shared downloads, import logs, artist discovery, audiobook
  covers, Listen Together group ending, and recovery or retry operations.
- Client-facing errors now use curated messages. This applies to backend
  routes, segmented streaming, stored download jobs, and the TIDAL and YouTube
  Music sidecars. Raw paths, upstream bodies, and exception details stay in
  the server logs.
- Native streams, share-link streams, downloads, cache files, cover-image
  storage, and analyzer or repair paths keep all file access inside their root
  directories. Podcast audio, remote images, and Audiobookshelf cover access
  have DNS-aware SSRF, redirect, namespace, and input validation.
- Playlist imports accept only canonical HTTP(S) links. Text normalization and
  delimited-content stripping run in linear time. Audiobook preflight requests
  use the central deny-by-default CORS policy.
- Writes to `.env` files with secrets are atomic and owner-only. YouTube Music
  OAuth files have mode `0600`. Chart-managed workloads drop Linux
  capabilities, use `RuntimeDefault` seccomp, and do not mount service-account
  tokens.
- You can move integration credentials fully into encrypted settings with
  `SECRETS_DB_ONLY=true`. The legacy decrypt fail-closed mode is opt-in. Turn
  it on only after the secrets-status endpoint reports zero legacy rows.

## Observability migration

Some player signals have new names. Update saved searches, dashboards, and
alerts that use the old names:

| Previous name | 2.0.0 name | Scope |
| --- | --- | --- |
| `player.howler_startup` | `player.engine_startup` | Audio-engine startup |
| `route.client.signal` | `playback.client.signal` | Ingested client signals |
| `[SegmentedStreaming.Trace] client.signal` | `[Playback.Trace] client.signal` | Client trace logs |
| `[SegmentedStreaming][Metric] client.signal` | `[Playback.Metric] client.signal` | Client metric logs |

Traces that are specific to segmented streaming keep their names. This applies
to manifest, segment, session, and DASH lifecycle traces.

## Reliability and performance

- Rediscover uses a bounded, indexed candidate pool. Subsonic playlist
  durations use one aggregate query. Playlist listings paginate with
  database-side counts. Browse and list limits have clamps that prevent
  full-library work.
- A shared keyed single-flight now merges duplicate work for transcode
  caching, vibe calibration, and TIDAL or YouTube Music credential restores.
  OAuth logout is fenced against restore or refresh work that is in flight.
  Cleared credentials stay cleared.
- Sidecar network and filesystem work moved off the async event loops. This
  work now has bounded deadlines and cache sizes. It releases upstream
  connections on errors and on client disconnects. Locks guard the stream and
  browse caches against concurrent changes.
- Analyzer batch timeouts keep completed results. Work that never started goes
  back to the queue without a used retry. Only work that truly failed in
  flight uses a retry. CLAP workers have a supervisor. Resources close
  deterministically. Model unload cannot race inference.
- Import jobs run on the durable worker queue with recovery and deduplication.
  Workers claim the queue-cleaning task. API replicas do not repeat it.
- Token refresh, visibility-aware polling, and Listen Together recovery have
  focused fixes. Long sessions, hidden tabs, large queues, and cross-replica
  ready gates recover more predictably.

## Quality and maintainability

- The frontend compiles in TypeScript strict mode. The Python sidecars run
  mypy in strict mode. The exceptions for the pinned analyzer stack are
  measured and documented.
- The large library router is now a set of named per-resource routers with
  typed helper modules. The mounted URLs and the behavior did not change.
- Backend environment reads continue to move behind the typed configuration
  boundary. The temporary allowlist went from 39 production files to 19.
- Component network calls go through the shared frontend API layer. A ratchet
  test prevents new direct `fetch()` calls in app, component, and feature
  modules.

## Platform and deployment

- The standalone MusiCNN analyzer moved from Ubuntu 20.04 with Python 3.8 to
  Python 3.11. It uses the same TensorFlow 2.15.1 and Essentia model stack as
  AIO. The supported Essentia artifact matrix and the deterministic inference
  baseline are documented. Model behavior did not change.
- AIO now keeps operator-supplied master secrets. It secures embedded
  PostgreSQL on loopback with SCRAM-SHA-256. It checks frontend and backend
  readiness. It runs application processes under the fixed `soundspan`
  UID/GID 1000.
- Analyzer health probes and GPU scheduling now operate in the Helm chart.
  PostgreSQL credentials are safely encoded. You can pin application images by
  digest.
- Base images and build inputs are pinned by digest or hash. Python quality
  and sidecar test lanes are part of CI. The remaining mutable GitHub Actions
  and scanner image references are pinned.
- CodeQL analysis and the quality and enforcement gates are now blocking
  required checks. They are not visibility-only signals now.

## Also in this release

- The seek slider, modal and confirmation flows, queue reordering, track rows,
  and the Vibe map have better keyboard and screen-reader behavior.
- The playback context and the progress subscriptions are now separate.
  Status-only screens and the audio orchestrator avoid clock-driven
  re-renders. Visibility-aware polling stops unnecessary work in hidden tabs.
- Settings actions use consistent in-app confirmation dialogs. Theme colors
  have accessible contrast and focus guards.

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

- The TensorFlow 2.15 dependency line for the analyzer and AIO images keeps
  its documented `pip-audit` exceptions. These are Keras 2.15.0 and protobuf
  4.25.9. The removal conditions are in `docs/SECURITY.md`. New advisory IDs
  continue to fail CI.
- Standard Docker and Helm upgrades keep existing data. They apply Prisma
  migrations automatically. For custom deployments, you are responsible for
  database backups, migration order, and consistent sidecar secrets.

## Full changelog

- Compare changes: [1.9.0...2.0.0](https://github.com/soundspan/soundspan/compare/1.9.0...2.0.0)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.0.0/CHANGELOG.md)
