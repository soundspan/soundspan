"""Container hardening and artifact-pin tests for the DCLAP provider."""

from __future__ import annotations

from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")


def test_model_artifacts_are_sha256_verified() -> None:
    """Keep all three upstream release pins and fail-build checks together."""
    assert "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971" in DOCKERFILE
    assert "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657" in DOCKERFILE
    assert "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714" in DOCKERFILE
    assert DOCKERFILE.count("sha256sum -c -") == 3


def test_tokenizer_is_commit_pinned_and_runtime_offline() -> None:
    """Vendor the tokenizer from one immutable snapshot with no runtime fallback."""
    assert "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a" in DOCKERFILE
    assert "TRANSFORMERS_OFFLINE=1" in DOCKERFILE
    assert "HF_HUB_OFFLINE=1" in DOCKERFILE


def test_image_runs_nonroot_with_authenticated_healthcheck() -> None:
    """Retain the non-root runtime and internal-secret probe header."""
    assert "USER dclap" in DOCKERFILE
    assert "X-Internal-Secret: ${INTERNAL_API_SECRET:-}" in DOCKERFILE
    assert "DCLAP_ONNX_INTRA_OP_THREADS=1" in DOCKERFILE


def test_image_contains_agpl_license_and_notice() -> None:
    """Ship the vendored model's license and corresponding-source notice."""
    assert "services/vibe-provider-dclap/LICENSE" in DOCKERFILE
    assert "services/vibe-provider-dclap/NOTICE.md" in DOCKERFILE
