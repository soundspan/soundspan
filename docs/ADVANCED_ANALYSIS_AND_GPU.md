# Advanced Analysis and GPU Guide

This guide covers DCLAP vibe embeddings and optional GPU acceleration for the
MusiCNN analyzer.

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

## AIO Vibe Embeddings

The AIO image embeds the CPU-first DCLAP ONNX provider on internal port `8092`.
The backend defaults `VIBE_PROVIDER_URL` to `http://localhost:8092` and drives
both text and audio embedding through that provider. The image vendors the three
checked ONNX artifacts and offline tokenizer snapshot, totaling a few hundred
MB, instead of installing torch or downloading the former 2.35 GB checkpoint.
Existing libraries move to the DCLAP embedding space through the backend's
automatic blue/green migration.

## DCLAP Vibe Embeddings

The DCLAP ONNX provider generates text and audio embeddings for similarity and
vibe workflows. It is the default provider in split-stack Compose deployments.
The backend calls it over HTTP through `VIBE_PROVIDER_URL`; the provider does
not need PostgreSQL or Redis credentials.

### Requirements

- CPU-only runtime; GPU passthrough is not supported or required
- Read-only access to the same `/music` library mounted by the backend
- The same `INTERNAL_API_SECRET` used by the backend

### Configuration

| Variable                      | Default                           | Description                                               |
| ----------------------------- | --------------------------------- | --------------------------------------------------------- |
| `VIBE_PROVIDER_URL`           | `http://vibe-provider-dclap:8092` | Provider base URL used by the backend and worker.         |
| `DCLAP_HTTP_PORT`             | `8092`                            | Internal HTTP port; Compose does not publish it.          |
| `DCLAP_ONNX_INTRA_OP_THREADS` | `1`                               | ONNX Runtime intra-operation CPU thread limit.            |
| `DCLAP_MAX_AUDIO_SECONDS`     | `1800`                            | Maximum decoded prefix per track, from 60 to 7200 seconds. |
| `DCLAP_MODEL_IDLE_TIMEOUT`    | `300`                             | Seconds before idle models unload; `0` keeps them loaded. |

The provider streams mel segments through inference and uses
`DCLAP_MAX_AUDIO_SECONDS` as a memory guard; tracks beyond the cap are embedded
from their first N seconds.

### Usage

The provider starts by default with `docker-compose.yml`, and Compose points the
backend and worker at its internal service URL:

```bash
docker compose up -d
docker compose --profile worker up -d
```

Custom and bare-metal deployments must run the `vibe-provider-dclap` service,
mount the library read-only at `/music`, and set `VIBE_PROVIDER_URL` on every
backend process that handles vibe work.

### API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/vibe/similar/:trackId` | GET | Similar tracks for source track |
| `/api/vibe/search` | POST | Text-to-vibe search |
| `/api/vibe/status` | GET | Embedding progress/status |

## GPU Acceleration (Optional)

GPU acceleration applies only to the MusiCNN analyzer. The DCLAP vibe provider
is CPU-only.

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

AIO container (GPU access applies to compatible analyzer workloads; the embedded
DCLAP provider remains CPU-only):

```bash
docker run -d --gpus all -p 3030:3030 -v /path/to/music:/music -v soundspan_data:/data ghcr.io/soundspan/soundspan:latest
```

Compose split stack:

Uncomment the `devices` block under `audio-analyzer` in `docker-compose.yml`:

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
```

Expected example: `TensorFlow GPU detected`.
If logs show CPU-only mode, GPU passthrough is not active.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Analyzer env var reference
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment config and security hardening
