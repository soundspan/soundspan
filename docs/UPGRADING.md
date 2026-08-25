# Upgrading Soundspan

This file lists the upgrades that need something from you. Most releases are
not listed here — for those, upgrading is just pulling the new image and
restarting.

**How to use this file:**

1. Find the version you are running now (Settings → About, or your image tag).
2. Read every section below for versions **newer** than yours. Sections are
   ordered newest first.
3. If none of those sections mention your setup, the upgrade is drop-in.

**Coming from 1.x?** The jump across 2.0.0 has its own step-by-step guide:
[Upgrading to 2.0.0](UPGRADING_TO_2.0.0.md). Follow that first, then come back
here for anything newer.

## The short version for most installs

Most people run the **All-in-One (AIO) image** with docker compose. For almost
every release, the whole upgrade is:

```bash
docker compose -f docker-compose.aio.yml down
docker compose -f docker-compose.aio.yml pull
docker compose -f docker-compose.aio.yml up -d
```

Before any upgrade that this file marks **Breaking**, also back up your
database first. For the AIO image, the simplest full backup is copying the
data volume while the container is stopped.

## Which versions need action?

| Upgrading across | Action needed? |
| ---------------- | -------------- |
| **2.5.0** | Usually none — plain rolling update; database migrations apply automatically. **Heads-up on two default changes:** users who share online presence become visible to federated peer servers too (and public playlists are shared with peers) — turning off **Share online presence** or making a playlist private restores local-only behavior; and the new music-request feature is on by default (`FEATURE_REQUESTS=false` to disable). Federation pairing codes are removed — new peer connections use the host-credential flow, and both servers must be on versions that support it. The TIDAL sidecar is also renamed to `tidal-streamer`, but every old reference keeps working; see the section below. |
| **2.4.1** | None — plain rolling update; no database migrations. Fixes Subsonic full syncs of large libraries (Symfonium and similar clients importing nothing) and the Library Enrichment failures view. If your server must federate through an egress proxy, the new `FEDERATION_ALLOW_PROXY=true` opt-in restores proxy support that 2.4.0 disabled. |
| **2.4.0** | Usually none — plain rolling update; all database migrations apply automatically. **Exception:** federation now resolves peer hostnames and rejects private, loopback, and link-local addresses whether configured literally or returned by DNS — if any peer lives on a LAN or VPN, set `FEDERATION_ALLOW_PRIVATE_PEERS=true` before upgrading or that peer stops syncing. Federation traffic also no longer routes through `HTTP(S)_PROXY` egress proxies. Heads-up for very large libraries: two migrations do heavier work (track-mapping housekeeping and an album-ownership guard), so the first startup can take longer than usual. Also new: a daily cleanup removes stale, unliked, unplayable TIDAL/YouTube Music catalog rows after 30 days (`PROVIDER_TRACK_RETENTION_DAYS` to tune); liked, playlisted, recently played, and file-backed content is always kept. |
| **2.3.3** | Usually none — plain rolling update; a small database change applies automatically. **Exception:** if a federation peer is configured by a literal private, loopback, or link-local IP address (LAN/VPN IPs, `127.x`, `169.254.x`) or by `localhost`, set `FEDERATION_ALLOW_PRIVATE_PEERS=true` first — outbound federation now rejects these by default (peers configured by a DNS hostname other than `localhost` are unaffected). If you are on 2.3.2, upgrade promptly: its audio-analyzer container could not start, so loudness measurement was paused until this release. |
| **2.3.2** | None — plain rolling update; database changes apply automatically. Heads-up: volume leveling is new and on by default; each listener can turn it off under Settings → Playback. |
| **2.3.0** | Usually automatic. AIO: the standard down/pull/up above is the whole upgrade. Split-stack Compose and Helm: read the section — old analyzer containers must be fully stopped. Back up the database first: no image-only downgrade after this one. |
| **2.0.0** | **Yes — follow the [dedicated 2.0.0 guide](UPGRADING_TO_2.0.0.md).** Required secrets, client re-auth, and more. |
| **1.9.0** | Only if you run the YouTube Music/TIDAL sidecars with a custom setup, or build from source (Node 24). |
| **1.8.0** | None to adopt. Only act if you want to keep the old playback engine. |
| **1.6.0** | Mostly automatic hardening. Recommended follow-ups for Lidarr and Helm users. |

Anything not listed: drop-in.

---

## Unreleased: legacy discovery mode now serves the modern implementation

You only need to read this if you ever set the environment variable
`DISCOVERY_MODE=legacy`. If you never set it (most installs), nothing changes.

The old "legacy" discovery implementation has been removed from the codebase.
The `DISCOVERY_MODE` variable still works and `legacy` is still a valid value,
so nothing breaks at startup — but setting it to `legacy` now serves the same
modern discovery pages everyone else gets, and the server logs a one-line
reminder when it starts. To stop the reminder, remove the variable (or set it
to `modern`). Nothing else about discovery, downloads, or your library is
affected.

## 2.5.0: sharing defaults, pairing codes, and the TIDAL sidecar rename

**Sharing defaults.** After the upgrade, **Share online presence** controls a
user's visibility everywhere, including federated peer servers, and every
public playlist is visible to connected peers. The old per-user "share with
trusted peers" toggles are gone. Users who want to stay local-only should turn
off **Share online presence** or make the playlist private before or after the
upgrade — nothing else is required.

**Music requests.** Non-admin users get Request buttons and admins get a
Requests page (avatar menu). The feature is on by default; set
`FEATURE_REQUESTS=false` to turn it off, and `REQUESTS_PER_USER_PER_DAY`
(default 10) to tune the per-user daily cap.

**Pairing codes removed.** New federation connections are made with a host
credential issued by the hosting server's admin. A peer running a version that
only supports pairing codes must upgrade before it can pair. Established
connections keep working.

### TIDAL sidecar renamed to `tidal-streamer`

The TIDAL sidecar now matches the YouTube sidecar's naming. It streams and
downloads, so it is named for its primary role, like `ytmusic-streamer`.

