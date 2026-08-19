# ruff: noqa: S101
"""Release-gated scale proof for full-stream loudness measurement."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
SCALE_TESTS_DISABLED = os.getenv("SCALE_TESTS") != "1"
FFMPEG_UNAVAILABLE = shutil.which("ffmpeg") is None
LONG_AUDIO_SECONDS = 45 * 60
GENERATION_BUDGET_SECONDS = 180
LOUDNESS_TIMEOUT_SECONDS = 300
TIMEOUT_MARGIN_SECONDS = 120
TEST_TIMEOUT_SECONDS = GENERATION_BUDGET_SECONDS + LOUDNESS_TIMEOUT_SECONDS + TIMEOUT_MARGIN_SECONDS

for import_root in (SERVICE_ROOT, REPOSITORY_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))


def generate_long_tone(target: Path) -> None:
    """Generate a compact 45-minute, 48 kHz FLAC reference tone."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise RuntimeError("ffmpeg disappeared after the scale-test skip guard")
    subprocess.run(  # noqa: S603 -- resolved installed executable and fixed arguments
        [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=0.1*sin(2*PI*997*t):s=48000:d={LONG_AUDIO_SECONDS}",
            "-c:a",
            "flac",
            "-compression_level",
            "0",
            str(target),
        ],
        check=True,
        capture_output=True,
        timeout=GENERATION_BUDGET_SECONDS,
    )


@pytest.mark.skipif(SCALE_TESTS_DISABLED, reason="set SCALE_TESTS=1 to run scale tests")
@pytest.mark.skipif(FFMPEG_UNAVAILABLE, reason="ffmpeg is not installed")
@pytest.mark.timeout(TEST_TIMEOUT_SECONDS, method="thread")
def test_measure_loudness_handles_a_45_minute_tone(tmp_path: Path) -> None:
    """Measure a production-length tone within the five-minute subprocess bound."""
    import loudness

    tone_path = tmp_path / "long-reference-tone.flac"
    generate_long_tone(tone_path)

    started_at = time.monotonic()
    measurement = loudness.measure_loudness(
        str(tone_path),
        LOUDNESS_TIMEOUT_SECONDS,
    )
    elapsed_seconds = time.monotonic() - started_at

    assert measurement is not None
    assert elapsed_seconds < LOUDNESS_TIMEOUT_SECONDS
    assert measurement["loudnessLufs"] == pytest.approx(-23.0, abs=1.5)
