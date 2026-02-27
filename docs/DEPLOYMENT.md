# Deployment Guide

This guide covers Docker-based deployment options and standard runtime operations.

For Kubernetes deployments, see [`KUBERNETES.md`](KUBERNETES.md).
For reverse proxy/tunnel routing, see [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md).
For container-by-container environment variables (required/optional, defaults, and purpose), see [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md).

## Important: Frontend Build-Time Environment Variables

In production frontend images, `NEXT_PUBLIC_*` values are compiled into the browser bundle at image build time.

- Runtime changes to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_PATH_MODE`, or `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` on a pre-published image do not change browser behavior.
- For pre-published images, use reverse-proxy path routing for backend API traffic:
  - route `/api/*` to backend (`:3006`)
  - route app pages/assets to frontend (`:3030`)
- Keep frontend runtime `BACKEND_URL` pointed at backend so frontend proxy routes can reach the API.
- In Helm individual mode, the chart injects `BACKEND_URL` to the in-cluster backend service by default, sets `NEXT_PUBLIC_API_URL` to an empty string (equivalent to unset for prebuilt image behavior), and mirrors `LISTEN_TOGETHER_ALLOW_POLLING` into `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` (still subject to build-time behavior in prebuilt images).

If you need a different `NEXT_PUBLIC_*` behavior, build a custom frontend image with your desired build args.

## Quick Start

### One-command install (AIO container)

```bash
docker run -d \
  --name soundspan \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v soundspan_data:/data \
  ghcr.io/soundspan/soundspan:latest
```

Open `http://localhost:3030` and create your account.

### AIO with GPU acceleration (optional)

Requires NVIDIA Container Toolkit. See [`ADVANCED_ANALYSIS_AND_GPU.md`](ADVANCED_ANALYSIS_AND_GPU.md).

```bash
docker run -d \
  --name soundspan \
  --gpus all \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v soundspan_data:/data \
  ghcr.io/soundspan/soundspan:latest
```

## Compose File Matrix

| File | Purpose | Typical command |
| --- | --- | --- |
| `docker-compose.aio.yml` | All-in-one (AIO) soundspan container (frontend+backend+db+redis bundled) | `docker compose -f docker-compose.aio.yml up -d` |
| `docker-compose.yml` | Split stack (frontend, backend, postgres, redis, sidecars, analyzers) with deployment-safe canonical ports and optional worker profile | `docker compose -f docker-compose.yml up -d` |
| `docker-compose.override.ha.yml` | HA-focused override for split stack (`backend` API role, dynamic backend host-port for scale-out, worker profile ready) | `docker compose -f docker-compose.yml -f docker-compose.override.ha.yml --profile worker up -d` |
| `docker-compose.services.yml` | Optional external Lidarr service layered onto either stack above | `docker compose -f docker-compose.yml -f docker-compose.services.yml up -d` |
| `docker-compose.local.yml` | Local npm/tsx host-run dependencies only (postgres+redis; optional analyzer profile), using +1 collision-avoidance ports | `docker compose -f docker-compose.local.yml up -d postgres-local redis-local` |
| `docker-compose.override.lite-mode.yml` | Optional override to disable analyzers in split stack | `cp docker-compose.override.lite-mode.yml docker-compose.override.yml && docker compose up -d` |
| `docker-bake.json` | Docker Buildx Bake file for building images by group (core/db/external/analysis/aio) | `docker buildx bake core` |

Deployment defaults in compose files use canonical ports:

- Frontend: `3030 -> 3030`
- Backend: `3006 -> 3006`
- PostgreSQL: `5432 -> 5432`
- Redis: `6379 -> 6379`

For local host-run development, use +1 ports to avoid collisions:

```bash
docker compose -f docker-compose.local.yml up -d postgres-local redis-local
cd backend && PORT=3007 npm run dev
cd frontend && PORT=3031 BACKEND_URL=http://127.0.0.1:3007 NEXT_PUBLIC_API_URL=http://127.0.0.1:3007 NEXT_PUBLIC_API_PATH_MODE=direct npm run dev
```

### Local host-run guardrails (ports + testing)

- Treat `3030`/`3006` as potentially occupied by a live/local deployment. For local host-run validation and E2E, use `3031`/`3007`.
- `auto` mode uses frontend proxy routing by default; set `BACKEND_URL=http://127.0.0.1:3007` so proxied API calls reach the correct backend in host-run local dev.
- If you want direct browser-to-backend calls in host-run dev, set both `NEXT_PUBLIC_API_URL=http://127.0.0.1:3007` and `NEXT_PUBLIC_API_PATH_MODE=direct`.
- For Playwright against host-run stack, pin the UI base URL explicitly:

```bash
SOUNDSPAN_UI_BASE_URL=http://127.0.0.1:3031 npm --prefix frontend run test:predeploy
```

- On constrained machines, prefer targeted Playwright chunks with one worker before full suites:

```bash
SOUNDSPAN_UI_BASE_URL=http://127.0.0.1:3031 npx --prefix frontend playwright test tests/e2e/predeploy/social-history.spec.ts --workers=1
```

## Compose Multi-Replica Notes (Split Stack)

The AIO image is a single-container topology. For replica scaling, use `docker-compose.yml`.

Recommended role split:

- `backend` service: API role (`BACKEND_PROCESS_ROLE=api`)
- `backend-worker` service: worker role (enabled via `--profile worker`)

Example (2 API replicas + 1 worker):

```bash
BACKEND_PROCESS_ROLE=api BACKEND_PORT=0 \
docker compose -f docker-compose.yml --profile worker up -d \
  --scale backend=2 \
  --scale backend-worker=1
```

Equivalent using HA override:

```bash
BACKEND_PORT=0 docker compose -f docker-compose.yml -f docker-compose.override.ha.yml \
  --profile worker up -d \
  --scale backend=2 \
  --scale backend-worker=1
```

Notes:

- `BACKEND_PORT=0` avoids fixed host-port collisions when scaling backend replicas on one Docker host.
- Worker-required env var reference is documented in [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md#backend-worker-environment-variables-complete-reference).
- Keep `LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=true`, `LISTEN_TOGETHER_STATE_SYNC_ENABLED=true`, and `LISTEN_TOGETHER_STATE_STORE_ENABLED=true` for cross-replica Listen Together behavior.
- Keep `LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=true` for per-group playback/queue/ready write serialization across replicas.
- Keep `LISTEN_TOGETHER_ALLOW_POLLING=false` (default) unless your load balancer guarantees sticky sessions.
- `LISTEN_TOGETHER_RECONNECT_SLO_MS` (default `5000`) controls reconnect-latency warning threshold.
- `SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD` (default `3`) controls consecutive scheduler-claim skip warnings.
- Keep `READINESS_REQUIRE_DEPENDENCIES=true` so readiness fails fast on PostgreSQL/Redis outages.
- Tune `READINESS_DEPENDENCY_CHECK_INTERVAL_MS` and `READINESS_DEPENDENCY_CHECK_TIMEOUT_MS` for dependency probe cadence/timeouts.
- For frontend replicas `>1`, put a reverse proxy/load balancer in front and route app traffic to the frontend service; fixed host-port publishing on each replica is not a safe scale pattern.
- Redis remains critical for sessions/queues/realtime; use a highly available Redis endpoint for HA-focused deployments.
- Compose defaults now set `REDIS_FLUSH_ON_STARTUP=false` to preserve Redis stream/group metadata unless you explicitly override it.

## Experimental Features

Segmented streaming documentation has been moved to a dedicated experimental guide:

- [`EXPERIMENTAL_SEGMENTED_STREAMING.md`](EXPERIMENTAL_SEGMENTED_STREAMING.md)

Use that guide for segmented runtime controls, rollout levels, observability, and primary-mode reversion procedures.

## Building Images with Docker Bake

The repository includes a `docker-bake.json` file that defines all buildable images organized into groups. This is an alternative to `docker compose build` when you want fine-grained control over which images to build, or want to leverage BuildKit parallelism across targets.

### Prerequisites

Docker Buildx is required (included by default with Docker Desktop and recent Docker Engine installs):

```bash
docker buildx version
```

### Groups

| Group | Targets | Description |
| --- | --- | --- |
| `default` | frontend, backend, backend-worker, tidal-downloader, ytmusic-streamer, audio-analyzer, audio-analyzer-clap | All buildable split-stack images |
| `core` | frontend, backend, backend-worker | Application services only |
| `db` | postgres, redis | Tags upstream images locally (pgvector/pgvector:pg16, redis:7-alpine) |
| `external` | tidal-downloader, ytmusic-streamer | Streaming sidecars |
| `analysis` | audio-analyzer, audio-analyzer-clap | ML audio analysis services |
| `aio` | soundspan-aio | All-in-one container |

### Usage

Build a specific group:

```bash
# Build core application images (frontend + backend + worker)
docker buildx bake core

# Build streaming sidecars only
docker buildx bake external

# Build everything (all split-stack images)
docker buildx bake

# Build the all-in-one image
docker buildx bake aio
```

Build a single target:

```bash
docker buildx bake frontend
docker buildx bake backend
docker buildx bake audio-analyzer-clap
```

Build multiple groups at once:

```bash
docker buildx bake core external analysis
```

Override tags (useful for pushing to a registry):

```bash
docker buildx bake core --set '*.tags=ghcr.io/soundspan/soundspan-frontend:1.0.0' --set frontend.tags=ghcr.io/soundspan/soundspan-frontend:1.0.0
```

Override frontend build args:

```bash
docker buildx bake frontend \
  --set 'frontend.args.NEXT_PUBLIC_BUILD_TYPE=release' \
  --set 'frontend.args.NEXT_PUBLIC_LOG_LEVEL=warn'
```

Dry run (print resolved build configuration without building):

```bash
docker buildx bake --print core
```

### Using bake with Compose

You can continue using `docker compose up -d` after building with bake — Compose will use the locally tagged images if they match. To ensure Compose uses your bake-built images instead of rebuilding, reference the image tags in your `.env` or compose override.

### Notes

- The `db` group tags upstream images locally (`pgvector/pgvector:pg16` and `redis:7-alpine`). These are not custom builds — the group exists for completeness so you can pre-pull and tag them in air-gapped or CI environments.
- The `backend` and `backend-worker` targets share the same Dockerfile (`backend/Dockerfile`) but use different build stages (`api-runtime` and `worker-runtime` respectively).
- The `core` group is the most common choice for local development builds.

## Updating a Deployment

```bash
docker compose pull
docker compose up -d
```

## Maintainer Release Flow (Images + Helm Chart)

Use semantic versions without a `v` prefix (example: `1.6.0`).

1. Prepare all release version surfaces in one command:

```bash
npm run release:prepare -- --version 1.6.0
```

This updates and verifies:
- `frontend/package.json` + `frontend/package-lock.json`
- `backend/package.json` + `backend/package-lock.json`
- `charts/soundspan/Chart.yaml` (`version` + `appVersion`)
- `charts/soundspan/values.yaml` image tags for release images

It also validates hard-coded package names:
- `soundspan-frontend`
- `soundspan-backend`

2. Commit and push the release prep:

```bash
git add frontend/package.json frontend/package-lock.json backend/package.json backend/package-lock.json charts/soundspan/Chart.yaml charts/soundspan/values.yaml
git commit -m "chore(release): prepare 1.6.0"
git push origin main
```

3. Generate release notes from the previous release tag to the release tag:

```bash
npm run release:notes -- --version 1.6.0 --from 1.5.0 --to 1.6.0 --output /tmp/soundspan-1.6.0-release-notes.md
```

Helm release reference for notes and operator docs:
- chart repo URL: `https://soundspan.github.io/soundspan`
- chart name: `soundspan`
- chart reference: `soundspan/soundspan`

4. Publish the GitHub release with the same tag:

```bash
gh release create 1.6.0 --target main --notes-file /tmp/soundspan-1.6.0-release-notes.md
```

Publishing the release triggers:
- All Docker image workflows (release-tagged images in GHCR)
- Helm chart publishing to `gh-pages`

The Helm chart workflow waits until all required release-tagged images exist in GHCR before publishing chart artifacts.

## Release Channels

### Stable (recommended)

```bash
docker pull ghcr.io/soundspan/soundspan:latest
# or specific version
docker pull ghcr.io/soundspan/soundspan:X.Y.Z
```

### Main channel (development)

```bash
docker pull ghcr.io/soundspan/soundspan:main
```

Main-channel builds may be unstable and are not recommended for production.
If you need deterministic rollbacks, use immutable `main-<sha>` tags.

## Linux bind-mount note for `/data`

Named volumes are recommended. If you bind-mount `/data`, ensure required subdirectories exist and are writable:

```bash
mkdir -p /path/to/soundspan-data/postgres /path/to/soundspan-data/redis
```

If startup logs show permission errors, `chown` the host path to the UID/GID shown in logs.

## What the AIO container includes

- Web interface (port `3030`)
- API server (internal)
- PostgreSQL database (internal)
- Redis cache (internal)

---

## See also

- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Secret handling, external access, and security hardening
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container
- [Integrations Guide](INTEGRATIONS.md) — Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL setup
- [Kubernetes Guide](KUBERNETES.md) — Helm and manual Kubernetes deployment
- [Reverse Proxy and Tunnels](REVERSE_PROXY_AND_TUNNELS.md) — Edge routing for split deployments
- [Advanced Analysis and GPU](ADVANCED_ANALYSIS_AND_GPU.md) — CLAP analysis and GPU acceleration
