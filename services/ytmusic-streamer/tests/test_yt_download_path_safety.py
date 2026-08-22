"""Pure path and naming coverage for YouTube Music album downloads."""

import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from yt_download import (  # noqa: E402
    _require_contained_download_path,
    _sanitize_download_relative_path,
    _sanitize_path_component,
    build_album_track_paths,
)


@pytest.mark.parametrize("component", ["", ".", "..", "   ", "..."])
def test_sanitize_relative_path_rejects_invalid_components(component: str) -> None:
    with pytest.raises(ValueError, match="output template path"):
        _sanitize_download_relative_path(f"Artist/{component}/Track")


def test_sanitize_relative_path_rejects_absolute_path() -> None:
    with pytest.raises(ValueError, match="output template path"):
        _sanitize_download_relative_path("/outside/Track")


def test_sanitize_path_component_replaces_reserved_characters() -> None:
    assert _sanitize_path_component('A<>:"/\\|?*B') == "A_________B"


def test_containment_rejects_symlink_escape(tmp_path: Path) -> None:
    music = tmp_path / "music"
    outside = tmp_path / "outside"
    music.mkdir()
    outside.mkdir()
    (music / "linked").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        _require_contained_download_path(music / "linked" / "track.mp3", music.resolve())


def test_album_track_paths_reject_temporary_symlink_escape(tmp_path: Path) -> None:
    music = tmp_path / "music"
    target_parent = music / "Artist" / "Album"
    target_parent.mkdir(parents=True)
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"unchanged")
    (target_parent / "01. Title.tmp.mp3").symlink_to(outside)

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        build_album_track_paths(music, "Artist", "Album", 1, "Title", "mp3")

    assert outside.read_bytes() == b"unchanged"


def test_album_track_naming_is_zero_padded_and_sanitized(tmp_path: Path) -> None:
    relative, final_path, tmp_pathname = build_album_track_paths(
        tmp_path,
        "Artist/Name",
        "Album: Name",
        1,
        "Title?",
        "mp3",
    )

    assert relative == Path("Artist_Name/Album_ Name/01. Title_.mp3")
    assert final_path == tmp_path / relative
    assert tmp_pathname == tmp_path / "Artist_Name/Album_ Name/01. Title_.tmp.mp3"
