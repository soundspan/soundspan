import os

import pytest

from services.common.analyzer_env import configure_thread_env, get_int_env


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


def test_get_int_env_reads_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MVR12_TEST_OVERRIDE_INT", "9")
    assert get_int_env("MVR12_TEST_OVERRIDE_INT", 1) == 9


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
