"""Pure path and naming coverage for YouTube Music album downloads."""

import sys
import types
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SIDECAR_ROOT.parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from services.common.download_paths import (  # noqa: E402
    require_contained_download_path,
    sanitize_download_relative_path,
    sanitize_path_component,
)

if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from yt_download import (  # noqa: E402
    _build_album_track_candidates,
    build_album_track_paths,
)


@pytest.mark.parametrize("component", ["", ".", "..", "   ", "..."])
def test_sanitize_relative_path_rejects_invalid_components(component: str) -> None:
    with pytest.raises(ValueError, match="output template path"):
        sanitize_download_relative_path(f"Artist/{component}/Track")


def test_sanitize_relative_path_rejects_absolute_path() -> None:
    with pytest.raises(ValueError, match="output template path"):
        sanitize_download_relative_path("/outside/Track")


def test_sanitize_path_component_replaces_reserved_characters() -> None:
    assert sanitize_path_component('A<>:"/\\|?*B') == "A_________B"


def test_containment_rejects_symlink_escape(tmp_path: Path) -> None:
    music = tmp_path / "music"
    outside = tmp_path / "outside"
    music.mkdir()
    outside.mkdir()
    (music / "linked").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        require_contained_download_path(music / "linked" / "track.mp3", music.resolve())


def test_album_track_paths_reject_temporary_symlink_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import yt_download

    music = tmp_path / "music"
    target_parent = music / "Artist" / "Album"
    target_parent.mkdir(parents=True)
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"unchanged")
    (target_parent / "01. Title.0123456789abcdef0123456789abcdef.tmp.mp3").symlink_to(outside)
    monkeypatch.setattr(
        yt_download,
        "uuid4",
        lambda: types.SimpleNamespace(hex="0123456789abcdef0123456789abcdef"),
    )

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        build_album_track_paths(music, "Artist", "Album", 1, "Title", "mp3")

    assert outside.read_bytes() == b"unchanged"


def test_album_track_naming_is_zero_padded_and_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import yt_download

    monkeypatch.setattr(
        yt_download,
        "uuid4",
        lambda: types.SimpleNamespace(hex="0123456789abcdef0123456789abcdef"),
    )
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
    assert tmp_pathname == (
        tmp_path / "Artist_Name/Album_ Name/01. Title_.0123456789abcdef0123456789abcdef.tmp.mp3"
    )


def test_album_track_temp_names_use_full_unique_uuid_and_stay_byte_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import yt_download

    uuid_hexes = iter(
        (
            "0123456789abcdef0123456789abcdef",
            "fedcba9876543210fedcba9876543210",
        )
    )
    monkeypatch.setattr(
        yt_download,
        "uuid4",
        lambda: types.SimpleNamespace(hex=next(uuid_hexes)),
    )
    long_title = "é" * 200

    first = build_album_track_paths(tmp_path, "Artist", "Album", 1, long_title, "mp3")[2]
    second = build_album_track_paths(tmp_path, "Artist", "Album", 1, long_title, "mp3")[2]

    assert first != second
    assert first.name.endswith(".0123456789abcdef0123456789abcdef.tmp.mp3")
    assert second.name.endswith(".fedcba9876543210fedcba9876543210.tmp.mp3")
    assert len(first.name.encode()) <= 255
    assert len(second.name.encode()) <= 255


def test_album_collision_candidates_truncate_utf8_stems_to_255_bytes(tmp_path: Path) -> None:
    planned = tmp_path / f"{'é' * 123}.mp3"

    candidates = _build_album_track_candidates(planned, "video000001")

    assert candidates[1].name.endswith(" [video000001].mp3")
    assert candidates[5].name.endswith(" [video000001-5].mp3")
    assert all(len(candidate.name.encode()) <= 255 for candidate in candidates)
    assert all(candidate.name.encode().decode() == candidate.name for candidate in candidates)
