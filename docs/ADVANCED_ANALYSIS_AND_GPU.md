# Advanced Analysis and GPU Guide

This guide covers optional CLAP embeddings and GPU acceleration for analyzer workloads.

## Essentia MusiCNN Platform Matrix

The split analyzer image and the AIO image use the same validated Linux x86-64
runtime matrix:

| Component | Version |
| --- | --- |
| Python | 3.11 (Debian bookworm) |
| TensorFlow Python package | 2.15.1 |
| `essentia-tensorflow` | 2.1b6.dev1389 |
| TensorFlow C runtime embedded in the Essentia wheel | 2.5.0 |
| NumPy | 1.26.4 |
| redis-py | 8.1.0 |

This matrix is intentionally retained. As checked on 2026-08-12, PyPI's newer
[`essentia-tensorflow` 2.1b6.dev1438 release](https://pypi.org/project/essentia-tensorflow/2.1b6.dev1438/#files)
provides CPython 3.14 wheels only; [2.1b6.dev1389](https://pypi.org/project/essentia-tensorflow/2.1b6.dev1389/#files)
remains the newest release with a CPython 3.11 manylinux x86-64 wheel. The
Essentia wheel declares no Python TensorFlow dependency and carries its own
[TensorFlow C 2.5.0 runtime](https://github.com/MTG/essentia/blob/b9fa6cb674ca43dfb94d28d293aeda441c6745db/setup.py#L110-L115),
while TensorFlow 2.15.1 remains the separately locked and inference-validated
Python package.

Treat these versions as one tested deployment set. After changing the analyzer
manifest, regenerate both `services/audio-analyzer/requirements.lock` and
`requirements-aio.lock` using the commands in their headers and validate the
same committed model in both images.

## CLAP Audio Analysis

The CLAP service generates audio embeddings for similarity/vibe workflows.

### Requirements

- PostgreSQL with pgvector (provided by `pgvector/pgvector:pg16`)
- ~2 to 4 GB RAM per worker
- First build downloads CLAP model (~700 MB)

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CLAP_WORKERS` | `2` | Analysis workers |
| `CLAP_THREADS_PER_WORKER` | `1` | CPU threads per worker |
| `CLAP_SLEEP_INTERVAL` | `5` | Queue poll interval (seconds) |
| `CLAP_REDIS_SOCKET_TIMEOUT` | `10` | Redis read timeout (seconds); effective minimum is `CLAP_SLEEP_INTERVAL + 5` |

### Usage

Analyzers are enabled by default in `docker-compose.yml`.

For local host-run development, start analyzer services from local compose profile:

```bash
docker compose -f docker-compose.local.yml --profile audio-analysis up -d
```

When backend runs on host, ensure `INTERNAL_API_SECRET` in `backend/.env` matches compose value so CLAP callbacks are authenticated.

### API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/vibe/similar/:trackId` | GET | Similar tracks for source track |
| `/api/vibe/search` | POST | Text-to-vibe search |
| `/api/vibe/status` | GET | Embedding progress/status |

## GPU Acceleration (Optional)

GPU acceleration speeds up analyzer workloads; CPU-only mode is fully supported.

### Requirements

- NVIDIA GPU with CUDA support
- Host NVIDIA drivers (`nvidia-smi` should work)
- NVIDIA Container Toolkit

### Install NVIDIA Container Toolkit

Fedora / Nobara / RHEL:

```bash
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo && sudo dnf install -y nvidia-container-toolkit && sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

Ubuntu / Debian:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list && sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit && sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

### Verify host setup

```bash
# NVIDIA driver
nvidia-smi

# Container runtime
nvidia-container-runtime --version
```

### Enable GPU

AIO container:

```bash
docker run -d --gpus all -p 3030:3030 -v /path/to/music:/music -v soundspan_data:/data ghcr.io/soundspan/soundspan:latest
```

Compose split stack:

Uncomment the `devices` block under `audio-analyzer` (and optionally `audio-analyzer-clap`) in `docker-compose.yml`:

```yaml
reservations:
  memory: 2G
  devices:
    - driver: nvidia
      count: 1
      capabilities: [gpu]
```

Then restart:

```bash
docker compose up -d
```

### Verify GPU detection

```bash
# MusiCNN analyzer
docker logs soundspan_audio_analyzer 2>&1 | grep -i gpu

# CLAP analyzer
docker logs soundspan_audio_analyzer_clap 2>&1 | grep -i gpu
```

Expected examples: `TensorFlow GPU detected` or `CUDA available: True`.
If logs show CPU-only mode, GPU passthrough is not active.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Analyzer env var reference
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment config and security hardening