**No action is required.** Every old reference keeps working:

- Images are published under both names. `soundspan-tidal-streamer` is the
  new primary; `soundspan-tidal-downloader` receives the same versions as an
  alias.
- The compose service is now `tidal-streamer`, but the old in-network
  hostname `tidal-downloader` still resolves to it. A custom
  `TIDAL_SIDECAR_URL=http://tidal-downloader:8585` keeps working.
- The `TIDAL_SIDECAR_URL` and `SOUNDSPAN_TIDAL_CONTAINER_NAME` variable
  names, the sidecar's port (8585), its API, your TIDAL login, and all Helm
  values keys (`tidalSidecar`) are unchanged.

Cosmetic changes you may notice: the default container name is now
`soundspan_tidal_streamer`, and the Helm chart's default image points at the
new name. Set `SOUNDSPAN_TIDAL_CONTAINER_NAME=soundspan_tidal_downloader` if
your tooling keys on the old container name.

When convenient, move image pins and custom URLs to the new name — the alias
exists so you never have to do this during the upgrade itself.

## 2.3.0: DCLAP replaces the torch CLAP analyzer

**Who this affects:** all Compose and Helm deployments, and custom or
bare-metal deployments that run the torch CLAP analyzer directly.

**What changed.** The torch `audio-analyzer-clap` service has been removed from
Compose. Its multi-GB image is no longer pulled or run. The CPU-only
`vibe-provider-dclap` service now starts by default, and the backend connects to
it through `VIBE_PROVIDER_URL`. In the Helm chart, an upgrade removes the torch
analyzer Deployment; operators who previously set
`audioAnalyzerClap.enabled=true` should set `vibeProviderDclap.enabled=true`
instead — the chart wires the backend and an enabled backend worker
automatically, and all `audioAnalyzerClap.*` values are dead and should be
deleted.

**Existing libraries.** On first start, the backend registers the DCLAP
embedding space and re-embeds the library in the background. This is a
blue/green migration: existing similarity continues to use the old vectors
until the new space reaches the configured coverage threshold, then the backend
cuts over automatically. It removes the old vectors after the retirement grace
window. No operator action is required.

During backfill, text-based vibe search may return fewer results until cutover
completes. Existing active-space audio similarity continues to work before
cutover. After cutover at the coverage threshold, tracks in the missing tail may
return no similarity results until their DCLAP re-embed completes. Fresh or
empty libraries whose active space has never held vectors cut over immediately.

**Rollback warning:** an image-only downgrade to 2.2.0 is not supported after
the 2.3.0 migration begins. The 2.2.0 code does not understand the 2.3.0
embedding-space schema or the DCLAP student vectors. Back up PostgreSQL before
the upgrade. To roll back the release, restore that database backup and then
redeploy the 2.2.0 images. Before embedding-space cutover, you may instead
abandon the DCLAP migration while staying on 2.3.0. Unset `VIBE_PROVIDER_URL`
on the backend and workers, then restart them. The provider lifecycle stops,
the prior active space keeps serving, and partial migrating-space vectors
remain unused. After cutover, use the database restore and 2.2.0 image redeploy
described above.

### AIO Compose (`docker-compose.aio.yml`) — most installs

Back up your database, then the standard down/pull/up is the whole upgrade.
The file exposes a single `soundspan` service; the 2.3 entrypoint runs the
schema migration before any process serves, and no 2.2 process survives a
`down`:

```bash
docker compose -f docker-compose.aio.yml down
docker compose -f docker-compose.aio.yml pull
docker compose -f docker-compose.aio.yml up -d
```

Lingering `CLAP_*` environment variables are inert and may be deleted. AIO
operators may override `VIBE_PROVIDER_URL`, `MODEL_IDLE_TIMEOUT`, and
`DCLAP_ONNX_INTRA_OP_THREADS` directly in the host environment. Use the AIO
memory envelope in [DEPLOYMENT.md](DEPLOYMENT.md) when sizing the container.

### Split-stack Compose (`docker-compose.yml`)

**Warning:** Compose does not stop a service removed from the file; the old
analyzer container becomes an orphan. A surviving analyzer writes with the
removed single-space contract, so every embedding store against the new
composite schema fails and can leave tracks permanently failed. Use the same
`-f` arguments as your normal deployment for every command. First, render the
merged configuration so stale overrides are visible:

```bash
docker compose config
```

Remove any custom override that still declares `audio-analyzer-clap`. Then
fully stop every backend API and worker container. Stop any surviving torch
analyzer before a 2.3 entrypoint can run the migration:

```bash
docker compose stop backend backend-worker
docker ps --filter name=audio-analyzer-clap -q | xargs -r docker stop
docker compose ps --status running --format '{{.Name}}' backend backend-worker
docker ps --filter name=audio-analyzer-clap --format '{{.Names}}'
```

The last two commands must print no container names. Recreate the stack only
after every old writer has terminated:

```bash
docker compose up -d --remove-orphans
```

Verify that the removed torch analyzer did not return. This command must print
no container names:

```bash
docker ps --filter name=audio-analyzer-clap --format '{{.Names}}'
```

The old torch image can be removed after the orphaned container is gone.

### Helm

**Warning:** a 2.2 upgrade with `--reuse-values` carries the removed
`audioAnalyzerClap.*` map forward and fails with the chart's migration message.
Use `--reset-then-reuse-values` with Helm 3.14 or newer, or supply a clean
values file that omits the legacy map. The guard runs during template or
install/upgrade rendering. `helm lint` alone exits successfully and does not
enforce it.

This upgrade changes the track-embedding composite key while individual-mode
Deployments may still run 2.2 pods. Stop both workloads before `helm upgrade`.
Set the namespace, Helm release, chart name label, and the two rendered
Deployment names. The chart's pod selectors contain
`app.kubernetes.io/name`, `app.kubernetes.io/instance`, and
`app.kubernetes.io/component`. If `nameOverride` is set, use that value for
`chart_name`. Save the original replica counts, then scale the backend and the
optional backend worker to zero:

