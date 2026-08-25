import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from services.common.analyzer_env import (
    configure_thread_env,
    get_blocking_socket_timeout,
)
from services.common.environment import env_float, env_int

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
    """Minimal Redis client used while constructing the worker."""

    def __init__(self) -> None:
        self.registered_scripts: list[str] = []

    def pubsub(self) -> "FakeRedisClient":
        return self

    def subscribe(self, _channel: str) -> None:
        pass

    def register_script(self, script: str) -> Any:
        self.registered_scripts.append(script)
        return lambda **_kwargs: 1


def _load_analyzer_with_recording_redis(
    monkeypatch: pytest.MonkeyPatch,
    timeout_calls: list[tuple[str, int, int]],
    redis_calls: list[tuple[tuple[Any, ...], dict[str, Any]]],
) -> ModuleType:
    """Load the analyzer with isolated Redis and database dependencies."""

    def resolve_timeout(name: str, default: int, *, blocking_timeout: int) -> int:
        timeout_calls.append((name, default, blocking_timeout))
        return 37

    def from_url(*args: Any, **kwargs: Any) -> FakeRedisClient:
        redis_calls.append((args, kwargs))
        return FakeRedisClient()

    redis_stub = ModuleType("redis")
    redis_stub.from_url = from_url  # type: ignore[attr-defined]
    psycopg2_stub = ModuleType("psycopg2")
    extras_stub = ModuleType("psycopg2.extras")
    extras_stub.Json = object  # type: ignore[attr-defined]
    extras_stub.RealDictCursor = object  # type: ignore[attr-defined]
    psycopg2_stub.extras = extras_stub  # type: ignore[attr-defined]

    monkeypatch.setenv("BRPOP_TIMEOUT", "12")
    monkeypatch.setattr(
        "services.common.analyzer_env.get_blocking_socket_timeout",
        resolve_timeout,
    )
    monkeypatch.setitem(sys.modules, "redis", redis_stub)
    monkeypatch.setitem(sys.modules, "psycopg2", psycopg2_stub)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", extras_stub)
    monkeypatch.setitem(sys.modules, "essentia", None)

    spec = importlib.util.spec_from_file_location("audio_analyzer_env_test_module", ANALYZER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_env_int_uses_integer_default_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MVR12_TEST_MISSING_INT", raising=False)
    assert env_int("MVR12_TEST_MISSING_INT", 11) == 11


def test_env_int_raises_value_error_for_invalid_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MVR12_TEST_INVALID_INT", "not-a-number")
    with pytest.raises(ValueError):
        env_int("MVR12_TEST_INVALID_INT", 3)


def test_env_float_accepts_float_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MVR12_TEST_MISSING_FLOAT", raising=False)
    assert env_float("MVR12_TEST_MISSING_FLOAT", 2.5) == 2.5


def test_audio_blocking_socket_timeout_exceeds_brpop_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUDIO_REDIS_SOCKET_TIMEOUT", "30")

    timeout = get_blocking_socket_timeout(
        "AUDIO_REDIS_SOCKET_TIMEOUT",
        default=35,
        blocking_timeout=30,
    )

    assert timeout == 35
    assert timeout > 30


def test_audio_worker_applies_bounded_socket_timeout_to_queue_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timeout_calls: list[tuple[str, int, int]] = []
    redis_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    module = _load_analyzer_with_recording_redis(monkeypatch, timeout_calls, redis_calls)

    worker = module.AnalysisWorker()

    assert timeout_calls == [("AUDIO_REDIS_SOCKET_TIMEOUT", 17, 12)]
    assert redis_calls == [((module.REDIS_URL,), {"socket_timeout": 37})]
    assert isinstance(worker.redis, FakeRedisClient)
    assert len(worker.redis.registered_scripts) == 1
    assert 'redis.call("INCR", KEYS[1])' in worker.redis.registered_scripts[0]


def test_audio_analyzer_builds_database_url_from_encoded_components(
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


def test_audio_analyzer_preserves_explicit_database_url(
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


def test_audio_analyzer_keeps_database_url_empty_without_all_components(
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


def test_configure_thread_env_sets_tf_and_blas_vars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in THREAD_ENV_KEYS + TF_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    configure_thread_env(threads_per_worker=3, configure_tensorflow=True)

    for key in THREAD_ENV_KEYS:
        assert os.environ[key] == "3"

    assert os.environ["TF_CPP_MIN_LOG_LEVEL"] == "2"
    assert os.environ["TF_NUM_INTRAOP_THREADS"] == "3"
    assert os.environ["TF_NUM_INTEROP_THREADS"] == "1"
