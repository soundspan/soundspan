"""Future-contract file tests for hardening the all-in-one image."""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "Dockerfile"
HEALTHCHECK = REPO_ROOT / "healthcheck-prod.js"
COMPOSE_FILE = REPO_ROOT / "docker-compose.aio.yml"
CHART_DEPLOYMENT = REPO_ROOT / "charts/soundspan/templates/aio/deployment.yaml"
POSTGRES_CREDENTIALS = REPO_ROOT / "scripts/aio-postgres-credentials.sh"
TOKENIZER_SHA256 = {
    "config.json": "9efb9557bc804f2ca6e394486af2e45dfed0b18554909735a99c6220b84e4288",
    "merges.txt": "fe36cab26d4f4421ed725e10a2e9ddb7f799449c603a96e7f29b5a3c82a95862",
    "special_tokens_map.json": "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    "tokenizer.json": "77ef92283d67f0d97e1454909a964afcbfa2019f0fb9f18f8e88d5c25c3ba729",
    "tokenizer_config.json": "377f91458f7729a4574a84c77bdce67dbc3c58c1a345a29bbf8c4eb1307948a3",
    "vocab.json": "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e",
}


def _heredoc(dockerfile: str, target: str) -> str:
    """Return the body of a single-quoted Dockerfile heredoc for target."""
    marker = f"RUN cat > {target} << 'EOF'\n"
    start = dockerfile.index(marker) + len(marker)
    end = dockerfile.index("\nEOF", start)
    return dockerfile[start:end]


def _program_block(supervisor_config: str, name: str) -> str:
    """Return one supervisord program block without adjacent program blocks."""
    match = re.search(
        rf"(?ms)^\[program:{re.escape(name)}\]\n(.*?)(?=^\[program:|\Z)",
        supervisor_config,
    )
    assert match is not None, f"missing supervisord block: {name}"
    return match.group(1)


def _run_blocks(dockerfile: str) -> list[str]:
    """Return top-level Dockerfile RUN instruction blocks."""
    instruction = re.compile(
        r"(?m)^(?:ADD|ARG|CMD|COPY|ENTRYPOINT|ENV|EXPOSE|FROM|HEALTHCHECK|"
        r"LABEL|ONBUILD|RUN|SHELL|STOPSIGNAL|USER|VOLUME|WORKDIR)\b"
    )
    matches = list(instruction.finditer(dockerfile))
    blocks: list[str] = []
    for index, match in enumerate(matches):
        if not match.group(0).startswith("RUN"):
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(dockerfile)
        blocks.append(dockerfile[match.start() : end])
    return blocks


def _secret_resolution_block(start_script: str, secret_directory: Path) -> str:
    """Return the executable AIO critical-secret resolution block."""
    start_marker = "# Resolve application secrets: operator environment, persisted file, generated."
    end_marker = "# Resolve the PostgreSQL URL after its validated password is persisted."
    start = start_script.index(start_marker)
    end = start_script.index(end_marker, start)
    block = start_script[start:end].replace("/data/secrets", str(secret_directory))
    return f"set -euo pipefail\n{block}"


def test_dockerfile_creates_nonroot_app_user() -> None:
    """The AIO image must create the fixed-UID soundspan runtime user."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert re.search(
        r"(?s)\b(?:useradd|adduser)\b.*?(?:-u|--uid)\s+1000\b.*?\bsoundspan\b",
        dockerfile,
    )


def test_supervisord_runs_services_as_nonroot() -> None:
    """Every application service must run as soundspan while stores retain users."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    supervisor_config = _heredoc(
        dockerfile, "/etc/supervisor/conf.d/soundspan.conf"
    )

    for name in ("backend", "frontend", "audio-analyzer", "vibe-provider-dclap"):
        block = _program_block(supervisor_config, name)
        assert re.search(r"(?m)^user=soundspan\s*$", block), name
        assert not re.search(r"(?m)^user=root\s*$", block), name

    assert re.search(
        r"(?m)^user=postgres\s*$", _program_block(supervisor_config, "postgres")
    )
    assert re.search(
        r"(?m)^user=redis\s*$", _program_block(supervisor_config, "redis")
    )