```bash
namespace=soundspan
release=soundspan
chart_name=soundspan
backend_deployment=soundspan-backend
worker_deployment=soundspan-backend-worker
backend_selector="app.kubernetes.io/name=$chart_name,app.kubernetes.io/instance=$release,app.kubernetes.io/component=backend"
worker_selector="app.kubernetes.io/name=$chart_name,app.kubernetes.io/instance=$release,app.kubernetes.io/component=backend-worker"
backend_replicas=$(kubectl -n "$namespace" get deployment "$backend_deployment" -o jsonpath='{.spec.replicas}')
worker_present=false
if kubectl -n "$namespace" get deployment "$worker_deployment" >/dev/null 2>&1; then
  worker_present=true
  worker_replicas=$(kubectl -n "$namespace" get deployment "$worker_deployment" -o jsonpath='{.spec.replicas}')
fi
kubectl -n "$namespace" scale deployment "$backend_deployment" --replicas=0
if [ "$worker_present" = true ]; then
  kubectl -n "$namespace" scale deployment "$worker_deployment" --replicas=0
fi
```

Warning: zero ready replicas is not sufficient. A terminating 2.2 pod can
continue draining work. Wait for Kubernetes to delete every pod selected by
both chart workloads:

```bash
if [ -n "$(kubectl -n "$namespace" get pod -l "$backend_selector" -o name)" ]; then
  kubectl -n "$namespace" wait --for=delete pod \
    -l "$backend_selector" --timeout=5m
fi
if [ "$worker_present" = true ]; then
  if [ -n "$(kubectl -n "$namespace" get pod -l "$worker_selector" -o name)" ]; then
    kubectl -n "$namespace" wait --for=delete pod \
      -l "$worker_selector" --timeout=5m
  fi
fi
```

Run `helm upgrade` only after both waits succeed. Then restore and verify the
saved replica counts:

```bash
kubectl -n "$namespace" scale deployment "$backend_deployment" \
  --replicas="$backend_replicas"
if [ "$worker_present" = true ]; then
  kubectl -n "$namespace" scale deployment "$worker_deployment" \
    --replicas="$worker_replicas"
fi
kubectl -n "$namespace" rollout status deployment/"$backend_deployment" --timeout=5m
if [ "$worker_present" = true ]; then
  kubectl -n "$namespace" rollout status deployment/"$worker_deployment" --timeout=5m
fi
```

### Bare-metal or custom deployment

Stop the backend and every worker before
applying the 2.3 database migration. Confirm that every process has fully exited;
do not rely on readiness or shutdown initiation alone. Run this command from
the backend directory with the deployment's `DATABASE_URL`:

```bash
DATABASE_URL='postgresql://soundspan:password@database:5432/soundspan' npx prisma migrate deploy
```

Run the provider with the music library mounted read-only. Publish its HTTP port
only where the backend and workers can reach it. Use the same internal secret
on both sides. This example binds the provider to loopback for a backend on the
same host:

```bash
export INTERNAL_API_SECRET="replace-with-the-existing-soundspan-secret"
docker run -d \
  --name soundspan-vibe-provider-dclap \
  --restart unless-stopped \
  -p 127.0.0.1:8092:8092 \
  -v /srv/music:/music:ro \
  -e INTERNAL_API_SECRET \
  ghcr.io/soundspan/soundspan-vibe-provider-dclap:2.3.0
```

Set `VIBE_PROVIDER_URL=http://127.0.0.1:8092` on the backend and every worker
process. Start the provider first, then the backend, then the workers. A minimal
systemd-managed Docker unit uses an environment file so the secret is not
embedded in the unit:

```ini
[Unit]
Description=soundspan DCLAP vibe provider
After=docker.service
Requires=docker.service

[Service]
EnvironmentFile=/etc/soundspan/vibe-provider.env
ExecStartPre=-/usr/bin/docker rm -f soundspan-vibe-provider-dclap
ExecStart=/usr/bin/docker run --rm --name soundspan-vibe-provider-dclap --network host -v /srv/music:/music:ro -e INTERNAL_API_SECRET ghcr.io/soundspan/soundspan-vibe-provider-dclap:2.3.0
ExecStop=/usr/bin/docker stop -t 30 soundspan-vibe-provider-dclap
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Store `INTERNAL_API_SECRET=<same-secret>` in
`/etc/soundspan/vibe-provider.env`, restrict that file to the service
administrator, enable the unit, and verify the authenticated health endpoint:

```bash
curl --fail \
  -H "X-Internal-Secret: ${INTERNAL_API_SECRET}" \
  http://127.0.0.1:8092/health
