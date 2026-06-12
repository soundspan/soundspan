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


def test_get_int_env_uses_default_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MVR12_TEST_MISSING_INT", raising=False)
    assert get_int_env("MVR12_TEST_MISSING_INT", 11) == 11


def test_get_int_env_raises_value_error_for_invalid_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MVR12_TEST_INVALID_INT", "not-a-number")
    with pytest.raises(ValueError):
        get_int_env("MVR12_TEST_INVALID_INT", 3)


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
