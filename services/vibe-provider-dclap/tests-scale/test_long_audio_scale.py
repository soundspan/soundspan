# ruff: noqa: S101
"""Release-gated memory proof for capped, streaming DCLAP preprocessing."""

from __future__ import annotations

import os
import resource
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
MAX_PEAK_RSS_BYTES = 2 * 1024 * 1024 * 1024
PROCESSING_BUDGET_SECONDS = 600

for import_root in (SERVICE_ROOT, REPOSITORY_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))


class CountingSession:
    """Return one fixed embedding without retaining streamed mel tensors."""

    def __init__(self, embedding: object) -> None:
        self.embedding = embedding
        self.calls = 0

    def run(
        self,
        _outputs: list[str] | None,
        _feed: dict[str, object],
    ) -> list[object]:
        """Count one streaming inference call and return the fixed vector."""
        self.calls += 1
        return [self.embedding]


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
        timeout=180,
    )


def expected_segment_count(sample_count: int, segment: int, hop: int) -> int:
    """Return the recipe's overlapping windows plus legacy tail capture."""
    if sample_count <= segment:
        return 1
    full_windows = ((sample_count - segment) // hop) + 1
    last_start = full_windows * hop
    return full_windows + int(last_start < sample_count)


def peak_rss_bytes() -> int:
    """Normalize Linux KiB and macOS byte ru_maxrss values to bytes."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak) if sys.platform == "darwin" else int(peak) * 1024


@pytest.mark.skipif(SCALE_TESTS_DISABLED, reason="set SCALE_TESTS=1 to run scale tests")
@pytest.mark.skipif(FFMPEG_UNAVAILABLE, reason="ffmpeg is not installed")
def test_capped_dclap_preprocessing_streams_a_45_minute_tone(
    tmp_path: Path,
) -> None:
    """Keep the capped streaming path below the 2 GiB regression ceiling."""
    import numpy as np
    import settings
    from inference import run_audio_chunks
    from preprocessing import (
        SEGMENT_HOP_SAMPLES,
        SEGMENT_SAMPLES,
        load_segmented_log_mels,
    )

    assert settings.MAX_AUDIO_SECONDS == 1800
    tone_path = tmp_path / "long-dclap-tone.flac"
    generate_long_tone(tone_path)
    embedding = np.ones((1, settings.EMBEDDING_DIM), dtype=np.float32)
    session = CountingSession(embedding)

    started_at = time.monotonic()
    vector = run_audio_chunks(
        session,
        load_segmented_log_mels(str(tone_path)),
    )
    elapsed_seconds = time.monotonic() - started_at
    expected = expected_segment_count(
        settings.MAX_AUDIO_SECONDS * settings.SAMPLE_RATE_HZ,
        SEGMENT_SAMPLES,
        SEGMENT_HOP_SAMPLES,
    )

    assert session.calls == expected
    assert len(vector) == settings.EMBEDDING_DIM
    assert elapsed_seconds < PROCESSING_BUDGET_SECONDS
    assert peak_rss_bytes() < MAX_PEAK_RSS_BYTES