```

---

## 2.0.0: security overhaul (action required)

Everything in this block shipped in **2.0.0**. If you are upgrading across
2.0.0, don't start here — follow the step-by-step
[Upgrading to 2.0.0](UPGRADING_TO_2.0.0.md) guide, which walks through the
required actions in order. The subsections below are the detailed reference
behind those steps.

### ⚠️ Breaking: frontend image runtime UID changed from 1001 to 1000

**Who this affects:** operators who bind-mount or persist frontend paths that
were created by the previous production image's UID/GID 1001 user.

**What changed.** The frontend production image now runs as the base Node
image's built-in `node` user (UID/GID 1000), matching the Helm chart's
`runAsUser: 1000`, `runAsGroup: 1000`, and `fsGroup: 1000` settings.

**Action required:** reassign existing persistent frontend paths before upgrade:

```sh
chown -R 1000:1000 /path/to/frontend-volume
```

Alternatively, delete an ephemeral `.next/cache` so the image can recreate it.
The backend `api-runtime` now runs compiled JavaScript with
`node dist/index.js`; no operator action is required unless a custom entrypoint
override invoked `tsx`, in which case switch it to `node dist/index.js`.

---

### ⚠️ Breaking: Subsonic account passwords are no longer stored reversibly (token-auth clients re-authenticate once)

**Who this affects:** users whose OpenSubsonic/Subsonic client authenticates with
**token auth** (`t`+`s`, i.e. `md5(password + salt)`) using their **soundspan
account password**. Clients using plain password auth (`p=`) are unaffected.

**What changed.** The Subsonic auth middleware used to persist a successful
password-auth user's account password as reversible ciphertext in
`user.subsonicPassword` so that later token-auth requests could recompute the MD5
digest. That downgraded a bcrypt-only account password to a key-reversible value
at rest. Now:

- Password auth authenticates via bcrypt and **persists nothing**.
- Token auth validates against a **dedicated per-user Subsonic secret**, set
  explicitly via `POST /api/auth/subsonic-password` (the Settings UI's "Subsonic
  password" field). This secret is purpose-specific and independent of the
  account password.
- Changing the account password (`POST /api/auth/change-password`, and admin user
  updates that set a new password) now **clears** `subsonicPassword`, forcing a
  one-time re-establishment.

**What to do.** In each affected client, either (a) set a dedicated Subsonic
password once (soundspan Settings → Subsonic password) and use that in the client,
or (b) switch the client to password auth. No data migration is required; any
previously auto-stored account-password ciphertext is cleared on the next account
password change.

---

### Optional: fail-closed legacy decryption (`SETTINGS_DECRYPT_FAIL_CLOSED`)

**Who this affects:** operators completing the v1 (AES-256-CBC) → v2 (AES-256-GCM)
at-rest cipher migration who want to guarantee no legacy/plaintext-passthrough
values remain readable.

**Background.** The legacy decryption path returns unrecognized values verbatim
(fail-open) so historical data keeps working during migration. Set
`SETTINGS_DECRYPT_FAIL_CLOSED=true` to make any non-`v2:` stored value throw
instead. Authenticated `v2` ciphertext already fails closed unconditionally.

**Rollout.** Do **not** enable this until `GET /api/admin/secrets-status` reports
`settingsCipher.legacy: 0` (run the `scripts/migrate-settings-to-gcm.ts` backfill
first if needed). Enabling it while legacy rows remain will make those values
unreadable (e.g. Tidal credentials become unconfigured and require re-auth). The
flag is a defense-in-depth latch to flip once, after the migration is verified
complete.

---

### Helm chart hardening (pod security, API-key Secret refs, AIO memory, frontend UID)

**Who this affects:** Helm chart users. No action is required for a default
install, but review the notes below if you use `secrets.existingSecret`, pin
tight resource quotas, run custom sidecars in chart pods, or have GPU nodes.

- **Pod security context.** All chart-managed workloads now set
  `seccompProfile: RuntimeDefault`, drop all Linux capabilities on the
  application containers, and set `automountServiceAccountToken: false`. If you
  inject a custom sidecar that needs Linux capabilities or Kubernetes API
  access, add them back on that container/pod (or set
  `global.automountServiceAccountToken: true`). Postgres and Redis keep their
  capabilities (their images switch users at entrypoint).

- **Third-party API keys are now Secret-referenced.** `config.lidarrApiKey`,
  `config.audiobookshelfToken`, `config.lastfmApiKey`, `config.fanartApiKey`,
  and `config.openaiApiKey` are no longer rendered as plaintext `value:` env in
  pod specs. With the chart-managed Secret (default) they are written into that
  Secret and injected via `secretKeyRef` — no change needed. **If you use
  `secrets.existingSecret`,** the legacy plaintext behavior is preserved by
  default (your inline `config.*` values still work). To move these keys into
  your existing Secret, add them (keys `LIDARR_API_KEY`, `AUDIOBOOKSHELF_TOKEN`,
  `LASTFM_API_KEY`, `FANART_API_KEY`, `OPENAI_API_KEY`) and set
  `secrets.apiKeysInExistingSecret: true`.

- **AIO default memory raised.** `aio.resources` now defaults to `2Gi` request /
  `8Gi` limit (was `1Gi`/`4Gi`); the bundled analyzers peak above the old 4Gi
  ceiling. If your namespace has a tight `LimitRange`/`ResourceQuota`, either
  raise it or set `aio.resources.limits.memory` back down (and disable analysis
  with `config.features.audioAnalysis: false` if you do).

- **Frontend inherits UID/GID 1000.** The frontend pod inherits the chart-wide
  UID/GID `1000` pod security context, matching the realigned image's `node`
  user. The earlier `1001` override was removed; see the top-of-file **frontend
  image runtime UID changed from 1001 to 1000** breaking note for volume-ownership
  action.

- **Analyzer probes.** Individual-mode audio-analyzer and CLAP Deployments now
  have exec (`pgrep`) liveness/readiness probes. Disable per analyzer by setting
  `audioAnalyzer.livenessProbe`/`readinessProbe` (and CLAP equivalents) to
  `null`.

- **GPU values now function.** `aio.gpu.enabled` / `audioAnalyzer.gpu.enabled` /
  `audioAnalyzerClap.gpu.enabled` were previously no-ops; enabling them now adds
  an `nvidia.com/gpu` limit (`gpu.count`, default 1) and optional
  `gpu.runtimeClassName`. Requires the NVIDIA device plugin on the cluster.

---

### ⚠️ Breaking: no more shipped default secrets; fail-fast startup; Postgres/Redis bound to loopback

**Who this affects:** every split-stack (`docker-compose.yml`) deployment that relied on
the shipped defaults for `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, or
`INTERNAL_API_SECRET`, and any host tooling that reached Postgres/Redis on a
non-loopback interface. The AIO image is **not** affected — it generates and persists
its own secrets under `/data/secrets/`.

**What changed.**

1. **Required secrets, no defaults.** `docker-compose.yml` no longer ships fallback
   values for `SESSION_SECRET` (was the published `changeme-generate-secure-key`),
   `SETTINGS_ENCRYPTION_KEY` (was empty, silently replaced by an insecure default in
   the entrypoint), or `INTERNAL_API_SECRET` (was the published
   `soundspan-internal-secret-change-me`). `docker compose config`/`up` now fails
   with a message naming the missing variable. Generate each one with:

   ```bash
   openssl rand -base64 32
   ```

