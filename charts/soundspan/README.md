# soundspan Helm Chart

Deploy [soundspan](https://github.com/soundspan/soundspan) — a self-hosted music server with streaming integration — on Kubernetes.

## Deployment Modes

| Mode | Description |
|------|-------------|
| **All-in-One** (default) | Single pod with backend, frontend, PostgreSQL, Redis, and audio analyzer bundled together. Simplest setup — just mount your music library. |
| **Individual** | Separate pods for each service. More flexible scaling, independent upgrades, and the ability to use external PostgreSQL/Redis. |

## Quick Start

### All-in-One (simplest)

```bash
helm install soundspan ./charts/soundspan \
  --set music.persistence.existingClaim=my-music-pvc
```

### Individual Mode

```bash
helm install soundspan ./charts/soundspan \
  --set deploymentMode=individual \
  --set music.persistence.existingClaim=my-music-pvc \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true
```

### Individual Mode With Split API/Worker Roles (recommended for scaling backend replicas)

```bash
helm install soundspan ./charts/soundspan \
  --set deploymentMode=individual \
  --set backend.replicas=2 \
  --set backendWorker.enabled=true \
  --set backendWorker.replicas=1
```

### Individual Mode HA Defaults (single toggle)

```bash
helm install soundspan ./charts/soundspan \
  --set deploymentMode=individual \
  --set haMode.enabled=true
```

When `haMode.enabled=true`, the chart automatically applies HA-oriented defaults:
- backend replicas: `2`
- frontend replicas: `2`
- backend worker enabled: `true`
- backend worker replicas: `2`
- PDBs auto-enabled for backend/frontend/worker when replicas > 1
- backend cache/log volumes auto-fallback to `emptyDir` when RWX PVC is not provided for multi-replica backend
- Listen Together cross-pod runtime guards forced on:
  - Redis adapter
  - state sync
  - authoritative Redis state store
  - mutation locks
  - websocket-only transport (`polling=false`)
- readiness dependency gating forced on (`READINESS_REQUIRE_DEPENDENCIES=true`)

You can still override HA defaults under `haMode.*` (for example `haMode.backendReplicas=3`).

When `backendWorker.enabled=true`, the chart automatically sets:
- backend API pods: `BACKEND_PROCESS_ROLE=api`
- backend worker pod(s): `BACKEND_PROCESS_ROLE=worker`

By default, worker pods use the dedicated worker image:
- `ghcr.io/soundspan/soundspan-backend-worker:<tag>`

That image starts a compiled worker entrypoint (`dist/worker.js`) and avoids
booting the API runtime stack in worker-only pods.

Worker pods also expose an internal health server (default `:3010`) used by
Kubernetes probes:
- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`

### Prometheus metrics

Set `metrics.serviceMonitor.enabled=true` to create Prometheus Operator
ServiceMonitors for backend and enabled backend-worker pods. The default is
disabled. Scrapes use the `METRICS_TOKEN` bearer credential from the chart
Secret. Set `secrets.metricsToken` or provide a `METRICS_TOKEN` key through
`secrets.existingSecret`.

`metrics.public=true` disables scrape authentication. Use it only on an
isolated private network.

For Listen Together in multi-replica backend deployments, `haMode.enabled=true`
is recommended because it auto-applies the required cross-pod guardrails.
If you keep `haMode.enabled=false`, ensure these remain set manually:
- `config.listenTogetherRedisAdapterEnabled=true`
- `config.listenTogetherStateSyncEnabled=true`
- `config.listenTogetherStateStoreEnabled=true`
- `config.listenTogetherMutationLockEnabled=true`
- `config.listenTogetherAllowPolling=false` (unless sticky sessions are guaranteed)
- `config.readinessRequireDependencies=true`

Set `config.listenTogetherReconnectSloMs` to your reconnect target (default
`5000`) and `config.schedulerClaimSkipWarnThreshold` to tune scheduler-claim
SLO warning sensitivity (default `3` consecutive skips).

`deploymentMode: aio` is unchanged and continues to use the single AIO image.

### Rollout Safety Controls (Individual Mode)

Backend, frontend, and backend-worker now expose rollout controls in values:

- `*.strategy` (Deployment strategy; defaults to RollingUpdate with `maxUnavailable: 0`)
- `*.pdb` (optional PodDisruptionBudget)
- `*.topologySpreadConstraints` (optional cross-node spread rules)

Example:

```yaml
backend:
  replicas: 2
  pdb:
    enabled: true
    minAvailable: 1
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: backend
```

When `backend.replicas > 1`, pay attention to backend cache/log persistence:

- `backend.persistence.cache` and `backend.persistence.logs` default to PVC mode with `ReadWriteOnce`
- this is not safe for multi-replica scheduling unless you provide RWX storage
- chart validation now fails early unless one of these is true:
  - access mode is `ReadWriteMany`
  - an explicit `existingClaim` is provided
  - storage type is `emptyDir`
  - persistence is disabled for that volume

Ephemeral (non-persistent) scale-out example:

```yaml
backend:
  replicas: 2
  persistence:
    cache:
      type: emptyDir
    logs:
      type: emptyDir
```

Native covers and transcode artifacts are stored under
`TRANSCODE_CACHE_PATH/../covers` and `TRANSCODE_CACHE_PATH`.
In individual mode, the chart now defaults `TRANSCODE_CACHE_PATH` to:

- `/music/.soundspan/transcodes`

This keeps native covers/transcodes persistent on the music volume even when
`backend.persistence.cache` is `emptyDir` or disabled. If you override
`TRANSCODE_CACHE_PATH`, ensure the target path is durable across pod restarts.

### With Ingress

```bash
helm install soundspan ./charts/soundspan \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=soundspan.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix \
  --set ingress.tls[0].secretName=soundspan-tls \
  --set ingress.tls[0].hosts[0]=soundspan.example.com
```

### With Gateway API

If your cluster uses the [Gateway API](https://gateway-api.sigs.k8s.io/) (Envoy Gateway, Istio, Cilium, etc.) instead of Ingress:

```bash
helm install soundspan ./charts/soundspan \
  --set gateway.enabled=true \
  --set gateway.parentRefs[0].name=my-gateway \
  --set gateway.parentRefs[0].namespace=gateway-system \
  --set gateway.hostnames[0]=soundspan.example.com
```

> **Note:** Only one of `ingress` or `gateway` should be enabled. The Gateway resource itself must already exist — the chart creates only the HTTPRoute.

### Listen Together Socket Routing (Individual Mode)

In `deploymentMode: individual`, Listen Together websocket traffic must reach backend directly:

- Path: `/socket.io/listen-together` (Prefix)
- Upstream: backend service (`:3006`)

This chart now templates that route automatically in both Ingress and Gateway HTTPRoute manifests.

If you put an external reverse proxy or Cloudflare Tunnel in front of your cluster, keep the same path split there too. See:

- [`docs/REVERSE_PROXY_AND_TUNNELS.md`](../../docs/REVERSE_PROXY_AND_TUNNELS.md)

## Configuration

### Secrets

Secrets (SESSION_SECRET, SETTINGS_ENCRYPTION_KEY, INTERNAL_API_SECRET, PostgreSQL credentials) are **auto-generated** if not provided. To supply your own:

```yaml
secrets:
  sessionSecret: "<openssl rand -hex 32>"
  settingsEncryptionKey: "<openssl rand -hex 32>"
  internalApiSecret: "<openssl rand -hex 32>"
  oidcClientSecret: "<OIDC client secret>" # Required only when OIDC is enabled
  postgresPassword: "secure-password"
```

Or use a pre-existing Kubernetes secret:

```yaml
secrets:
  existingSecret: my-soundspan-secrets
```

Expected keys: `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`.
Add `OIDC_CLIENT_SECRET` when OIDC is enabled.

#### OIDC / SSO

Set the public callback URL exactly as it is registered at the identity provider:

```yaml
config:
  localLoginEnabled: true
  oidc:
    enabled: true
    issuerUrl: https://idp.example/realms/soundspan
    clientId: soundspan
    redirectUri: https://soundspan.example/api/auth/oidc/callback
    webBaseUrl: ""
    scopes: openid profile email
    autoProvision: false
    manageRoles: false
    groupsClaim: groups
    adminGroup: ""
    emailClaim: email
    nameClaim: name
    providerName: SSO
secrets:
  oidcClientSecret: "<OIDC client secret>"
```

Keep `localLoginEnabled: true` until SSO works. Set `webBaseUrl` to the web origin when the callback uses a sibling API subdomain or another port. Keep `autoProvision: false` unless a private IdP restricts access to the soundspan application. See [`docs/OIDC_SSO.md`](../../docs/OIDC_SSO.md) for the full setup, topology matrix, and recovery guide.

#### Third-party API keys

Optional integration keys (`config.lidarrApiKey`, `config.audiobookshelfToken`,
`config.lastfmApiKey`, `config.lastfmSharedSecret`, `config.fanartApiKey`,
`config.openaiApiKey`, `config.acoustidApiKey`) are **not**
rendered as plaintext env in pod specs. When the chart manages its own Secret
(default), they are stored in that Secret and injected via `secretKeyRef`.

If you use `existingSecret`, these keys stay plaintext (legacy behavior) unless
you add them to your Secret (`LIDARR_API_KEY`, `AUDIOBOOKSHELF_TOKEN`,
`LASTFM_API_KEY`, `LASTFM_SHARED_SECRET`, `FANART_API_KEY`, `OPENAI_API_KEY`,
`ACOUSTID_API_KEY`) and set:

```yaml
secrets:
  existingSecret: my-soundspan-secrets
  apiKeysInExistingSecret: true
```

#### Pod security

All chart-managed pods run with `seccompProfile: RuntimeDefault`, drop all Linux
capabilities on the application containers, and disable ServiceAccount token
automounting (`global.automountServiceAccountToken: false`). Set it to `true`
only if you add a sidecar that needs Kubernetes API access.
Add `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` when using chart-managed PostgreSQL or host/port external PostgreSQL (not needed if `postgresql.external.url` is set).

### Music Library

The music library volume must be mounted. Options:

```yaml
# Use an existing PVC (recommended)
music:
  persistence:
    existingClaim: my-nfs-music

# Or create a new PVC
music:
  persistence:
    enabled: true
    size: 500Gi
    storageClass: nfs-client
    accessMode: ReadWriteMany   # RWX needed if TIDAL streamer writes to it
```

### Optional Sidecars

Enable TIDAL and YouTube Music streaming:

```yaml
tidalSidecar:
  enabled: true

ytmusicStreamer:
  enabled: true
```

These **sidecars** work in both AIO and Individual modes.
In AIO mode, they run as separate pods alongside the all-in-one container.

#### YouTube downloads and the music volume

When `ytmusicStreamer.enabled` is true, the streamer pod also mounts the
chart's music volume at `/music` (controlled by
`ytmusicStreamer.musicMount.enabled`, default `true`). This is required for
the YouTube URL download-to-library feature: pasted-URL downloads are
written to `YT_DOWNLOAD_DIR` (default `/music/YouTube Downloads`) and
imported by the backend's library scan.

Notes:
- In multi-node clusters the music volume must be **RWX**
  (`ReadWriteMany`), because the backend and ytmusic-streamer pods mount
  it read-write concurrently and may be scheduled on different nodes.
- All `music.persistence` variants are supported (`existingClaim`,
  chart-managed PVC, `hostPath`).
- Setting `ytmusicStreamer.musicMount.enabled: false` disables the mount;
  YouTube downloads then land on the pod's ephemeral filesystem and are
  lost on restart.

### Audio Analyzers (Individual Mode Only)

```yaml
audioAnalyzer:
  enabled: true
```

> Unlike the sidecars above, this analyzer Deployment is only used in Individual mode.
> In AIO mode, audio analysis is built into the single AIO container.

The analyzer always computes local Chromaprint fingerprints. Set
`config.acoustidApiKey` to enable rate-limited AcoustID identity lookups. Leave
it empty to keep lookup silently disabled.

### Vibe Similarity with DCLAP (Individual Mode Only)

The DCLAP provider is the vibe embedding engine. It remains disabled by default,
matching the opt-in posture of the analyzer it replaces. Enable it to activate
vibe similarity features:

```yaml
vibeProviderDclap:
  enabled: true
```

The chart automatically sets `VIBE_PROVIDER_URL` on the backend and on an
enabled backend worker. The generated URL uses the Helm release name and
`vibeProviderDclap.port`. Set a component env value only when routing through a
different provider endpoint:

```yaml
backend:
  env:
    VIBE_PROVIDER_URL: https://vibe-provider.example
```

An explicit `backend.env.VIBE_PROVIDER_URL` or
`backendWorker.env.VIBE_PROVIDER_URL` takes precedence over the generated URL.
The backend worker sets `VIBE_EMBED_CONCURRENCY` from
`backendWorker.vibeEmbedConcurrency`. Its default is twice the configured
`vibeProviderDclap.replicas`, clamped to the backend's supported range of 1 to
32. Set an explicit value when provider capacity or worker replica count calls
for a different ratio; `backendWorker.env.VIBE_EMBED_CONCURRENCY` remains the
highest-precedence per-workload override.
`vibeProviderDclap.env.DCLAP_HTTP_PORT` is reserved; set
`vibeProviderDclap.port` so the provider, Service, probes, and backend URLs use
the same port.
The provider mounts the shared music volume read-only and receives only
`INTERNAL_API_SECRET` from the chart Secret; it does not receive PostgreSQL or
Redis credentials.

The removed `audioAnalyzerClap` value may be absent or explicitly `null`, since
both configure nothing. Any non-null legacy value stops `helm template` and
install/upgrade rendering with migration guidance. `helm lint` does not enforce
this template guard and exits successfully, so render the chart before an
upgrade.

Warning: `helm upgrade --reuse-values` from 2.2 carries the removed
`audioAnalyzerClap.*` map forward and triggers that guard. Use
`--reset-then-reuse-values` with Helm 3.14 or newer, or supply a clean values
file that omits the legacy map. See
[`docs/UPGRADING.md`](../../docs/UPGRADING.md) for the 2.3 migration window and
workload ordering.

### Feature Flags

Coarse feature flags render on the backend, backend-worker, and AIO workloads.
Existing ML/recommendation flags default to `true`. Federation defaults to
`false`. Per-workload `env` maps override these values.

```yaml
config:
  features:
    audioAnalysis: true   # audio analysis queueing, mood buckets, /api/analysis, /api/vibe
    discovery: true       # Discover Weekly cron/processor, /api/discover, /api/recommendations
    autoPlaylists: true   # Made For You mixes, /api/mixes
    federation: false     # scoped peer credentials and /api/federation host API
  federationTombstoneRetentionDays: 90
  federationSyncIntervalMinutes: 15
  providerTrackRetentionDays: 30
  scanFileConcurrency: 3
  catalogPersistence: true
  catalogRetentionDays: 180
```

When a flag is `false`, the backend does not mount the corresponding API
routes (they return `404` with `code: FEATURE_DISABLED`) and skips the
matching background workers.

> `config.features.audioAnalysis` only controls the backend side (queueing and
> consumption of analysis work). The Essentia analyzer Deployment is controlled
> by `audioAnalyzer.enabled`, and vibe embeddings are controlled by
> `vibeProviderDclap.enabled`. When setting
> `config.features.audioAnalysis=false`, also disable those components since no
> new work is queued for them.
>
> In AIO mode analysis runs inside the all-in-one container and is not
> controlled by `audioAnalyzer.enabled` or `vibeProviderDclap.enabled`.
> Setting `config.features.audioAnalysis=false` prevents the provider-backed
> vibe consumer from starting, so it does not drain queued vibe work.

### External Database / Redis (Individual Mode)

```yaml
postgresql:
  enabled: false
  external:
    # Option A: host/port + POSTGRES_* secret values
    host: postgres.example.com
    port: 5432
    # Option B (preferred for managed DBs): full URL with SSL/query params
    # url: "postgresql://user:pass@postgres.example.com:5432/soundspan?sslmode=require"

redis:
  enabled: false
  external:
    # Option A: host/port
    host: redis.example.com
    port: 6379
    # Option B: full URL (auth/TLS supported)
    # url: "rediss://:password@redis.example.com:6380/0"

config:
  # Default is false. Keep false for shared/HA Redis.
  redisFlushOnStartup: false
```

If `config.redisFlushOnStartup` is left unset, it defaults to `false` (recommended for shared/HA Redis and analyzer stream reliability).

For multi-replica backend/frontend deployments, use a highly available Redis endpoint
(managed Redis/Valkey HA, Sentinel, or equivalent). Running scaled API/worker pods
against a single non-HA Redis pod is a known single point of failure.
Redis HA deployment itself is operator-managed; soundspan only consumes the configured endpoint.

### Inject Extra Env Vars From Secret/ConfigMap

Use `envFrom` when you want the container to import variables directly from an existing Secret/ConfigMap.

```yaml
# Global to all containers (AIO + individual services)
global:
  env:
    HTTP_PROXY: http://proxy.internal:3128
    HTTPS_PROXY: http://proxy.internal:3128
  envFrom:
    - secretRef:
        name: soundspan-global-env

# All-in-one mode
aio:
  envFrom:
    - secretRef:
        name: soundspan-aio-extra-env

# Individual mode API/worker
backend:
  envFrom:
    - secretRef:
        name: soundspan-backend-extra-env

backendWorker:
  envFrom:
    - secretRef:
        name: soundspan-worker-extra-env

# Individual mode app services
frontend:
  envFrom:
    - secretRef:
        name: soundspan-frontend-extra-env

audioAnalyzer:
  envFrom:
    - secretRef:
        name: soundspan-audio-analyzer-extra-env

vibeProviderDclap:
  envFrom:
    - secretRef:
        name: soundspan-vibe-provider-dclap-extra-env

tidalSidecar:
  envFrom:
    - secretRef:
        name: soundspan-tidal-extra-env

ytmusicStreamer:
  envFrom:
    - secretRef:
        name: soundspan-ytmusic-extra-env

# Individual mode chart-managed DB/cache services
postgresql:
  envFrom:
    - secretRef:
        name: soundspan-postgresql-extra-env

redis:
  envFrom:
    - secretRef:
        name: soundspan-redis-extra-env
```

Notes:
- `global.env` is rendered into a chart-managed ConfigMap (`<release>-global-env`) and injected via `envFrom` into every container.
- `global.envFrom` is also injected into every container.
- Service-specific `*.envFrom` entries are appended after global sources.

### Environment Variable Precedence and Overrides

Service `*.env` maps support pass-through overrides, including keys that the
chart also sets by default. The reserved
`vibeProviderDclap.env.DCLAP_HTTP_PORT` key is the exception; use
`vibeProviderDclap.port` instead.

For chart-managed containers, precedence is:
- Service `*.env` key/value pairs
- Chart default/generated values (including secret refs and computed URLs)
- `envFrom` sources (`global.env` ConfigMap, `global.envFrom`, then service `*.envFrom`)

Practical implications:
- If you set a key in a service `*.env` map, that value is rendered directly into the Pod `env` list and takes precedence over chart defaults for that key.
- If a key is not set in service `*.env`, the chart falls back to its default/generated behavior.
- `envFrom` remains additive and cannot override keys already present in explicit `env` entries.

This applies to:
- `aio.env`
- `backend.env`
- `backendWorker.env`
- `frontend.env`
- `audioAnalyzer.env`
- `vibeProviderDclap.env`
- `tidalSidecar.env`
- `ytmusicStreamer.env`
- `postgresql.env`
- `redis.env`

### Global Pod Labels, Annotations, and Scheduling Defaults

Use `global.*` to avoid repeating pod metadata and scheduling config on each service:

```yaml
global:
  labels:
    app.kubernetes.io/part-of: media
    team: platform
  podAnnotations:
    prometheus.io/scrape: "true"
  imagePullSecrets:
    - name: regcred
  serviceAccount:
    create: true
    name: ""
    annotations: {}
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  securityContext:
    readOnlyRootFilesystem: false
    allowPrivilegeEscalation: false
  nodeSelector:
    kubernetes.io/arch: amd64
  tolerations: []
  affinity: {}
```

Scheduling precedence:
- Service-specific values (for example `backend.nodeSelector`)
- `global.nodeSelector` / `global.tolerations` / `global.affinity`

`global.imagePullSecrets`, `global.serviceAccount`, `global.podSecurityContext`, and
`global.securityContext` are each single global sources used by all chart-managed pods.

Note: Root-level `serviceAccount`, `podSecurityContext`, `securityContext`,
`nodeSelector`, `tolerations`, `affinity`, and `imagePullSecrets` are no longer
used by this chart.

### Backend Worker Env Vars (Individual Mode)

When `deploymentMode=individual` and `backendWorker.enabled=true`, the chart injects worker env vars automatically. You normally do not need to set these manually.

#### Worker Startup Required

| Env Var | Source | Required | Default |
| --- | --- | --- | --- |
| `DATABASE_URL` | chart-generated (`postgresql`/`postgresql.external`) | Yes | none |
| `REDIS_URL` | chart-generated (`redis`/`redis.external`) | Yes | none |
| `SESSION_SECRET` | chart secret (`SESSION_SECRET`) | Yes | auto-generated if not provided |
| `MUSIC_PATH` | fixed by chart | Yes | `/music` |
| `TRANSCODE_CACHE_PATH` | chart default or `backendWorker.env.TRANSCODE_CACHE_PATH` | Recommended | `/music/.soundspan/transcodes` |
| `BACKEND_PROCESS_ROLE` | `backendWorker.processRole` | Recommended | `worker` |
| `WORKER_HEALTH_PORT` | `backendWorker.health.port` | No | `3010` |

#### Worker Scheduling/Claim Controls

| Env Var | Helm Value | Required | Default |
| --- | --- | --- | --- |
| `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` | `config.schedulerClaimSkipWarnThreshold` | No | `3` |
| `READINESS_REQUIRE_DEPENDENCIES` | `config.readinessRequireDependencies` | No | `true` |
| `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` | `config.readinessDependencyCheckIntervalMs` | No | `5000` |
| `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` | `config.readinessDependencyCheckTimeoutMs` | No | `2000` |
| `DISCOVER_PROCESSOR_LOCK_TTL_MS` | `backendWorker.env.DISCOVER_PROCESSOR_LOCK_TTL_MS` | No | `2700000` |
| `ENRICHMENT_CLAIM_TTL_MS` | `backendWorker.env.ENRICHMENT_CLAIM_TTL_MS` | No | `900000` |
| `MOOD_BUCKET_CLAIM_TTL_MS` | `backendWorker.env.MOOD_BUCKET_CLAIM_TTL_MS` | No | `120000` |
| `TRACK_RECONCILIATION_MAX_ROWS` | `backendWorker.env.TRACK_RECONCILIATION_MAX_ROWS` | No | `10000` |
| `TRACK_RECONCILIATION_TIMEOUT_MS` | `backendWorker.env.TRACK_RECONCILIATION_TIMEOUT_MS` | No | `600000` |

#### Common Optional Worker Feature Vars

| Env Var | Helm Value | Required | Default |
| --- | --- | --- | --- |
| `AUDIO_ANALYSIS_ENABLED` | `config.features.audioAnalysis` | No | `true` |
| `DISCOVERY_ENABLED` | `config.features.discovery` | No | `true` |
| `AUTO_PLAYLISTS_ENABLED` | `config.features.autoPlaylists` | No | `true` |
| `FEDERATION_ENABLED` | `config.features.federation` | No | `false` |
| `SCAN_FILE_CONCURRENCY` | `config.scanFileConcurrency` | No | App default: `3` (chart leaves unset unless configured) |
| `CATALOG_PERSISTENCE` | `config.catalogPersistence` | No | App default: `true` (chart leaves unset unless configured) |
| `CATALOG_RETENTION_DAYS` | `config.catalogRetentionDays` | No | App default: `180` (chart leaves unset unless configured) |
| `FEDERATION_TOMBSTONE_RETENTION_DAYS` | `config.federationTombstoneRetentionDays` | No | `90` |
| `PROVIDER_TRACK_RETENTION_DAYS` | `config.providerTrackRetentionDays` | No | `30` |
| `FEDERATION_SYNC_INTERVAL_MINUTES` | `config.federationSyncIntervalMinutes` | No | `15` |
| `LIDARR_ENABLED` | `config.lidarrEnabled` | No | `false` |
| `LIDARR_URL` | `config.lidarrUrl` | If Lidarr enabled | none |
| `LIDARR_API_KEY` | `config.lidarrApiKey` | If Lidarr enabled | none |
| `LASTFM_API_KEY` | `config.lastfmApiKey` | No | unset |
| `LASTFM_SHARED_SECRET` | `config.lastfmSharedSecret` | For Last.fm scrobbling | unset |
| `FANART_API_KEY` | `config.fanartApiKey` | No | unset |
| `OPENAI_API_KEY` | `config.openaiApiKey` | No | unset |
| `ACOUSTID_API_KEY` | `config.acoustidApiKey` | No | unset; local fingerprinting remains enabled |
| `AUDIOBOOKSHELF_URL` | `config.audiobookshelfUrl` | No | unset |
| `AUDIOBOOKSHELF_TOKEN` | `config.audiobookshelfToken` | If URL set | unset |
| `AUDIOBOOKSHELF_API_KEY` | `backendWorker.env.AUDIOBOOKSHELF_API_KEY` or `backendWorker.envFrom` | If using env-based Audiobookshelf fallback | unset |

You can inject additional values with:
- `backendWorker.env` for direct key/value pairs
- `backendWorker.envFrom` for Secret/ConfigMap `envFrom`

### GPU Acceleration

For audio analysis with NVIDIA GPU:

Requires the [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin)
on the cluster. Enabling GPU adds an `nvidia.com/gpu: <count>` resource limit
and, if set, a pod `runtimeClassName` for clusters that require a non-default
runtime for GPU pods.

```yaml
# AIO mode
aio:
  gpu:
    enabled: true
    count: 1              # nvidia.com/gpu limit
    runtimeClassName: ""  # e.g. "nvidia" if your cluster requires it

# Individual mode
audioAnalyzer:
  gpu:
    enabled: true
    count: 1
    runtimeClassName: ""

```

## All Values

See [values.yaml](values.yaml) for the complete list of configurable values with descriptions.

## Upgrading

Upgrade your existing release in place:

```bash
helm upgrade soundspan ./charts/soundspan -f my-values.yaml
```

## Uninstalling

```bash
helm uninstall soundspan
```

> **Note:** PersistentVolumeClaims are not deleted automatically. Remove them manually if you want to delete all data.
