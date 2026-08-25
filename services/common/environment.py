"""Shared environment-value parsing for Python sidecars."""

from __future__ import annotations

import os


def env_int(name: str, default: int | str) -> int:
    """Parse an integer env var using an integer or string default value."""
    return int(os.getenv(name, str(default)))


def env_float(name: str, default: float | int | str) -> float:
    """Parse a float env var using a numeric or string default value."""
    return float(os.getenv(name, str(default)))