2. **Entrypoint fails fast instead of papering over missing secrets.** The backend
   image's entrypoint previously generated an **ephemeral per-boot** `SESSION_SECRET`
   (invalidating every JWT and stranding API-key hashes on each restart) and fell back
   to the insecure `default-encryption-key-change-me` encryption key — which the
   backend then **rejected at module load**, producing a guaranteed crash-loop with a
   misleading error. It now exits immediately with a clear, actionable message when
   `SESSION_SECRET` is unset/default/shorter than 32 chars or
   `SETTINGS_ENCRYPTION_KEY` is unset/default. Deployments that never set
   `SETTINGS_ENCRYPTION_KEY` were already unable to start; the failure is now
   explicit and at container start.

3. **The published `INTERNAL_API_SECRET` default is now rejected.** The
   `tidal-downloader` and `ytmusic-streamer` sidecars treat the old repo-published
   value `soundspan-internal-secret-change-me` as unconfigured and reject requests
   with 403. If you explicitly set that value, rotate it to a generated secret (same
   value on backend, worker, and both sidecars).

4. **Onboarding no longer generates the encryption key.** The first-registration
   `.env` key-generation path was unreachable dead code (the backend cannot boot
   without a valid key) and has been removed. The single bootstrap story is: set
   `SETTINGS_ENCRYPTION_KEY` before first start.

5. **Postgres and Redis host ports bind to `127.0.0.1` only.** The split stack
   previously published `5432`/`6379` on **all host interfaces** with weak/no
   credentials. Host tooling on the same machine (e.g. `psql -h localhost`) keeps
   working; remote access does not.

6. **`REDIS_FLUSH_ON_STARTUP` image default is now `false`.** The compose files and
   Helm chart already passed `false`; the raw backend image's entrypoint no longer
   defaults to a destructive `FLUSHALL` when the variable is unset. Set
   `REDIS_FLUSH_ON_STARTUP=true` explicitly if you depended on the startup flush.

**Action required — before the next deploy:**

```bash
# Add to your .env (generate a distinct value for each):
SESSION_SECRET=$(openssl rand -base64 32)
SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)   # keep stable forever — encrypted data depends on it
INTERNAL_API_SECRET=$(openssl rand -base64 32)
```

- If you previously ran with an auto-generated per-boot `SESSION_SECRET`, setting a
  stable one invalidates currently issued JWTs exactly once (users re-log-in), then
  sessions survive restarts for the first time.
- If `SETTINGS_ENCRYPTION_KEY` was already set (any deployment that was actually
  running), **keep the existing value** — changing it makes encrypted settings
  (API keys, passwords, 2FA secrets) unreadable.

**Escape hatch — re-publish Postgres/Redis beyond loopback** (for remote host
tooling; prefer keeping loopback). Create a `docker-compose.override.yml` next to
`docker-compose.yml` (Compose merges it automatically):

```yaml
services:
    postgres:
        ports: !override
            - "5432:5432"
    redis:
        ports: !override
            - "6379:6379"
```

(`!override` replaces the loopback binding; omitting it appends a second, additional
binding, which also works. Set a strong `POSTGRES_PASSWORD` before exposing 5432.)

---

### All-in-One (AIO) image hardening: non-root services, generated Postgres password, honored secrets

Routine upgrades need **no manual steps**. Existing named volumes are migrated
automatically on startup, and the Helm chart already supplies the required
filesystem group and first-boot migration budget.

**Service permissions.** The AIO backend, frontend, and both Python analyzers now
run as the fixed `soundspan` user (uid/gid 1000). The entrypoint chowns existing
`/data/cache`, `/data/secrets`, and `/app/backend/logs` paths on every boot. Named
volumes work automatically, and the Helm chart's `fsGroup: 1000` handles pod
volume access. If you bind-mount `/data`, ensure uid/gid 1000 can write it.

**Embedded Postgres.** The former fixed password is replaced by a strong value
generated once and persisted at `/data/secrets/postgres_password`. On an existing
volume, startup synchronizes the database role with `ALTER USER`; no action is
required. Set `POSTGRES_PASSWORD` if you want to pin the value explicitly. The
embedded server now accepts only loopback connections using `scram-sha-256`.

**AIO secrets.** `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, and
`INTERNAL_API_SECRET` now resolve in this order: operator environment → persisted
`/data/secrets` file → freshly generated value. Operator values are written
through to the persisted files, so they remain stable. If you relied on generated
secrets, nothing changes. If you set `SETTINGS_ENCRYPTION_KEY`, keep it stable or
previously encrypted settings become unreadable. `docker-compose.aio.yml` now
forwards `SETTINGS_ENCRYPTION_KEY` and `INTERNAL_API_SECRET` as well as
`SESSION_SECRET`.

**Health behavior.** The container and AIO pod now fail health checks when the
backend or its database dependencies are unavailable, rather than checking only
the frontend. Expect a genuine backend failure to trigger a restart. Helm's new
`startupProbe` gives first-boot migrations a generous window before liveness and
readiness enforcement begins.

---

### ⚠️ Breaking: CORS is deny-by-default and the Lidarr webhook fails closed

Two authorization hardening changes ship secure-by-default with explicit env
opt-outs for deployments that need the old behavior.

#### 1. CORS: unset `ALLOWED_ORIGINS` no longer allows every origin

**Who this affects:** production deployments where the browser loads the
frontend from a DIFFERENT origin than the backend API (e.g. `app.example.com`
calling `api.example.com`) and `ALLOWED_ORIGINS` was never set. The standard
same-origin setup — frontend proxy serving the UI and forwarding `/api` on one
origin — is NOT affected, and neither are server-to-server/curl requests
(no `Origin` header) or `NODE_ENV=development`.

**What changed.** The backend enables CORS with `credentials: true`. Previously,
when `ALLOWED_ORIGINS` was unset, it reflected ANY request origin, which let
arbitrary websites make cookie-authenticated cross-origin requests against your
instance. Production now denies cross-origin browser requests unless the origin
is allowlisted.

**Action required (only for cross-origin deployments):** set
`ALLOWED_ORIGINS` to a comma-separated list of your frontend origins
(e.g. `ALLOWED_ORIGINS=https://app.example.com`). To knowingly restore the
legacy allow-all behavior instead, set `CORS_ALLOW_ALL=true`.

