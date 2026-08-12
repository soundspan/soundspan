import importlib.util
import os
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from services.common.analyzer_env import (
    configure_thread_env,
    get_blocking_socket_timeout,
    get_int_env,
)

THREAD_ENV_KEYS = [
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_MAX_THREADS",
]
TF_ENV_KEYS = [
    "TF_CPP_MIN_LOG_LEVEL",
    "TF_NUM_INTRAOP_THREADS",
    "TF_NUM_INTEROP_THREADS",
]
ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


class FakeRedisClient:
    """Minimal Redis client returned by the recording constructor."""


def _load_analyzer_with_recording_redis(
    monkeypatch: pytest.MonkeyPatch,
    timeout_calls: list[tuple[str, int, int]],
    redis_calls: list[tuple[tuple[Any, ...], dict[str, Any]]],
) -> ModuleType:
    """Load the CLAP analyzer with its heavyweight dependencies isolated."""

    def resolve_timeout(name: str, default: int, *, blocking_timeout: int) -> int:
        timeout_calls.append((name, default, blocking_timeout))
        return 23

    def from_url(*args: Any, **kwargs: Any) -> FakeRedisClient:
        redis_calls.append((args, kwargs))
        return FakeRedisClient()

    torch_stub = ModuleType("torch")
    torch_stub.set_num_threads = lambda _count: None  # type: ignore[attr-defined]
    torch_stub.cuda = type("Cuda", (), {"is_available": staticmethod(lambda: False)})()  # type: ignore[attr-defined]
    torch_stub.device = lambda name: name  # type: ignore[attr-defined]
    redis_stub = ModuleType("redis")
    redis_stub.from_url = from_url  # type: ignore[attr-defined]
    redis_stub.exceptions = type("Exceptions", (), {"ResponseError": Exception})()  # type: ignore[attr-defined]
    psycopg2_stub = ModuleType("psycopg2")
    psycopg2_stub.Error = Exception  # type: ignore[attr-defined]
    extras_stub = ModuleType("psycopg2.extras")
    extras_stub.RealDictCursor = object  # type: ignore[attr-defined]
    pgvector_stub = ModuleType("pgvector")
    pgvector_psycopg2_stub = ModuleType("pgvector.psycopg2")
    pgvector_psycopg2_stub.register_vector = lambda _conn: None  # type: ignore[attr-defined]

    monkeypatch.setenv("SLEEP_INTERVAL", "7")
    monkeypatch.setattr(
        "services.common.analyzer_env.get_blocking_socket_timeout",
        resolve_timeout,
    )
    for name, stub in {
        "librosa": ModuleType("librosa"),
        "requests": ModuleType("requests"),
        "torch": torch_stub,
        "redis": redis_stub,
        "psycopg2": psycopg2_stub,
        "psycopg2.extras": extras_stub,
        "pgvector": pgvector_stub,
        "pgvector.psycopg2": pgvector_psycopg2_stub,
    }.items():
        monkeypatch.setitem(sys.modules, name, stub)

    spec = importlib.util.spec_from_file_location("clap_analyzer_env_test_module", ANALYZER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_get_int_env_reads_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MVR12_TEST_OVERRIDE_INT", "9")
    assert get_int_env("MVR12_TEST_OVERRIDE_INT", 1) == 9


def test_blocking_socket_timeout_default_exceeds_block_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CLAP_REDIS_SOCKET_TIMEOUT", raising=False)

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 10
    assert timeout > 5


def test_blocking_socket_timeout_honors_safe_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "17")

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 17
    assert timeout > 5


def test_blocking_socket_timeout_clamps_unsafe_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "5")

    timeout = get_blocking_socket_timeout(
        "CLAP_REDIS_SOCKET_TIMEOUT",
        default=10,
        blocking_timeout=5,
    )

    assert timeout == 10
    assert timeout > 5


def test_blocking_socket_timeout_rejects_non_positive_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAP_REDIS_SOCKET_TIMEOUT", "0")

    with pytest.raises(ValueError, match="must be positive"):
        get_blocking_socket_timeout(
            "CLAP_REDIS_SOCKET_TIMEOUT",
            default=10,
            blocking_timeout=5,
        )


def test_worker_applies_bounded_socket_timeout_to_queue_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timeout_calls: list[tuple[str, int, int]] = []
    redis_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    module = _load_analyzer_with_recording_redis(monkeypatch, timeout_calls, redis_calls)

    class FakeDatabaseConnection:
        def __init__(self, _url: str) -> None:
            pass

        def connect(self) -> None:
            pass

        def close(self) -> None:
            pass

    stop_event = threading.Event()
    stop_event.set()
    monkeypatch.setattr(module, "DatabaseConnection", FakeDatabaseConnection)

    module.Worker(1, object(), stop_event).start()

    assert timeout_calls == [("CLAP_REDIS_SOCKET_TIMEOUT", 10, 7)]
    assert redis_calls == [((module.REDIS_URL,), {"socket_timeout": 23})]


def test_clap_analyzer_builds_database_url_from_encoded_components(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_USER", "user@:/?#% 雪")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pass@:/?#% 雪")
    monkeypatch.setenv("POSTGRES_DB", "soundspan")

    module = _load_analyzer_with_recording_redis(monkeypatch, [], [])

    assert module.DATABASE_URL == (
        "postgresql://user%40%3A%2F%3F%23%25%20%E9%9B%AA:"
        "pass%40%3A%2F%3F%23%25%20%E9%9B%AA@postgres:5432/soundspan"
    )


def test_clap_analyzer_preserves_explicit_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    explicit_database_url = "postgresql://explicit:raw@external:6432/custom?schema=tenant"
    monkeypatch.setenv("DATABASE_URL", explicit_database_url)
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_USER", "component-user")
    monkeypatch.setenv("POSTGRES_PASSWORD", "component-password")
    monkeypatch.setenv("POSTGRES_DB", "soundspan")

    module = _load_analyzer_with_recording_redis(monkeypatch, [], [])

    assert explicit_database_url == module.DATABASE_URL


def test_clap_analyzer_keeps_database_url_empty_without_all_components(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_USER", "soundspan")
    monkeypatch.delenv("POSTGRES_PASSWORD", raising=False)
    monkeypatch.setenv("POSTGRES_DB", "soundspan")

    module = _load_analyzer_with_recording_redis(monkeypatch, [], [])

    assert module.DATABASE_URL == ""


def test_configure_thread_env_without_tensorflow_sets_only_blas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in THREAD_ENV_KEYS + TF_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    configure_thread_env(threads_per_worker=2, configure_tensorflow=False)

    for key in THREAD_ENV_KEYS:
        assert os.environ[key] == "2"

    for key in TF_ENV_KEYS:
        assert key not in os.environ
