"""Behavioral coverage for the ffmpeg EBU R128 measurement boundary."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from types import ModuleType

import loudness
import pytest

VALID_FFMPEG_OUTPUT = """
ffmpeg diagnostic prefix
[Parsed_loudnorm_0 @ 0x1]
{
    "input_i" : "-18.42",
    "input_tp" : "-1.07",
    "input_lra" : "4.20",
    "input_thresh" : "-28.50",
    "output_i" : "-24.00"
}
"""


def test_parse_loudnorm_output_returns_integrated_loudness_and_true_peak() -> None:
    """Parse the final loudnorm JSON object without depending on ffmpeg."""
    assert loudness.parse_loudnorm_output(VALID_FFMPEG_OUTPUT) == {
        "loudnessLufs": -18.42,
        "truePeakDb": -1.07,
    }


@pytest.mark.parametrize(
    "output",
    [
        "",
        "ffmpeg completed without a JSON summary",
        '{"input_i": "not-a-number", "input_tp": "-1.0"}',
        '{"input_i": "-18.0"}',
        '{"input_i": "-18.0", "input_tp":',
    ],
)
def test_parse_loudnorm_output_rejects_empty_or_malformed_output(output: str) -> None:
    """Reject output that cannot provide both finite measurements."""
    assert loudness.parse_loudnorm_output(output) is None


@pytest.mark.parametrize(
    ("integrated_lufs", "true_peak_db"),
    [
        (-70.01, -1.0),
        (0.01, -1.0),
        (-18.0, -70.01),
        (-18.0, 10.01),
        (float("nan"), -1.0),
        (-18.0, float("inf")),
    ],
)
def test_parse_loudnorm_output_rejects_non_finite_or_out_of_bounds_values(
    integrated_lufs: float,
    true_peak_db: float,
) -> None:
    """Reject values outside the documented sanity bounds."""
    output = f'{{"input_i": "{integrated_lufs}", "input_tp": "{true_peak_db}"}}'
    assert loudness.parse_loudnorm_output(output) is None


def test_measure_loudness_returns_none_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Contain a hung ffmpeg process inside the configured deadline."""

    def timeout(*_args: object, **_kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=7)

    monkeypatch.setattr(loudness.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(loudness.subprocess, "run", timeout)

    assert loudness.measure_loudness("/music/track.flac", 7) is None


def test_measure_loudness_returns_none_on_ffmpeg_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Treat a nonzero ffmpeg exit as an optional measurement failure."""
    completed = subprocess.CompletedProcess(
        args=["ffmpeg"],
        returncode=1,
        stdout="",
        stderr="decode failed",
    )
    monkeypatch.setattr(loudness.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(loudness.subprocess, "run", lambda *_args, **_kwargs: completed)

    assert loudness.measure_loudness("/music/track.flac", 7) is None


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        (None, 120),
        ("invalid", 120),
        ("0", 1),
        ("7200", 3600),
        ("45", 45),
    ],
)
def test_resolve_loudness_timeout_validates_and_bounds_environment_override(
    monkeypatch: pytest.MonkeyPatch,
    configured: str | None,
    expected: int,
) -> None:
    """Use a safe default and absolute bounds for the subprocess timeout."""
    if configured is None:
        monkeypatch.delenv("LOUDNESS_MEASURE_TIMEOUT_SECONDS", raising=False)
    else:
        monkeypatch.setenv("LOUDNESS_MEASURE_TIMEOUT_SECONDS", configured)

    assert loudness.resolve_loudness_timeout_seconds() == expected


def test_audio_analyzer_merges_optional_loudness_measurement(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose the full-stream measurements through the normal analysis result."""
    monkeypatch.setattr(
        loaded_analyzer,
        "measure_loudness",
        lambda _path, _timeout: {"loudnessLufs": -17.6, "truePeakDb": -0.7},
    )
    monkeypatch.setattr(loaded_analyzer, "ESSENTIA_AVAILABLE", False)

    result = loaded_analyzer.AudioAnalyzer().analyze("/music/track.flac")

    assert result["loudnessLufs"] == -17.6
    assert result["truePeakDb"] == -0.7


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
def test_measure_loudness_matches_generated_reference_tone(tmp_path: Path) -> None:
    """Measure a full-length 997 Hz, -20 dBFS peak reference tone."""
    tone_path = tmp_path / "reference-tone.wav"
    ffmpeg_path = shutil.which("ffmpeg")
    assert ffmpeg_path is not None
    subprocess.run(  # noqa: S603 -- skip guard resolved the installed executable
        [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.1*sin(2*PI*997*t):s=48000:d=10",
            str(tone_path),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )

    measurement = loudness.measure_loudness(str(tone_path), 30)

    assert measurement is not None
    assert measurement["loudnessLufs"] == pytest.approx(-23.0, abs=1.0)