def test_start_sh_honors_operator_secret_env(tmp_path: Path) -> None:
    """Operator-provided secrets must take precedence over persisted values."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")
    replacements = {
        "SESSION_SECRET": ("session_secret", "replacement-session-secret-0000000000"),
        "SETTINGS_ENCRYPTION_KEY": (
            "encryption_key",
            "replacement-settings-key-00000000000",
        ),
        "INTERNAL_API_SECRET": (
            "internal_api_secret",
            "replacement-internal-secret-000000000",
        ),
        "POSTGRES_PASSWORD": ("postgres_password", "replacement-postgres-password"),
    }
    for filename, _value in replacements.values():
        (tmp_path / filename).write_text("persisted-value", encoding="utf-8")
    environment = {
        **os.environ,
        **{name: value for name, (_filename, value) in replacements.items()},
    }

    result = subprocess.run(
        ["bash", "-c", _secret_resolution_block(start_script, tmp_path)],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == 0, result.stderr
    for filename, value in replacements.values():
        secret_file = tmp_path / filename
        assert secret_file.read_text(encoding="utf-8") == value
        assert stat.S_IMODE(secret_file.stat().st_mode) == 0o600
        assert value not in result.stdout
        assert value not in result.stderr
    assert not list(tmp_path.glob("*.tmp.*"))


@pytest.mark.parametrize(
    ("invalid_name", "invalid_value"),
    [
        ("SESSION_SECRET", "short-session-secret"),
        ("SESSION_SECRET", "changeme-generate-secure-key"),
        ("SETTINGS_ENCRYPTION_KEY", "short-settings-key"),
        ("SETTINGS_ENCRYPTION_KEY", "default-encryption-key-change-me"),
        ("INTERNAL_API_SECRET", "short-internal-secret"),
        ("INTERNAL_API_SECRET", "soundspan-internal-secret-change-me"),
    ],
)
def test_invalid_replacement_preserves_persisted_secrets(
    tmp_path: Path, invalid_name: str, invalid_value: str
) -> None:
    """Invalid replacements must fail closed before any persisted secret changes."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")
    persisted = {
        "session_secret": "persisted-session-secret-000000000000",
        "encryption_key": "persisted-settings-key-0000000000000",
        "internal_api_secret": "persisted-internal-secret-00000000000",
    }
    for filename, value in persisted.items():
        (tmp_path / filename).write_text(value, encoding="utf-8")

    environment = {
        **os.environ,
        "SESSION_SECRET": "replacement-session-secret-0000000000",
        "SETTINGS_ENCRYPTION_KEY": "replacement-settings-key-00000000000",
        "INTERNAL_API_SECRET": "replacement-internal-secret-000000000",
        invalid_name: invalid_value,
    }
    result = subprocess.run(
        ["bash", "-c", _secret_resolution_block(start_script, tmp_path)],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )

    assert result.returncode != 0
    assert invalid_name in result.stderr
    assert invalid_value not in result.stdout
    assert invalid_value not in result.stderr
    for filename, value in persisted.items():
        assert (tmp_path / filename).read_text(encoding="utf-8") == value


def test_start_sh_rejects_known_default_secrets() -> None:
    """Startup must fail fast when any published default secret is supplied."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    assert "changeme-generate-secure-key" in start_script
    assert "default-encryption-key-change-me" in start_script
    assert "soundspan-internal-secret-change-me" in start_script
    assert "exit 1" in start_script


def test_secret_files_are_chmod_600() -> None:
    """Persisted secrets and the backend environment file must be owner-only."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    assert re.search(r"chmod\s+700\s+/data/secrets\b", start_script)
    assert re.search(r'chmod\s+600\s+"\$temporary_file"', start_script)
    assert re.search(r'mv\s+-f\s+--\s+"\$temporary_file"\s+"\$secret_file"', start_script)
    for secret_file in (
        "/data/secrets/session_secret",
        "/data/secrets/encryption_key",
        "/data/secrets/internal_api_secret",
        "/data/secrets/postgres_password",
    ):
        assert f"secure_secret_file {secret_file}" in start_script
    assert re.search(
        r"ENVEOF\s*\n\s*chmod\s+600\s+/app/backend/\.env\b", start_script
    )


def test_postgres_password_not_hardcoded_weak() -> None:
    """The AIO database password must be persisted and absent from weak DSNs."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "postgresql://soundspan:soundspan@localhost" not in dockerfile
    assert "/data/secrets/postgres_password" in dockerfile


def test_postgres_listen_localhost_only() -> None:
    """Embedded PostgreSQL must listen only on the container loopback interface."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "listen_addresses='*'" not in dockerfile
    assert re.search(
        r"listen_addresses=(?:'localhost'|127\.0\.0\.1)|"
        r"-c\s+listen_addresses=127\.0\.0\.1",
        dockerfile,
    )


