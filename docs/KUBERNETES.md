# Kubernetes Deployment Guide

This guide covers Helm-first Kubernetes deployment and key operational constraints.

For reverse proxy and tunnel routing details, see [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md).

## Helm Chart (Recommended)

The chart supports:

- All-in-One mode (single pod)
- Individual mode (separate services)

Published Helm chart reference:

- Repository URL: `https://soundspan.github.io/soundspan`
- Chart name: `soundspan`
- Chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm search repo soundspan/soundspan
```

### All-in-One install

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm install soundspan soundspan/soundspan \
  --set music.persistence.existingClaim=my-music-pvc
```

### Individual mode install

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm install soundspan soundspan/soundspan \
  --set deploymentMode=individual \
  --set music.persistence.existingClaim=my-music-pvc \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true
```

For HA-oriented defaults without configuring many individual switches:

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm install soundspan soundspan/soundspan \
  --set deploymentMode=individual \
  --set haMode.enabled=true \
  --set music.persistence.existingClaim=my-music-pvc
```

See full values reference in [`../charts/soundspan/README.md`](../charts/soundspan/README.md).

## Manual Deployment Notes

Images are published to GHCR.

| Service                          | Image                                                    | Port |
| -------------------------------- | -------------------------------------------------------- | ---- |
| All-in-One (AIO)                 | `ghcr.io/soundspan/soundspan:latest`                     | 3030 |
| Backend                          | `ghcr.io/soundspan/soundspan-backend:latest`             | 3006 |
| Backend Worker (individual mode) | `ghcr.io/soundspan/soundspan-backend-worker:latest`      | —    |
| Frontend                         | `ghcr.io/soundspan/soundspan-frontend:latest`            | 3030 |
| Audio Analyzer                   | `ghcr.io/soundspan/soundspan-audio-analyzer:latest`      | —    |
| Vibe Embedding Provider (DCLAP)  | `ghcr.io/soundspan/soundspan-vibe-provider-dclap:latest` | 8091 |
| TIDAL Sidecar                    | `ghcr.io/soundspan/soundspan-tidal-streamer:latest` (also published as `soundspan-tidal-downloader`) | 8585 |
| YT Music Streamer                | `ghcr.io/soundspan/soundspan-ytmusic-streamer:latest`    | 8586 |

Notes:

- The backend worker image is only used in `deploymentMode: individual`.
- The DCLAP provider is the individual-mode vibe embedding engine. It remains
  default-off; set `vibeProviderDclap.enabled=true` to enable it and automatic
  backend wiring.
- AIO mode still uses the single `ghcr.io/soundspan/soundspan` image.

## Storage Class Guidance (RWX vs RWO)

| Volume          | Access mode | Reason                                                   |
| --------------- | ----------- | -------------------------------------------------------- |
| `music`         | RWX         | Shared across backend, sidecars, analyzers, and providers |
| `downloads`     | RWO         | Compose-only Lidarr add-on; not provisioned by the chart |
| `postgres_data` | RWO         | Single PostgreSQL pod                                    |
| `backend_cache` | RWO         | Backend-local transcode cache                            |
| `backend_logs`  | RWO         | Backend-local logs                                       |
| `tidal_data`    | RWO         | TIDAL sidecar cache/config                               |
| `ytmusic_data`  | RWO         | YouTube Music sidecar cache/token storage                |

RWX support typically requires NFS/CephFS/Longhorn/EFS class support.

## Security Context

The chart separates pod-level and container-level settings:

```yaml
global:
    podSecurityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
            type: RuntimeDefault
    securityContext:
        allowPrivilegeEscalation: false
        capabilities:
            drop: [ALL]
        readOnlyRootFilesystem: false
```

`readOnlyRootFilesystem` defaults to `false`. Enable it only after you provide
writable mounts for every path used by the selected component. The AIO image
runs as root internally due to supervisord orchestration; individual images are
non-root.

## Process and Health Check Notes

| Service                          | Tini (PID 1) | Healthcheck                                                                        |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| Backend                          | Yes          | Liveness: `GET /health/live`, Readiness: `GET /health/ready`                       |
| Backend Worker (individual mode) | Yes          | Liveness: `GET /health/live` on `:3010`, Readiness: `GET /health/ready` on `:3010` |
| Frontend                         | Yes          | Liveness: `GET /health/live`, Readiness: `GET /health/ready`                       |
| TIDAL Sidecar                    | Yes          | `GET /health`                                                                      |
| YT Music Streamer                | Yes          | `GET /health`                                                                      |
| Audio Analyzer                   | No           | Process check                                                                      |
| Vibe Embedding Provider (DCLAP)  | No           | TCP socket on `:8091` (`/health` is exempt from internal auth; TCP probe kept)     |
| AIO                              | Yes          | `GET /` on `:3030`                                                                 |