#### 2. Lidarr webhook rejects requests when no secret is configured

**Who this affects:** deployments using the Lidarr integration that never
configured a webhook secret in System Settings.

**What changed.** `POST /api/webhooks/lidarr` previously accepted
unauthenticated requests when no secret was configured (logging a warning),
leaving an unauthenticated endpoint that could drive download-state mutations
and queue library scans. It now returns **401** until a secret is configured
(fail closed). `GET /api/webhooks/lidarr/verify` and the Lidarr-disabled 202
short-circuit are unchanged.

**Action required:** set a webhook secret in System Settings → Lidarr and add
the same value as an `x-webhook-secret` header on Lidarr's webhook connection.
If you cannot do that yet, set `LIDARR_WEBHOOK_ALLOW_UNAUTHENTICATED=true` to
restore the legacy behavior (not recommended).

Also in this release (no action needed): `ADMIN_RESET_PASSWORD` emergency
recovery previously never matched the admin user (role-case bug) — it now works;
ending a Listen Together group is host-only even right after a backend restart;
`POST /api/enrichment/sync` + `/start` are admin-only; and the artist
discovery/preview endpoints require authentication.

---

### TIDAL token header migration + ytmusic-streamer entrypoint change

**Who this affects:** deployments that pin backend and `tidal-downloader` image
versions independently, or customize the `ytmusic-streamer` container user or
`/data` volume permissions.

**What changed.** The backend now sends TIDAL access tokens and account metadata in
headers instead of URL query strings. For this release, the TIDAL sidecar accepts
both the new headers and legacy query credentials, so backend and sidecar images may
roll independently; a deprecation warning in the sidecar logs identifies callers
still using query credentials. Once both images are on this release, there is
nothing to do. The query fallback is removed in the **next release**.

The `ytmusic-streamer` image no longer runs `chmod 777 /data` and no longer sets a
Dockerfile `USER`. Under the plain Docker/Compose default it starts as root, repairs
legacy `/data` ownership, and immediately drops privileges to the `ytmusic` user.
Deployments that force a non-root user, including the chart's Kubernetes security
context or a Compose `user:`, behave exactly as before but must ensure `/data` is
writable by that UID; the chart's existing `fsGroup: 1000` already provides this.
YouTube Music OAuth credential files are now written with owner-only mode `0600`.

**Action required:** a backend from this release or later sends header credentials,
which a `tidal-downloader` image older than this release does not understand — so do
not run a new backend against a pre-this-release TIDAL sidecar image. In the **next
release**, the sidecar drops the query fallback, so backends older than this release
will stop working against it. During this release,
check TIDAL sidecar logs for the deprecation warning and update any custom callers
before the fallback is removed. Custom non-root YouTube Music deployments should
also confirm that their `/data` volume is writable by the configured UID.

---

## 1.9.0: sidecar authentication and Node 24

### ⚠️ Breaking: HTTP sidecars now require `INTERNAL_API_SECRET`

**Who this affects:** any deployment that uses the YouTube Music (`ytmusic-streamer`)
or TIDAL (`tidal-downloader`) FastAPI sidecars — i.e. YouTube URL/library streaming
and downloads, and TIDAL streaming/downloads.

**What changed.** Both HTTP sidecars previously had **zero inbound authentication**
and built filesystem paths from an unvalidated `user_id` (path traversal). They now
require the `x-internal-secret` header on every request and **fail closed**: an unset
or mismatched secret is rejected with **403**. The backend sends the header
(sourced from `INTERNAL_API_SECRET` via `config.ts`) on all four sidecar clients plus
the previously-bare `/user/auth/status` probe. `/health` is exempt so k8s probes and
the backend's own health checks keep working. `ytmusic-streamer` also now rejects a
malformed `user_id` with **400** before any file operation. The FastAPI schema/docs
routes (`/docs`, `/redoc`, `/openapi.json`) are disabled on both sidecars — they were
registered outside the auth dependency's reach and would otherwise disclose the API
schema unauthenticated; they now return **404**.

**Action required — operator pre-deploy checklist:** before the next deploy, confirm
`INTERNAL_API_SECRET` is present on the backend AND both HTTP sidecars
(compose/chart wire it automatically; custom setups must set it manually to the
**same value** on all three) — unset means sidecar calls fail closed with 403 and
YouTube/TIDAL streaming silently stops working. The Helm chart injects it into the
`tidal`/`ytmusic` deployments via `secretKeyRef` into the chart's managed Secret —
the same Secret (named per `soundspan.secretName`, by default the release name) that
already carries `INTERNAL_API_SECRET` for the backend and CLAP analyzer;
`docker-compose.yml` defaults it for both sidecars. The all-in-one image does not bundle the HTTP sidecars — if you run them
alongside an AIO container, set `INTERNAL_API_SECRET` on them to match the value the
AIO persists at `/data/secrets/internal_api_secret`.

---

### Node 24 everywhere — images and CI

**Who this affects:** operators running the published `ghcr.io/soundspan/*`
images — no action; self-builders and anyone running the backend/frontend
directly on a host (not via the published images).

**What changed.** Every Node-based Docker image (backend, backend-worker,
frontend, and the root AIO image) now builds `FROM node:24-bookworm-slim`,
replacing a previous mixed Node 20/24 split. CI's `node-version` pins moved
to `24` across the board to match.

**Action required:** none for operators running the published images — they
already bundle their own Node runtime. Self-builders and host-runners should
build/run with **Node 24** going forward. The root, backend, frontend, and
shared-contract packages now declare `engines.node: ">=24.0.0"`; source
installs on Node 20–23 are no longer supported. Use the repository's `.nvmrc`
to select the same runtime as CI and the published images.

