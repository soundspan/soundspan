"""Container hardening and artifact-pin tests for the DCLAP provider."""

from __future__ import annotations

from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")
TOKENIZER_SHA256 = {
    "config.json": "9efb9557bc804f2ca6e394486af2e45dfed0b18554909735a99c6220b84e4288",
    "merges.txt": "fe36cab26d4f4421ed725e10a2e9ddb7f799449c603a96e7f29b5a3c82a95862",
    "special_tokens_map.json": "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    "tokenizer.json": "4e105259baf1a26f1ed8b503ad09678d69d02b6be1c91faa55075a22d5bee148",
    "tokenizer_config.json": "377f91458f7729a4574a84c77bdce67dbc3c58c1a345a29bbf8c4eb1307948a3",
    "vocab.json": "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e",
}


def test_model_artifacts_are_sha256_verified() -> None:
    """Keep all three upstream release pins and fail-build checks together."""
    assert "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971" in DOCKERFILE
    assert "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657" in DOCKERFILE
    assert "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714" in DOCKERFILE
    assert DOCKERFILE.count("sha256sum -c -") == 9


def test_tokenizer_is_commit_pinned_and_runtime_offline() -> None:
    """Vendor the tokenizer from one immutable snapshot with no runtime fallback."""
    assert "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a" in DOCKERFILE
    assert "TRANSFORMERS_OFFLINE=1" in DOCKERFILE
    assert "HF_HUB_OFFLINE=1" in DOCKERFILE
    for filename, digest in TOKENIZER_SHA256.items():
        assert f"{digest}  /app/tokenizer/{filename}" in DOCKERFILE
    assert DOCKERFILE.count("sha256sum -c -") == 9


def test_image_runs_nonroot_with_authenticated_healthcheck() -> None:
    """Retain the non-root runtime and internal-secret probe header."""
    assert "USER dclap" in DOCKERFILE
    assert "X-Internal-Secret: ${INTERNAL_API_SECRET:-}" in DOCKERFILE
    assert "DCLAP_ONNX_INTRA_OP_THREADS=1" in DOCKERFILE


def test_image_contains_agpl_license_and_notice() -> None:
    """Ship the vendored model's license and corresponding-source notice."""
    assert "services/vibe-provider-dclap/LICENSE" in DOCKERFILE
    assert "services/vibe-provider-dclap/NOTICE.md" in DOCKERFILE
