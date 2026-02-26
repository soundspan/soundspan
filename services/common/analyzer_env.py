"""Shared environment parsing and thread-env configuration for analyzers."""

import os
from typing import Union


def get_int_env(name: str, default: Union[int, str]) -> int:
    """Read an integer env var with the same semantics as int(os.getenv(...))."""
    return int(os.getenv(name, str(default)))


def configure_thread_env(
    threads_per_worker: int,
    *,
    configure_tensorflow: bool = False,
) -> None:
    """Apply consistent thread-limit environment variables for analyzer services."""
    thread_count = str(threads_per_worker)

    if configure_tensorflow:
        # Must be set before TensorFlow/Essentia imports initialize TF runtime.
        os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
        os.environ["TF_NUM_INTRAOP_THREADS"] = thread_count
        os.environ["TF_NUM_INTEROP_THREADS"] = "1"

    os.environ["OMP_NUM_THREADS"] = thread_count
    os.environ["OPENBLAS_NUM_THREADS"] = thread_count
    os.environ["MKL_NUM_THREADS"] = thread_count
    os.environ["NUMEXPR_MAX_THREADS"] = thread_count