## 1.8.0: native `<audio>`-element engine is now the default playback engine

**Who this affects:** every deployment that does not explicitly set `STREAMING_ENGINE_MODE`.

**What changed.** The native `<audio>`-element playback engine — introduced as the
opt-in `STREAMING_ENGINE_MODE=native` in 1.7.0 — is now the **default** playback
engine for everyone (`DEFAULT_STREAMING_ENGINE_MODE = "native"`), after soaking as
the 1.7.0 opt-in. Deployments with no `STREAMING_ENGINE_MODE` set switch to the
native engine on upgrade. Howler remains fully supported as the gated fallback,
and Android WebView deployments stay auto-pinned to it automatically regardless
of this setting (the established crackling/pop fix there is unchanged). The
container entrypoints and docs now report `native` as the primary default.

**Action required: none to adopt.** To remain on the legacy engine, set
**`STREAMING_ENGINE_MODE=howler`** (frontend/AIO container env; on Helm, the
frontend workload's `frontend.env` map — see the commented
`STREAMING_ENGINE_MODE` example in `charts/soundspan/values.yaml` — or `aio.env`
in AIO mode) and restart the frontend/AIO container.

> See `docs/NATIVE_AUDIO_ENGINE.md` for engine-selection precedence, telemetry
> tags, and rollback details.

---

## 1.6.0: security hardening wave

Everything in this block shipped in **1.6.0**. It is mostly automatic;
the Lidarr and Helm notes below are the ones worth acting on.

### Lidarr webhook hardening — set a webhook secret

**Who this affects:** anyone using the Lidarr integration.

**What changed (no action required to keep working).** `POST /api/webhooks/lidarr`
is now rate-limited, and unmatched download events no longer trigger a full
library scan **each** — bursts are coalesced into a single queued scan, so
external Lidarr imports still show up automatically. The endpoint still works
without a secret, but each unauthenticated call now logs a loud warning.

**Strongly recommended.** Set a **webhook secret** so the endpoint is
authenticated: add `lidarrWebhookSecret` in System Settings, then add the same
value as an `x-webhook-secret` header on the soundspan webhook connection in
Lidarr (Settings → Connections). Once set, the webhook is fail-closed (a
missing/wrong secret is rejected `401`). Until then it remains open but
throttled.

> Note: a future release may make a webhook secret the hard default
> (auto-generated). For now you set it yourself, which avoids any surprise
> breakage of an existing Lidarr connection.

---

### Session cookie `secure` defaults to true in production

**Who this affects:** deploys running with `NODE_ENV=production` **over plain
HTTP** that did **not** set `SECURE_COOKIES`.

**What changed.** The session cookie `secure` flag used to default **off** and
was only enabled by `SECURE_COOKIES=true`. It now defaults to **`secure: true`
when `NODE_ENV=production`** (cookies are only sent over HTTPS), resolved through
`config.ts`. HTTPS deploys behind a reverse proxy gain a safer default with no
action.

