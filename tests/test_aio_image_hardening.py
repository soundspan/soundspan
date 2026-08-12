"""Future-contract file tests for hardening the all-in-one image."""

from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "Dockerfile"
HEALTHCHECK = REPO_ROOT / "healthcheck-prod.js"
COMPOSE_FILE = REPO_ROOT / "docker-compose.aio.yml"
CHART_DEPLOYMENT = REPO_ROOT / "charts/soundspan/templates/aio/deployment.yaml"
POSTGRES_CREDENTIALS = REPO_ROOT / "scripts/aio-postgres-credentials.sh"


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


def _assert_operator_secret_precedes_file_read(
    start_script: str, env_name: str, secret_file: str
) -> None:
    """Require an operator-secret branch before the persisted secret is read."""
    condition = re.search(
        rf'if\s+\[\s+-n\s+"\$(?:\{{{env_name}\}}|{env_name})"\s+\]',
        start_script,
    )
    file_read = re.search(rf"cat\s+[\"']?{re.escape(secret_file)}", start_script)
    assert condition is not None, f"missing operator override check for {env_name}"
    assert file_read is not None, f"missing persisted secret read for {env_name}"
    assert condition.start() < file_read.start()


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

    for name in ("backend", "frontend", "audio-analyzer", "audio-analyzer-clap"):
        block = _program_block(supervisor_config, name)
        assert re.search(r"(?m)^user=soundspan\s*$", block), name
        assert not re.search(r"(?m)^user=root\s*$", block), name

    assert re.search(
        r"(?m)^user=postgres\s*$", _program_block(supervisor_config, "postgres")
    )
    assert re.search(
        r"(?m)^user=redis\s*$", _program_block(supervisor_config, "redis")
    )


def test_start_sh_honors_operator_session_secret_env() -> None:
    """Operator-provided secrets must take precedence over persisted values."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    _assert_operator_secret_precedes_file_read(
        start_script, "SESSION_SECRET", "/data/secrets/session_secret"
    )
    _assert_operator_secret_precedes_file_read(
        start_script, "SETTINGS_ENCRYPTION_KEY", "/data/secrets/encryption_key"
    )
    _assert_operator_secret_precedes_file_read(
        start_script, "INTERNAL_API_SECRET", "/data/secrets/internal_api_secret"
    )


def test_start_sh_writes_secrets_through_to_data() -> None:
    """Operator-supplied secrets must be persisted to the data volume."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    assert re.search(r'>\s*"?/data/secrets/session_secret"?', start_script)
    assert re.search(r'>\s*"?/data/secrets/encryption_key"?', start_script)
    assert re.search(r'>\s*"?/data/secrets/internal_api_secret"?', start_script)


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
    for secret_file in (
        "/data/secrets/session_secret",
        "/data/secrets/encryption_key",
        "/data/secrets/internal_api_secret",
    ):
        assert re.search(rf"chmod\s+600\s+{re.escape(secret_file)}\b", start_script)
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


def test_analyzer_tuning_env_is_parameterized() -> None:
    """Analyzer worker and batch tuning must use exported supervisord values."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    supervisor_config = _heredoc(
        dockerfile, "/etc/supervisor/conf.d/soundspan.conf"
    )
    analyzer = _program_block(supervisor_config, "audio-analyzer")
    clap = _program_block(supervisor_config, "audio-analyzer-clap")

    assert 'NUM_WORKERS="2"' not in analyzer
    assert "%(ENV_NUM_WORKERS)s" in analyzer
    assert "%(ENV_BATCH_SIZE)s" in analyzer
    assert re.search(r"%\(ENV_[A-Z0-9_]*WORKERS?[A-Z0-9_]*\)s", clap)


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


def test_no_hf_token_build_secret() -> None:
    """The public CLAP download must not retain a dead build-secret contract."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "hf_token" not in dockerfile
    assert "HF_TOKEN" not in dockerfile
    assert "/run/secrets/hf_token" not in dockerfile
    assert (
        "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
        in dockerfile
    )


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
