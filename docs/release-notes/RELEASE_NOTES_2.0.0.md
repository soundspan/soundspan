# [2.0.0] Release Notes - 2026-08-12

Soundspan 2.0.0 is a major release focused on security and reliability. It is
the result of a systematic security review over several months. It tightens
credentials, sessions, authorization, network boundaries, and filesystem
access, and it bounds more database, sidecar, and background work.

This is a major version because the upgrade needs action from you. Complete
the steps below before you start the new version.

## Before you upgrade — required steps

Work through these steps in order. Each step says what to do and why.

### 1. Set all required secrets

`docker-compose.yml` now requires these values at startup, and the published
defaults are rejected:

- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `SETTINGS_ENCRYPTION_KEY`
- `INTERNAL_API_SECRET`

1. Generate each new secret with `openssl rand -base64 32`.
2. Use the same `INTERNAL_API_SECRET` on the backend and on every sidecar.
3. Do not reuse the retired `soundspan-internal-secret-change-me` value.

### 2. Provide database settings as components

Compose deployments now build `DATABASE_URL` inside the application.

1. Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   and `POSTGRES_DB`.
2. Credentials are percent-encoded for you, so passwords with URL-reserved
   characters now work.
3. An explicit `DATABASE_URL` still wins unchanged — keep it for custom
   deployments.

### 3. Strengthen weak custom secrets

1. Make sure `SETTINGS_ENCRYPTION_KEY` and `INTERNAL_API_SECRET` are at least
   32 characters.
2. If you set `JWT_SECRET`, it must also be at least 32 characters.
3. If you don't set `JWT_SECRET`, the validated `SESSION_SECRET` is used and
   no action is needed.

### 4. Reissue old API keys and plan rotation

API keys now expire 90 days after creation or rotation.

1. Reissue every API key older than 90 days.
2. Plan a recurring rotation for all keys.
3. Use a logged-in browser session to manage API keys, linked devices, or
   MFA — an `X-API-Key` client can no longer perform those actions.

The settings page shows each key's expiry date and flags keys that are
expired or expiring soon.

### 5. Reconfigure OpenSubsonic clients once

Token authentication (`t` + `s`) no longer derives from your account
password.

1. Set a dedicated per-user Subsonic password via
   `POST /api/auth/subsonic-password`, or switch the client to password
   authentication.
2. Note: changing your account password clears the dedicated Subsonic
   password. Set it again afterward.

### 6. Set the CORS policy for cross-origin frontends

In production, an unset `ALLOWED_ORIGINS` now denies cross-origin browser
requests.

1. Same-origin frontend-proxy deployments need no change.
2. Otherwise, set `ALLOWED_ORIGINS` to your allowed frontend origins.
3. `CORS_ALLOW_ALL=true` is a temporary escape hatch only — don't keep it in
   production.

### 7. Configure the Lidarr webhook secret

`POST /api/webhooks/lidarr` now returns 401 when no webhook secret is
configured.

1. Set the webhook secret in system settings.
2. Configure the same secret in Lidarr.
3. `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` is a temporary escape hatch
   only.

### 8. Review remote access to PostgreSQL and Redis

The Compose host ports for PostgreSQL and Redis now bind to `127.0.0.1`.

1. Tooling on the same host keeps working — no change needed.
2. For remote tooling, use the documented Compose override, or better, a
   private authenticated path.

### 9. Repair frontend volume ownership

The frontend image now runs as UID/GID 1000 (previously 1001).

1. Find frontend volumes with files owned by UID 1001 — usually
   `.next/cache`.
2. Re-chown those files to 1000, or recreate the volumes.
3. AIO processes also run as UID/GID 1000 and need writable bind mounts. The
   standard AIO volume paths repair themselves at boot.

### 10. Review Helm capacity and GPU settings

1. AIO requests and limits now default to `2Gi`/`8Gi` — make sure the cluster
   can place the pod.
2. Analyzer probes are now enabled in individual mode.
3. GPU flags now create a real `nvidia.com/gpu` limit. If you use them,
   install the NVIDIA device plugin and set a runtime class if your cluster
   requires one.

### 11. Update scripts for the new authorization gates

These operations now require an administrator:

- Global enrichment-failure operations
- Shared-library download operations
- Spotify import session logs
- Soulseek-backed retries
- Lidarr queue clearing
- Library-wide or single-item enrichment

These operations now require authentication:

- Artist discovery and preview
- Audiobook cover access

Refresh tokens are accepted only by the refresh exchange — they are not
access credentials.

### 12. Update custom sidecar clients

1. TIDAL admin calls now carry credentials in headers; legacy query
   credentials still work for now.
2. YouTube Music video ids and quality values are strictly validated.
3. Sidecar and route errors now use the canonical `{ "error": ... }`
   envelope.
4. OpenSubsonic cover sizes snap to the supported allowlist — arbitrary
   dimensions are no longer honored.

### 13. Verify the music mount before you scan

**Caution: a partially mounted library can cause a scan to remove the track
records for the missing paths.**

Scans now remove database tracks that are missing from disk, regardless of
the "Allow library deletion" setting. A completely empty mount is protected.

1. Make sure the full music library is mounted.
2. Then run the library scan.

## Playback reliability and telemetry

- Queue auto-advance is fixed across the full track-end path. The native
  engine now accepts the browser's end-of-stream pause, listeners stay
  attached through playback state changes, and a watchdog recovers a lost end
  event.
- If a browser blocks the next track in a hidden or unfocused window, the
  player retries on a bounded timer and again on focus or visibility. Each
  load's autoplay intent is preserved, so a successful advance no longer
  pauses itself.
- The server now records `load_autoplay_decision`, `track_end_*`, and
  `playback_start_blocked` client telemetry. Operators can alert on
  `autoplay_intent_conflict` — it should never fire, and if it does, it
  signals a playback-intent regression.

## Cover art and session behavior

- Cover art and segmented-streaming assets no longer return 404 when the
  cache lives in a dot-directory such as `/music/.soundspan`. Cover files are
  served from a pinned root with strong containment checks.
- A failed **Test connection** for Audiobookshelf, Fanart.tv, Last.fm,
  Soulseek, Spotify, or TIDAL no longer logs you out. Upstream credential
  failures return 502, and the web client logs out only for responses with
  the explicit `AUTH_REQUIRED` marker. A wrong current password shows an
  inline error.

## Security hardening

- Every CodeQL alert from the pre-release review is closed — fixed, or
  recorded with an owned justification and a re-evaluation condition.
- Access-token verification is centralized. It pins HS256, validates
  payloads, and rejects refresh tokens outside the refresh exchange. TOTP
  moved from the unmaintained `speakeasy` package to `otplib`; existing 2FA
  enrollments keep working.
- Account, 2FA, Subsonic-credential, admin queue-dashboard, and
  playback-state routes now have route-specific rate limits. The playback
  tier stays generous enough for its normal high-frequency cadence.
- Authorization is tighter across API-key and device management, MFA,
  enrichment, shared downloads, import logs, artist discovery, audiobook
  covers, Listen Together group ending, and recovery/retry operations.
- Client-facing errors now use curated messages across backend routes,
  segmented streaming, stored download jobs, and the TIDAL and YouTube Music
  sidecars. Raw paths, upstream bodies, and exception details stay in server
  logs.
- Native streams, share-link streams, downloads, cache files, cover-image
  storage, and analyzer/repair paths keep all file access inside their root
  directories. Podcast audio, remote images, and Audiobookshelf cover access
  gained DNS-aware SSRF, redirect, namespace, and input validation.
- Playlist imports accept only canonical HTTP(S) links. Text normalization
  and delimited-content stripping run in linear time. Audiobook preflight
  uses the central deny-by-default CORS policy.
- Secret-bearing `.env` writes are atomic and owner-only. YouTube Music OAuth
  files use mode `0600`. Chart-managed workloads drop Linux capabilities, use
  `RuntimeDefault` seccomp, and don't mount service-account tokens.
- You can move integration credentials fully into encrypted settings with
  `SECRETS_DB_ONLY=true`. The legacy decrypt fail-closed mode is opt-in —
  enable it only after the secrets-status endpoint reports zero legacy rows.

## Observability migration

Some player signals have new names. Update saved searches, dashboards, and
alerts that use the old names:

| Previous name | 2.0.0 name | Scope |
| --- | --- | --- |
| `player.howler_startup` | `player.engine_startup` | Audio-engine startup |
| `route.client.signal` | `playback.client.signal` | Ingested client signals |
| `[SegmentedStreaming.Trace] client.signal` | `[Playback.Trace] client.signal` | Client trace logs |
| `[SegmentedStreaming][Metric] client.signal` | `[Playback.Metric] client.signal` | Client metric logs |

Traces genuinely specific to segmented streaming — manifest, segment,
session, and DASH lifecycle — keep their existing names.

## Reliability and performance

- Rediscover uses a bounded, indexed candidate pool. Subsonic playlist
  durations use one aggregate query. Playlist listings paginate with
  database-side counts, and browse/list limits are clamped to prevent
  full-library work.
- A shared keyed single-flight coalesces transcode caching, vibe calibration,
  and TIDAL/YouTube Music credential restores. OAuth logout is fenced against
  in-flight restore or refresh work, so cleared credentials stay cleared.
- Sidecar network and filesystem work moved off the async event loops, gained
  bounded deadlines and cache sizes, and releases upstream connections on
  errors and client disconnects. Locks guard the stream and browse caches
  against concurrent mutation.
- Analyzer batch timeouts preserve completed results. Work that never started
  is requeued without consuming a retry; only genuinely in-flight failures
  use one. CLAP workers are supervised, resources close deterministically,
  and model unload cannot race inference.
- Import jobs run durably on the worker queue with recovery and
  deduplication. Workers claim queue cleaning, so API replicas don't repeat
  it.
- Token refresh, visibility-aware polling, and Listen Together recovery
  received focused fixes, so long sessions, hidden tabs, large queues, and
  cross-replica ready gates recover more predictably.

## Quality and maintainability

- The frontend compiles in TypeScript strict mode, and the Python sidecars
  run mypy in strict mode with measured, documented exceptions for the pinned
  analyzer stack.
- The large library router is now a set of named per-resource routers with
  typed helper modules. Mounted URLs and behavior are unchanged.
- Backend environment reads keep moving behind the typed configuration
  boundary; the temporary allowlist shrank from 39 production files to 19.
- Component network calls go through the shared frontend API layer, with a
  ratchet test that blocks new direct `fetch()` calls in app, component, and
  feature modules.

## Platform and deployment

- The standalone MusiCNN analyzer moved from Ubuntu 20.04/Python 3.8 to
  Python 3.11, with the same TensorFlow 2.15.1 and Essentia model stack as
  AIO. The supported Essentia artifact matrix and deterministic inference
  baseline are documented; model behavior is unchanged.
- AIO now persists operator-supplied master secrets, secures embedded
  PostgreSQL on loopback with SCRAM-SHA-256, checks frontend and backend
  readiness, and runs application processes under the fixed `soundspan`
  UID/GID 1000.
- Analyzer health probes and GPU scheduling now work in the Helm chart.
  PostgreSQL credentials are safely encoded, and application images can be
  pinned by digest.
- Base images and build inputs are digest- or hash-pinned. Python quality and
  sidecar test lanes are part of CI, and the remaining mutable GitHub Actions
  and scanner image references are pinned.
- CodeQL analysis and the quality/enforcement gates now run as blocking
  required checks, not visibility-only signals.

## Also in this release

- The seek slider, modal and confirmation flows, queue reordering, track
  rows, and the Vibe map gained stronger keyboard and screen-reader behavior.
- Playback context and progress subscriptions are now separate, so
  status-only screens and the audio orchestrator avoid clock-driven
  re-renders. Visibility-aware polling stops unnecessary work in hidden tabs.
- Settings actions use consistent in-app confirmation dialogs, and theme
  colors have accessible contrast and focus guards.

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
  4.25.9). Their removal conditions live in `docs/SECURITY.md`, and new
  advisory IDs still fail CI.
- Standard Docker and Helm upgrades preserve existing data and apply Prisma
  migrations automatically. Custom deployments remain responsible for
  database backups, migration ordering, and consistent sidecar secrets.

## Full changelog

- Compare changes: [1.9.0...2.0.0](https://github.com/soundspan/soundspan/compare/1.9.0...2.0.0)
- Full changelog: [CHANGELOG.md](https://github.com/soundspan/soundspan/blob/2.0.0/CHANGELOG.md)