## Prometheus Scraping

The backend and the dedicated worker expose process-local Prometheus data at
`GET /metrics`. The endpoint requires `Authorization: Bearer <METRICS_TOKEN>`
and returns `401` when the token is missing, invalid, or unset. Each process has
its own registry. Prometheus must scrape every backend and worker pod.

The chart can create Prometheus Operator `ServiceMonitor` resources:

```yaml
metrics:
    serviceMonitor:
        enabled: true
        interval: 30s
        scrapeTimeout: 10s

secrets:
    # Prefer an externally managed Secret in production.
    metricsToken: "replace-with-a-long-random-token"
```

`metrics.serviceMonitor.enabled` defaults to `false`. With
`secrets.existingSecret`, add a `METRICS_TOKEN` key to that Secret before
enabling the ServiceMonitor. The chart-generated Secret creates and preserves
the token automatically.

Do not set `metrics.public=true` or `METRICS_PUBLIC=true` on an internet-routed
service. That opt-out is intended only for isolated private networks. The
starter [Grafana dashboard](observability/grafana-soundspan-prometheus.json)
covers request latency and errors, queue state, cache results, federation syncs,
per-peer federation health, and process resources. See the
[federation alert pack](observability/federation-alerts.md) for example
PrometheusRule definitions and the API-versus-worker metric ownership map.

## Resource Starting Point

| Service             | CPU request (suggested) | CPU limit (suggested) | Memory request | Memory limit |
| ------------------- | ----------------------- | --------------------- | -------------- | ------------ |
| Backend             | 250m                    | 2000m                 | 256Mi          | 1Gi          |
| Backend Worker      | 250m                    | 2000m                 | 256Mi          | 1Gi          |
| Frontend            | 100m                    | 1000m                 | 128Mi          | 512Mi        |
| TIDAL Sidecar       | 100m                    | 2000m                 | 128Mi          | 512Mi        |
| YT Music Streamer   | 100m                    | 1000m                 | 128Mi          | 512Mi        |
| Audio Analyzer      | 500m                    | 4000m                 | 256Mi          | 1536Mi       |
| DCLAP Vibe Provider | —                       | —                     | 1Gi            | 2560Mi       |
| AIO (all-in-one)    | —                       | —                     | 2Gi            | 8Gi          |

Treat these as baseline estimates, then tune per library size and workload. The
chart sets no CPU requests or limits by default. Add them through
`<component>.resources`, such as `backend.resources` or
`audioAnalyzer.resources`. The
AIO container bundles the backend, frontend, Postgres, Redis, the MusicCNN
analyzer, and the CPU-first DCLAP ONNX provider in one pod. The DCLAP provider
vendors a few hundred MB of artifacts instead of the former 2.35 GB torch
checkpoint. The AIO memory limit must cover both analysis runtimes; lower
`aio.resources.limits.memory` only if you disable analysis
(`config.features.audioAnalysis: false`).

## Rollout Hardening (Individual Mode)

Use per-component values to reduce disruption during rolling updates:

- `backend.strategy`, `frontend.strategy`, `backendWorker.strategy`
- `backend.pdb`, `frontend.pdb`, `backendWorker.pdb`
- `backend.topologySpreadConstraints`, `frontend.topologySpreadConstraints`, `backendWorker.topologySpreadConstraints`

Recommended starting point:

- API/frontend replicas `>=2`
- `maxUnavailable: 0` for API/frontend rolling updates
- `pdb.enabled: true` with `minAvailable: 1` for API/frontend
- Use external HA Redis (or Redis Sentinel/cluster) before scaling API/worker replicas; single-pod Redis remains a SPOF.
- Redis HA deployment is operator-managed; the chart/app are designed to consume a provided HA endpoint.
- Keep `LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=true` on backend API pods for cross-pod Listen Together socket fanout.
- Keep `LISTEN_TOGETHER_STATE_SYNC_ENABLED=true` on backend API pods for cross-pod Listen Together in-memory state alignment.
- Keep `LISTEN_TOGETHER_STATE_STORE_ENABLED=true` on backend API pods for authoritative shared Listen Together state in Redis.
- Keep `LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=true` on backend API pods for per-group hot-path mutation serialization.
- Keep `LISTEN_TOGETHER_ALLOW_POLLING=false` on backend/frontend unless sticky sessions are guaranteed.
- Set `LISTEN_TOGETHER_RECONNECT_SLO_MS` to your reconnect target (default `5000`).
- Set `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` to your tolerated skip burst before warning (default `3`).
- Keep `READINESS_REQUIRE_DEPENDENCIES=true` so readiness fails when PostgreSQL/Redis are unhealthy.
- Tune `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` and `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` for probe cadence/latency budgets.

