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
  postgresPassword: "secure-password"
```

Or use a pre-existing Kubernetes secret:

```yaml
secrets:
  existingSecret: my-soundspan-secrets
```

Expected keys: `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`.
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
    accessMode: ReadWriteMany   # RWX needed if TIDAL downloader writes to it
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

### Audio Analyzers (Individual Mode Only)

```yaml
audioAnalyzer:
  enabled: true

audioAnalyzerClap:
  enabled: true
```

> Unlike the sidecars above, these analyzer deployments are only used in Individual mode.
> In AIO mode, audio analysis is built into the single AIO container.

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

audioAnalyzerClap:
  envFrom:
    - secretRef:
        name: soundspan-audio-analyzer-clap-extra-env

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

All service `*.env` maps support pass-through overrides, including keys that the chart also sets by default.

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
- `audioAnalyzerClap.env`
- `tidalSidecar.env`
- `ytmusicStreamer.env`
- `postgresql.env`
- `redis.env`

Example runtime override for iOS Howler lock-screen compatibility:

```yaml
# Individual mode frontend
frontend:
  env:
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: "true"

# AIO mode
aio:
  env:
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: "true"
```

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

#### Common Optional Worker Feature Vars

| Env Var | Helm Value | Required | Default |
| --- | --- | --- | --- |
| `LIDARR_ENABLED` | `config.lidarrEnabled` | No | `false` |
| `LIDARR_URL` | `config.lidarrUrl` | If Lidarr enabled | none |
| `LIDARR_API_KEY` | `config.lidarrApiKey` | If Lidarr enabled | none |
| `LASTFM_API_KEY` | `config.lastfmApiKey` | No | app built-in key if unset |
| `FANART_API_KEY` | `config.fanartApiKey` | No | unset |
| `OPENAI_API_KEY` | `config.openaiApiKey` | No | unset |
| `AUDIOBOOKSHELF_URL` | `config.audiobookshelfUrl` | No | unset |
| `AUDIOBOOKSHELF_TOKEN` | `config.audiobookshelfToken` | If URL set | unset |
| `AUDIOBOOKSHELF_API_KEY` | `backendWorker.env.AUDIOBOOKSHELF_API_KEY` or `backendWorker.envFrom` | If using env-based Audiobookshelf fallback | unset |

You can inject additional values with:
- `backendWorker.env` for direct key/value pairs
- `backendWorker.envFrom` for Secret/ConfigMap `envFrom`

### GPU Acceleration

For audio analysis with NVIDIA GPU:

```yaml
# AIO mode
aio:
  gpu:
    enabled: true

# Individual mode
audioAnalyzer:
  gpu:
    enabled: true

audioAnalyzerClap:
  gpu:
    enabled: true
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
