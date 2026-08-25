"""Shared environment parsing and thread-env configuration for analyzers."""

import os

from .environment import env_int


def get_blocking_socket_timeout(
    name: str,
    default: int,
    *,
    blocking_timeout: int,
    safety_margin: int = 5,
) -> int:
    """Read a positive socket timeout that safely exceeds a blocking command."""
    if blocking_timeout <= 0 or safety_margin <= 0:
        raise ValueError("blocking timeout and safety margin must be positive")

    configured_timeout = env_int(name, default)
    if configured_timeout <= 0:
        raise ValueError(f"{name} must be positive")

    return max(configured_timeout, blocking_timeout + safety_margin)


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