Backend cache/log volumes in individual mode default to PVCs with `ReadWriteOnce`.
For `backend.replicas > 1`, use one of:

- `ReadWriteMany` storage
- explicit shared `existingClaim`
- `type: emptyDir` for ephemeral per-pod cache/log storage
- disable backend cache/log persistence

The chart now fails render early if replicas are scaled with incompatible default PVC access mode.

## Rollback Runbook (Scale-Out Incidents)

If rollout causes elevated errors or reconnect churn:

1. Scale API/frontend back to single replica:
    - `backend.replicas=1`
    - `frontend.replicas=1`
2. Disable dedicated worker split temporarily (optional):
    - `backendWorker.enabled=false`
    - backend returns to `BACKEND_PROCESS_ROLE=all` (chart default behavior)
3. Keep Redis adapter enabled unless specifically debugging:
    - `config.listenTogetherRedisAdapterEnabled=true`
4. Re-run Helm upgrade with known-good image tags and values.

## Staged Rollout Sequence (Recommended)

Use this order to reduce blast radius when moving from single-replica to HA topology:

1. Deploy role-split capable images with existing replica counts unchanged.
2. Enable dedicated worker deployment:
    - `backendWorker.enabled=true`
    - `backend.replicas=1`
    - `backendWorker.replicas=1`
3. Confirm scheduler ownership logs are clean:
    - no sustained `SchedulerClaim/SLO` warnings.
4. Scale backend API to `2` replicas and validate:
    - readiness stable,
    - Listen Together reconnect latency within target.
5. Scale frontend to `2` replicas and re-check SLOs.
6. Increase backend/frontend replicas further only after SLO gates pass.

## Rollout SLO Gate (Required)

Use these SLOs as hard rollout gates for multi-replica backend changes.

| SLO                               | Target                                                                                        | Enforcement                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Listen Together reconnect latency | `<= LISTEN_TOGETHER_RECONNECT_SLO_MS` (default `5000ms`) for normal reconnects during rollout | Backend logs emit `[ListenTogether/SLO] Reconnect latency ...`; fail rollout if warning-level `exceeded target` events are sustained        |
| Scheduler singleton behavior      | No sustained `SchedulerClaim/SLO` warnings                                                    | Backend-worker logs emit `[SchedulerClaim/SLO] ... skipped ... consecutive`; fail rollout if warnings continue after initial startup window |
| Readiness continuity              | API/frontend rollout completes without readiness flapping                                     | `kubectl rollout status` must complete and `kubectl get pods` must show ready replicas without prolonged `0/1` readiness                    |

Suggested checks during rollout:

```bash
# 1) Ensure rollout completed
kubectl -n soundspan rollout status deploy/soundspan-backend --timeout=10m
kubectl -n soundspan rollout status deploy/soundspan-frontend --timeout=10m
kubectl -n soundspan rollout status deploy/soundspan-backend-worker --timeout=10m

# 2) Inspect SLO warning channels (last 15m)
kubectl -n soundspan logs deploy/soundspan-backend --since=15m | grep -E "ListenTogether/SLO.*exceeded target|SchedulerClaim/SLO.*skipped"
kubectl -n soundspan logs deploy/soundspan-backend-worker --since=15m | grep -E "SchedulerClaim/SLO.*skipped"

# 3) Verify ready pods are stable
kubectl -n soundspan get pods -l app.kubernetes.io/component=backend
kubectl -n soundspan get pods -l app.kubernetes.io/component=frontend
kubectl -n soundspan get pods -l app.kubernetes.io/component=backend-worker
```

Or run the packaged helper from repo root:

```bash
./scripts/k8s-rollout-slo-check.sh --namespace soundspan
```

For full HA live validation (preflight + SLO gate + optional rollout restarts):

```bash
# Non-disruptive validation
./scripts/k8s-ha-live-validation.sh \
  --context <your-cluster-context> \
  --namespace soundspan

# Active restart drill (disruptive): restart backend and frontend, then re-check SLOs
./scripts/k8s-ha-live-validation.sh \
  --context <your-cluster-context> \
  --namespace soundspan \
  --restart-backend \
  --restart-frontend
```

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker run/compose deployment modes and release channels
- [Reverse Proxy and Tunnels](REVERSE_PROXY_AND_TUNNELS.md) — Edge routing for split deployments
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment config and security hardening
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container