def test_postgres_pg_hba_not_world_open() -> None:
    """Embedded PostgreSQL authentication must be restricted to loopback clients."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "0.0.0.0/0" not in dockerfile
    assert "127.0.0.1/32" in dockerfile


def test_postgres_password_migration_for_existing_volumes() -> None:
    """Startup must synchronize the password for new and existing database users."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")
    credentials_script = POSTGRES_CREDENTIALS.read_text(encoding="utf-8")

    assert re.search(
        r"(?im)^COPY\s+(?:--\S+\s+)*scripts/aio-postgres-credentials\.sh\s+"
        r"/app/aio-postgres-credentials\.sh\s*$",
        dockerfile,
    )
    assert re.search(
        r"(?m)^\s*/app/aio-postgres-credentials\.sh\s+sync-role(?:\s*(?:#.*)?)?$",
        start_script,
    )

    role_absent_branch = re.search(
        r"(?is)\bif\s+!\s+.*?\bpg_roles\b.*?\brolname\s*=\s*['\"]soundspan['\"]"
        r".*?\bthen\b(?P<body>.*?)\bfi\b",
        credentials_script,
    )
    assert role_absent_branch is not None
    assert re.search(
        r"\bCREATE\s+USER\s+soundspan\b",
        role_absent_branch.group("body"),
        re.IGNORECASE,
    )
    assert re.search(
        r"\bALTER\s+USER\s+soundspan\s+WITH\s+PASSWORD\s+:'postgres_password'\s*;",
        credentials_script,
        re.IGNORECASE,
    )


def test_analysis_tuning_env_is_parameterized() -> None:
    """Analysis runtimes must use exported and scoped supervisord values."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    supervisor_config = _heredoc(
        dockerfile, "/etc/supervisor/conf.d/soundspan.conf"
    )
    analyzer = _program_block(supervisor_config, "audio-analyzer")
    provider = _program_block(supervisor_config, "vibe-provider-dclap")

    assert 'NUM_WORKERS="2"' not in analyzer
    assert "%(ENV_NUM_WORKERS)s" in analyzer
    assert "%(ENV_BATCH_SIZE)s" in analyzer
    for pinned_value in (
        "17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971",
        "2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657",
        "200d48f3905ff1f272af5006dd9851f94071a7dde4eafd9c07bc09c5ac65a714",
        "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a",
    ):
        assert pinned_value in dockerfile
    for filename, digest in TOKENIZER_SHA256.items():
        path = f"/app/vibe-provider-dclap/tokenizer/{filename}"
        assert f"{digest}  {path}" in dockerfile
    assert dockerfile.count("sha256sum -c -") == 19
    assert "services/vibe-provider-dclap/LICENSE" in dockerfile
    assert "services/vibe-provider-dclap/NOTICE.md" in dockerfile
    assert 'TRANSFORMERS_OFFLINE="1"' in provider
    assert 'HF_HUB_OFFLINE="1"' in provider
    assert 'TOKENIZERS_PARALLELISM="false"' in provider
    assert "%(ENV_DCLAP_ONNX_INTRA_OP_THREADS)s" in provider
    assert "%(ENV_DCLAP_MODEL_PATH)s" in provider
    assert "%(ENV_DCLAP_TOKENIZER_PATH)s" in provider
    assert "%(ENV_DCLAP_IMAGE_VERSION)s" in provider
    assert "%(ENV_INTERNAL_API_SECRET)s" in provider
    assert "%(ENV_MUSIC_PATH)s" in provider
    assert "DATABASE_URL" not in provider
    assert "REDIS_URL" not in provider


def test_aio_compose_exposes_provider_tuning_defaults() -> None:
    """Allow host-level DCLAP tuning without a Compose override file."""
    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    expected = (
        "VIBE_PROVIDER_URL=${VIBE_PROVIDER_URL:-http://localhost:8092}",
        "MODEL_IDLE_TIMEOUT=${MODEL_IDLE_TIMEOUT:-300}",
        "DCLAP_ONNX_INTRA_OP_THREADS=${DCLAP_ONNX_INTRA_OP_THREADS:-1}",
    )
    for setting in expected:
        assert setting in compose


def test_every_supervisord_env_placeholder_is_exported() -> None:
    """Every supervisord ENV placeholder must be guaranteed before supervisor starts."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")
    before_supervisord = start_script[: start_script.index("/usr/bin/supervisord")]
    placeholders = set(re.findall(r"%\(ENV_([A-Z0-9_]+)\)s", dockerfile))
    start_script_exports = {
        "INTERNAL_API_SECRET",
        "SESSION_SECRET",
        "SETTINGS_ENCRYPTION_KEY",
        "DATABASE_URL",
        "REDIS_URL",
        "MUSIC_PATH",
    }

    for name in placeholders:
        assigned = re.search(
            rf"(?m)^\s*(?:export\s+)?{re.escape(name)}=", before_supervisord
        )
        assert assigned is not None or name in start_script_exports, name


def test_start_sh_maps_aio_tuning_names() -> None:
    """Startup must map deployment tuning names to analyzer runtime variables."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    assert "AUDIO_ANALYSIS_WORKERS" in start_script
    assert "AUDIO_ANALYSIS_BATCH_SIZE" in start_script
    assert "AUDIO_BRPOP_TIMEOUT" in start_script
    assert "AUDIO_MODEL_IDLE_TIMEOUT" in start_script
    assert (
        'export VIBE_PROVIDER_URL="${VIBE_PROVIDER_URL:-http://localhost:8092}"'
        in start_script
    )
    assert "VIBE_PROVIDER_URL=$VIBE_PROVIDER_URL" in start_script


def test_removed_torch_clap_analyzer_is_absent() -> None:
    """The AIO image must contain no torch CLAP analyzer setup or checkpoint."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "audio-analyzer-clap" not in dockerfile
    assert "laion_clap" not in dockerfile.lower()
    assert "laion-clap" not in dockerfile.lower()
    assert "music_audioset" not in dockerfile
    assert "CLAP_NUM_WORKERS" not in dockerfile
    assert "CLAP_REDIS_SOCKET_TIMEOUT" not in dockerfile


def test_apt_update_install_same_layer() -> None:
    """Every apt install must refresh package indexes in the same RUN layer."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    install_blocks = [
        block for block in _run_blocks(dockerfile) if "apt-get install" in block
    ]

    assert install_blocks
    for block in install_blocks:
        assert "apt-get update" in block, block


def test_frontend_startup_not_race_based() -> None:
    """Frontend startup must not depend on an arbitrary fixed sleep."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    supervisor_config = _heredoc(
        dockerfile, "/etc/supervisor/conf.d/soundspan.conf"
    )
    frontend = _program_block(supervisor_config, "frontend")

    assert "sleep 10" not in frontend


def test_healthcheck_observes_backend() -> None:
    """Container health must aggregate frontend and backend readiness."""
    healthcheck = HEALTHCHECK.read_text(encoding="utf-8")

    assert "3030" in healthcheck
    assert "3006" in healthcheck
    assert "/health/ready" in healthcheck


def test_compose_passes_encryption_key_and_internal_secret() -> None:
    """Compose must pass optional operator secrets through with empty defaults."""
    compose = COMPOSE_FILE.read_text(encoding="utf-8")

    assert "SESSION_SECRET=${SESSION_SECRET:-}" in compose
    assert "SETTINGS_ENCRYPTION_KEY=${SETTINGS_ENCRYPTION_KEY:-}" in compose
    assert "INTERNAL_API_SECRET=${INTERNAL_API_SECRET:-}" in compose
    assert "SETTINGS_ENCRYPTION_KEY=${SETTINGS_ENCRYPTION_KEY:?" not in compose
    assert "INTERNAL_API_SECRET=${INTERNAL_API_SECRET:?" not in compose


def test_compose_engine_mode_comment_lists_native() -> None:
    """The compose engine-mode guidance must mention the native runtime option."""
    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    setting = compose.index("STREAMING_ENGINE_MODE")
    nearby_comment = compose[max(0, setting - 300) : setting + 300].lower()

    assert "native" in nearby_comment


def test_chart_probes_use_aggregated_healthcheck() -> None:
    """All chart probes must execute the shared healthcheck after startup gating."""
    deployment = CHART_DEPLOYMENT.read_text(encoding="utf-8")

    assert "/app/healthcheck.js" in deployment
    assert "startupProbe" in deployment
    assert "exec:" in deployment
