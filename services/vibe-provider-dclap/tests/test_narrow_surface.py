"""Trust-surface regression tests for the HTTP-only DCLAP provider."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_runtime_modules_import_without_database_or_redis_packages() -> None:
    """Import the service while actively rejecting DB and Redis imports."""
    service_root = Path(__file__).resolve().parents[1]
    repository_root = service_root.parents[1]
    script = """
import builtins
original_import = builtins.__import__

def guarded_import(name, *args, **kwargs):
    if name.partition('.')[0] in {'psycopg2', 'redis'}:
        raise AssertionError(f'forbidden import: {name}')
    return original_import(name, *args, **kwargs)

builtins.__import__ = guarded_import
import http_server
import inference
import model_provider
import music_path
import preprocessing
"""
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(service_root), str(repository_root)))

    result = subprocess.run(  # noqa: S603 -- fixed interpreter executes a code-owned probe
        [sys.executable, "-c", script],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr
