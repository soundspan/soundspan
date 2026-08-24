"""Round-trip coverage for real tiddl metadata and production identity reads."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_FFMPEG_PATH = shutil.which("ffmpeg")
_REAL_TIDDL_METADATA_PROBE = """
from pathlib import Path
from types import SimpleNamespace
import sys

from tiddl.core.metadata import add_track_metadata

track = SimpleNamespace(
    title="Identity Round Trip",
    version=None,
    trackNumber=1,
    volumeNumber=1,
    copyright="",
    artists=[SimpleNamespace(name="Artist")],
    album=SimpleNamespace(title="Album"),
    isrc="",
    bpm=None,
)
add_track_metadata(Path(sys.argv[1]), track, comment="tidal:8675309")
"""


def _generate_silent_audio(path: Path) -> None:
    """Generate a short valid audio file using the requested container codec."""
    assert _FFMPEG_PATH is not None
    codec = "flac" if path.suffix == ".flac" else "aac"
    result = subprocess.run(  # noqa: S603 -- resolved ffmpeg path and code-owned arguments
        [
            _FFMPEG_PATH,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            "0.2",
            "-c:a",
            codec,
            str(path),
        ],
        check=False,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")


def _write_real_tiddl_metadata(path: Path) -> None:
    """Run real tiddl outside the pytest process that owns the suite stub."""
    result = subprocess.run(  # noqa: S603 -- fixed interpreter executes a code-owned probe
        [sys.executable, "-c", _REAL_TIDDL_METADATA_PROBE, str(path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(_FFMPEG_PATH is None, reason="ffmpeg is required for real audio fixtures")
@pytest.mark.parametrize("extension", [pytest.param(".flac"), pytest.param(".m4a")])
def test_real_tiddl_metadata_round_trips_through_production_reader(
    tmp_path: Path, extension: str
) -> None:
    import tidal_downloads

    audio_path = tmp_path / f"identity{extension}"
    _generate_silent_audio(audio_path)
    _write_real_tiddl_metadata(audio_path)

    assert tidal_downloads._read_embedded_tidal_id(audio_path) == 8675309
