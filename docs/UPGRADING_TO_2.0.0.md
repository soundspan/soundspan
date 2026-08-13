# Upgrading to Soundspan 2.0.0

This guide covers the required steps for the upgrade from any 1.x version to
2.0.0. Soundspan 2.0.0 is a major release focused on security and
reliability. The upgrade needs action from you: complete these steps before
you start the new version.

For everything that changed in 2.0.0, see the
[release notes](release-notes/RELEASE_NOTES_2.0.0.md).

Work through these steps in order. Each step says what to do and why.

## 1. Set all required secrets

`docker-compose.yml` now requires these values at startup, and the published
defaults are rejected:

- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `SETTINGS_ENCRYPTION_KEY`
- `INTERNAL_API_SECRET`

1. Generate each new secret with `openssl rand -base64 32`.
2. Use the same `INTERNAL_API_SECRET` on the backend and on every sidecar.
3. Do not reuse the retired `soundspan-internal-secret-change-me` value.

## 2. Provide database settings as components

Compose deployments now build `DATABASE_URL` inside the application.

1. Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   and `POSTGRES_DB`.
2. Credentials are percent-encoded for you, so passwords with URL-reserved
   characters now work.
3. An explicit `DATABASE_URL` still wins unchanged — keep it for custom
   deployments.

## 3. Strengthen weak custom secrets

1. Make sure `SETTINGS_ENCRYPTION_KEY` and `INTERNAL_API_SECRET` are at least
   32 characters.
2. If you set `JWT_SECRET`, it must also be at least 32 characters.
3. If you don't set `JWT_SECRET`, the validated `SESSION_SECRET` is used and
   no action is needed.

## 4. Reissue old API keys and plan rotation

API keys now expire 90 days after creation or rotation.

1. Reissue every API key older than 90 days.
2. Plan a recurring rotation for all keys.
3. Use a logged-in browser session to manage API keys, linked devices, or
   MFA — an `X-API-Key` client can no longer perform those actions.

The settings page shows each key's expiry date and flags keys that are
expired or expiring soon.

## 5. Reconfigure OpenSubsonic clients once

Token authentication (`t` + `s`) no longer derives from your account
password.

1. Set a dedicated per-user Subsonic password via
   `POST /api/auth/subsonic-password`, or switch the client to password
   authentication.
2. Note: changing your account password clears the dedicated Subsonic
   password. Set it again afterward.

## 6. Set the CORS policy for cross-origin frontends

In production, an unset `ALLOWED_ORIGINS` now denies cross-origin browser
requests.

1. Same-origin frontend-proxy deployments need no change.
2. Otherwise, set `ALLOWED_ORIGINS` to your allowed frontend origins.
3. `CORS_ALLOW_ALL=true` is a temporary escape hatch only — don't keep it in
   production.

## 7. Configure the Lidarr webhook secret

`POST /api/webhooks/lidarr` now returns 401 when no webhook secret is
configured.

1. Set the webhook secret in system settings.
2. Configure the same secret in Lidarr.
3. `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` is a temporary escape hatch
   only.

## 8. Review remote access to PostgreSQL and Redis

The Compose host ports for PostgreSQL and Redis now bind to `127.0.0.1`.

1. Tooling on the same host keeps working — no change needed.
2. For remote tooling, use the documented Compose override, or better, a
   private authenticated path.

## 9. Repair frontend volume ownership

The frontend image now runs as UID/GID 1000 (previously 1001).

1. Find frontend volumes with files owned by UID 1001 — usually
   `.next/cache`.
2. Re-chown those files to 1000, or recreate the volumes.
3. AIO processes also run as UID/GID 1000 and need writable bind mounts. The
   standard AIO volume paths repair themselves at boot.

## 10. Review Helm capacity and GPU settings

1. AIO requests and limits now default to `2Gi`/`8Gi` — make sure the cluster
   can place the pod.
2. Analyzer probes are now enabled in individual mode.
3. GPU flags now create a real `nvidia.com/gpu` limit. If you use them,
   install the NVIDIA device plugin and set a runtime class if your cluster
   requires one.

## 11. Update scripts for the new authorization gates

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

## 12. Update custom sidecar clients

1. TIDAL admin calls now carry credentials in headers; legacy query
   credentials still work for now.
2. YouTube Music video ids and quality values are strictly validated.
3. Sidecar and route errors now use the canonical `{ "error": ... }`
   envelope.
4. OpenSubsonic cover sizes snap to the supported allowlist — arbitrary
   dimensions are no longer honored.

## 13. Verify the music mount before you scan

**Caution: a partially mounted library can cause a scan to remove the track
records for the missing paths.**

Scans now remove database tracks that are missing from disk, regardless of
the "Allow library deletion" setting. A completely empty mount is protected.

1. Make sure the full music library is mounted.
2. Then run the library scan.

## After the upgrade

1. Watch the backend logs for startup validation errors. The application
   refuses to start when a required secret is missing or weak.
2. Confirm playback, cover art, and your integrations work.
3. If a step above was skipped, the symptoms point back to it: rejected
   startup (secrets), failed logins from Subsonic clients (step 5), blocked
   browser requests (step 6), 401 from Lidarr (step 7), or unwritable
   frontend volumes (step 9).