**Action required only if** you run production-mode over plain HTTP (e.g. a
local-network deploy without TLS): set **`SECURE_COOKIES=false`**, or sessions
will silently stop working (a `secure` cookie is never sent over HTTP, so login
won't persist). Development mode (`NODE_ENV` unset/`development`) still defaults
to non-secure cookies.

**New, optional — `TRUST_PROXY_HOPS`.** `trust proxy` was hardcoded to `true`
(trust every hop), which lets a client spoof `X-Forwarded-For` to dodge per-IP
rate limits. Set `TRUST_PROXY_HOPS` to your real reverse-proxy depth (usually
`1` behind a single nginx/traefik) for spoof-resistant IP resolution. Left
unset, behavior is unchanged (trust all) so multi-hop Docker/Portainer setups
keep working. Both vars can be passed via the Helm chart's `global.env`.

---

### API keys hashed at rest

**Who this affects:** everyone — transparent, **no immediate action**, no
re-pairing of existing devices.

**What changed.** `ApiKey.key` was stored **verbatim**, so a read-only DB
exposure handed out working credentials. Keys are now stored as a keyed hash
(`hmac:<HMAC-SHA256>`). Validation hashes the presented key and looks it up by
hash, with a **transitional fallback** to a raw-key lookup so keys created
before this release keep working unchanged. New keys are hashed before insert;
the raw value is returned only once at creation.

**Action required: none.** Existing device keys keep authenticating.

**The pepper.** The HMAC pepper resolves from `API_KEY_PEPPER` →
`SETTINGS_ENCRYPTION_KEY` → `ENCRYPTION_KEY` (compat alias) → `SESSION_SECRET`.
By default it uses `SETTINGS_ENCRYPTION_KEY` (stable since F22), so no new
config is required. You may set a dedicated **`API_KEY_PEPPER`** for
defense-in-depth — but once set (or once keys are hashed under the default),
**it must stay stable**: changing the pepper invalidates every hashed key
(those devices would need re-pairing).

> ⚠️ If the pepper falls all the way back to `SESSION_SECRET`, make sure it is
> pinned in your env: `docker-entrypoint.sh` generates an **ephemeral**
> `SESSION_SECRET` when unset, and an ephemeral pepper strands every key hashed
> under it on the next restart. `GET /api/admin/secrets-status` returns
> `apiKeys.pepperFingerprint` (an 8-hex identifier of the pepper *value*) so
> you can confirm the app and the backfill script resolve the same pepper.

> Helm note: `API_KEY_PEPPER` is **not yet auto-generated** by the chart (the
> code falls back to the chart-managed `SETTINGS_ENCRYPTION_KEY`). Adding it to
> the chart's stable-secret generation is a tracked follow-up; set it yourself
> via `secrets`/`existingSecret` if you want a dedicated pepper now.

**Optional — migrate existing plaintext keys.** To remove the last readable
keys (after which the plaintext-lookup fallback can be dropped):

1. Check progress: `GET /api/admin/secrets-status` → `apiKeys.plaintext`.
2. **Back up the database.**
3. With the same pepper the app uses:
   ```sh
   npx tsx scripts/hash-existing-api-keys.ts          # dry run — no writes
   npx tsx scripts/hash-existing-api-keys.ts --apply  # hash plaintext rows
   ```
   Idempotent; already-hashed rows are skipped. Irreversible (can't un-hash).
4. Re-check until `apiKeys.plaintext` is `0`.

---

### Settings encryption: authenticated AES-256-GCM + versioned envelope

**Who this affects:** everyone — but the upgrade is transparent and needs **no
immediate action**.

**What changed.** The settings cipher that protects stored integration
credentials (Lidarr, OAuth tokens, 2FA secrets, Subsonic passwords, etc.) moved
from unauthenticated AES-256-CBC to **authenticated AES-256-GCM** behind a
versioned envelope:

- New values are written as `v2:<salt>:<iv>:<tag>:<ciphertext>`, with a per-value
  `scrypt` key derivation that uses the **full** key entropy (the old path
  truncated the documented 44-char base64 key to 32 chars).
- Decrypting a `v2` value **fails closed**: a tampered/forged ciphertext throws
  instead of being returned as plaintext (the old path returned malformed input
  unchanged — a fail-open hole).
- **Legacy (`v1`/CBC) data still decrypts** under its original key derivation,
  which is deliberately left unchanged. Every save re-writes the value as `v2`,
  so data migrates forward on its own over normal use.

**Action required: none.** Reads and writes keep working across the upgrade.

**Optional — force-migrate all values now.** If you want nothing left on the
legacy cipher (so the legacy read path can eventually be dropped):

1. Check progress: `GET /api/admin/secrets-status` (admin-only) returns how many
   values are still `legacy` vs `v2`.
2. **Back up the database.**
3. Dry-run, then apply, with the same `SETTINGS_ENCRYPTION_KEY` the app uses:
   ```sh
   # in the backend container/workdir
   npx tsx scripts/migrate-settings-to-gcm.ts          # dry run — no writes
   npx tsx scripts/migrate-settings-to-gcm.ts --apply  # re-encrypt v1 -> v2
   ```
   The script is forward-only and idempotent; values it cannot decrypt (e.g. data
   from a previously-lost key) are **left untouched**, never rewritten.
4. Re-check `secrets-status` until `legacy` is `0`.

> Requires a stable `SETTINGS_ENCRYPTION_KEY` (see F22). If your key was rotated
> by a past Helm upgrade, the affected legacy values can't be decrypted — re-enter
> those credentials rather than migrating them.

---

### Helm: chart-managed secrets are now stable across upgrades

**Who this affects:** Helm installs that let the chart auto-generate secrets —
i.e. you did **not** set `secrets.existingSecret` and did **not** pin every
`secrets.*` value in your values.

**What changed.** The chart previously re-rolled `SESSION_SECRET`,
`SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and `POSTGRES_PASSWORD` on
**every** `helm upgrade` (a bare `default (randAlphaNum …)` re-renders each
time). A routine upgrade therefore:

- invalidated every session/JWT (users logged out),
- made all AES-encrypted settings (Lidarr, OAuth, Subsonic, 2FA secrets)
  **undecryptable**, and
- desynced `POSTGRES_PASSWORD` from the already-initialized Postgres data dir.

The chart now looks up the **existing** in-cluster Secret and reuses its values,
generating only on first install. Per key the precedence is: explicit
`values.secrets.*` → value already in the live Secret → freshly generated.

**Action required: none for the upgrade itself** — your live secret values are
now frozen at their current values. This upgrade *stops* the rotation; it does
not change any value.

**If a prior upgrade already rotated your keys** (symptoms: everyone logged out
after an upgrade, or integrations/2FA suddenly blank or throwing decrypt
errors), the data encrypted under the lost `SETTINGS_ENCRYPTION_KEY` is **not
recoverable**. Remediation:

1. Re-enter your Lidarr / OAuth / Subsonic credentials in Settings.
2. Re-enroll 2FA for any affected account.
3. If Postgres won't start after a password rotation, set
   `secrets.postgresPassword` to the password baked into your existing PGDATA
   (or reset it inside the database) so the value matches the initialized data
   dir.

**Strongly recommended going forward:** manage secrets yourself and pin
`secrets.existingSecret` to a Secret you control. That removes the chart from
secret generation entirely and is the most robust setup for upgrades, restores,
and multi-environment installs.

**GitOps / client-side rendering caveat.** The reuse path relies on Helm's
`lookup` function, which only executes against a live cluster during a real
`helm install`/`helm upgrade` (or a `--dry-run=server` render). Tooling that
renders client-side — `helm template | kubectl apply`, Flux's
`helm template` mode, ArgoCD's default Helm rendering — gets `lookup → nil`
and **still regenerates all four secrets on every sync**. If you deploy that
way, you must set `secrets.existingSecret` (or pin every `secrets.*` value);
the chart cannot stabilize generated secrets for you.

> **Verifying the fix on a cluster** (optional, for operators). Server-side
> `lookup` only runs against a live cluster, so `helm template` alone can't
> exercise the reuse path — you need `--dry-run=server` (Helm ≥ 3.13). The
> chart looks up the Secret named `<release>-soundspan` (the chart fullname),
> so for a release named `ss` seed `ss-soundspan`. To confirm in an
> **isolated** namespace:
>
> ```sh
> kubectl create namespace ss-upgrade-check
> kubectl -n ss-upgrade-check create secret generic ss-soundspan \
>   --from-literal=SESSION_SECRET=stable-test-value
> # Server-side dry-run executes lookup against the cluster;
> # SESSION_SECRET must come back as the stored value:
> helm upgrade --install ss charts/soundspan --namespace ss-upgrade-check \
>   --dry-run=server | grep 'SESSION_SECRET:'
> kubectl delete namespace ss-upgrade-check
> ```
>
> A reused `stable-test-value` (rather than a fresh random string) proves the
> upgrade will preserve secrets. Never run this against your production
> namespace — it would print the real secret values.
