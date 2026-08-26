"""Silently optional local Chromaprint fingerprint computation."""

from __future__ import annotations

import json
import math
import os
import selectors
import shutil
import subprocess
import threading
import time
from typing import TypedDict

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("Fingerprinting")

DEFAULT_FPCALC_TIMEOUT_SECONDS = 120
MIN_FPCALC_TIMEOUT_SECONDS = 1
MAX_FPCALC_TIMEOUT_SECONDS = 3600
MAX_FPCALC_OUTPUT_BYTES = 128 * 1024
MAX_FINGERPRINT_BYTES = 128 * 1024
FPCALC_READ_CHUNK_BYTES = 8192

_missing_binary_logged = False
_missing_binary_lock = threading.Lock()


class Fingerprint(TypedDict):
    """Validated fpcalc values persisted for one track."""

    fingerprint: str
    duration: int


class _FpcalcOutputTooLarge(RuntimeError):
    """Report output that exceeds the configured subprocess byte cap."""


def parse_fpcalc_json(output: str) -> Fingerprint | None:
    """Validate one fpcalc JSON object at the subprocess boundary."""
    try:
        payload: object = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    fingerprint = payload.get("fingerprint")
    duration_value = payload.get("duration")
    if not isinstance(fingerprint, str) or not fingerprint.strip():
        return None
    if len(fingerprint.encode("utf-8")) > MAX_FINGERPRINT_BYTES:
        return None
    if isinstance(duration_value, bool) or not isinstance(duration_value, (int, float)):
        return None
    if not math.isfinite(float(duration_value)):
        return None
    duration = round(duration_value)
    if duration < 1:
        return None
    return {"fingerprint": fingerprint, "duration": duration}


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    """Terminate and reap fpcalc after a local output or deadline violation."""
    process.kill()
    process.wait()


def _read_fpcalc_output(process: subprocess.Popen[bytes], timeout_seconds: int) -> bytes:
    """Read stdout with hard byte and monotonic deadline bounds."""
    if process.stdout is None:
        raise RuntimeError("fpcalc stdout pipe is unavailable")
    deadline = time.monotonic() + timeout_seconds
    output = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        for _ in range(MAX_FPCALC_OUTPUT_BYTES + 2):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                _stop_process(process)
                raise subprocess.TimeoutExpired(process.args, timeout_seconds)
            read_size = min(FPCALC_READ_CHUNK_BYTES, MAX_FPCALC_OUTPUT_BYTES + 1 - len(output))
            chunk = os.read(process.stdout.fileno(), read_size)
            if not chunk:
                process.wait(timeout=max(0.0, deadline - time.monotonic()))
                return bytes(output)
            output.extend(chunk)
            if len(output) > MAX_FPCALC_OUTPUT_BYTES:
                _stop_process(process)
                raise _FpcalcOutputTooLarge
    _stop_process(process)
    raise _FpcalcOutputTooLarge


def _run_fpcalc(command: list[str], timeout_seconds: int) -> tuple[int, bytes]:
    """Run fpcalc while bounding captured output and elapsed time."""
    process = subprocess.Popen(  # noqa: S603 -- resolved executable and fixed arguments
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    output = _read_fpcalc_output(process, timeout_seconds)
    return process.returncode, output


def _log_missing_binary_once() -> None:
    """Emit one process-local warning for the optional executable."""
    global _missing_binary_logged
    with _missing_binary_lock:
        if _missing_binary_logged:
            return
        logger.warning("fpcalc is unavailable; Chromaprint fingerprinting is disabled")
        _missing_binary_logged = True


def compute_fingerprint(
    file_path: str,
    timeout_seconds: int = DEFAULT_FPCALC_TIMEOUT_SECONDS,
) -> Fingerprint | None:
    """Compute a fingerprint without allowing optional work to fail analysis."""
    bounded_timeout = max(
        MIN_FPCALC_TIMEOUT_SECONDS, min(MAX_FPCALC_TIMEOUT_SECONDS, timeout_seconds)
    )
    fpcalc_path = shutil.which("fpcalc")
    if fpcalc_path is None:
        _log_missing_binary_once()
        return None
    try:
        returncode, output = _run_fpcalc([fpcalc_path, "-json", file_path], bounded_timeout)
    except subprocess.TimeoutExpired:
        logger.warning("fpcalc timed out after %s seconds", bounded_timeout)
        return None
    except _FpcalcOutputTooLarge:
        logger.warning("fpcalc output exceeded the %s-byte limit", MAX_FPCALC_OUTPUT_BYTES)
        return None
    except Exception as error:
        logger.warning("fpcalc failed: %s", type(error).__name__)
        return None
    if len(output) > MAX_FPCALC_OUTPUT_BYTES:
        logger.warning("fpcalc output exceeded the %s-byte limit", MAX_FPCALC_OUTPUT_BYTES)
        return None
    if returncode != 0:
        logger.warning("fpcalc failed with exit code %s", returncode)
        return None
    fingerprint = parse_fpcalc_json(output.decode("utf-8", errors="replace"))
    if fingerprint is None:
        logger.warning("fpcalc returned invalid JSON output")
    return fingerprint
