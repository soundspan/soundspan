"""
Unit tests for the pure /yt/ download helpers in yt_download.py.

The helpers are kept in a standalone module (no yt-dlp / FastAPI imports)
so these tests run without the sidecar's heavy runtime dependencies.
"""

import sys
from pathlib import Path
from typing import Any

import pytest

# app.py imports fastapi/ytmusicapi at module scope, so tests import the
# pure helper module directly from the sidecar directory instead.
SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from yt_download import (  # noqa: E402
    ACTIVE_DOWNLOAD_STATUSES,
    PROXY_AUDIO_FORMAT_SELECTORS,
    YT_PLAYER_CLIENTS,
    build_playlist_entries,
    build_tag_rewrite_command,
    bulk_album_metadata,
    classify_youtube_url,
    derive_proxy_audio_container,
    extract_video_id,
    find_active_download_job,
    find_existing_download,
    resolve_download_filepath,
)

VIDEO_ID = "dQw4w9WgXcQ"


# ── bulk_album_metadata (collapse a CHANNEL to one artist) ──────────


def test_bulk_album_metadata_channel_sets_artist_albumartist_and_album() -> None:
    assert bulk_album_metadata("Book Club Radio", "channel") == {
        "artist": "Book Club Radio",
        "album_artist": "Book Club Radio",
        "album": "Book Club Radio",
    }


def test_bulk_album_metadata_channel_strips_whitespace() -> None:
    assert bulk_album_metadata("  Book Club Radio  ", "channel") == {
        "artist": "Book Club Radio",
        "album_artist": "Book Club Radio",
        "album": "Book Club Radio",
    }


def test_bulk_album_metadata_playlist_preserves_native_metadata() -> None:
    # Playlists are curated, often multi-artist — never collapse to one artist.
    assert bulk_album_metadata("Best of 2024", "playlist") is None


@pytest.mark.parametrize("kind", [None, "video", "mix", "unknown"])
def test_bulk_album_metadata_only_collapses_channels(kind: Any) -> None:
    # Anything other than an explicit channel is left as native metadata.
    assert bulk_album_metadata("Some Title", kind) is None


@pytest.mark.parametrize("source", [None, "", "   ", 123, []])
def test_bulk_album_metadata_none_for_blank_or_nonstring(source: Any) -> None:
    assert bulk_album_metadata(source, "channel") is None


# ── build_tag_rewrite_command (ffmpeg tag rewrite, parser-safe) ─────


def test_build_tag_rewrite_command_stream_copies_and_keeps_metadata() -> None:
    cmd = build_tag_rewrite_command(
        "/music/yt/track.opus",
        {"artist": "Book Club Radio"},
        "/music/yt/track.tagtmp.opus",
    )
    assert cmd[0] == "ffmpeg"
    # input file, then stream-copy, then preserve existing tags
    assert cmd[cmd.index("-i") + 1] == "/music/yt/track.opus"
    assert cmd[cmd.index("-c") + 1] == "copy"
    assert cmd[cmd.index("-map_metadata") + 1] == "0"
    # temp output (same extension) is the final arg
    assert cmd[-1] == "/music/yt/track.tagtmp.opus"
    # the tag is rendered as a -metadata key=value pair
    assert cmd[cmd.index("artist=Book Club Radio") - 1] == "-metadata"


def test_build_tag_rewrite_command_emits_one_metadata_pair_per_tag_in_order() -> None:
    cmd = build_tag_rewrite_command(
        "in.flac",
        {"artist": "A", "album_artist": "A", "album": "A"},
        "tmp.flac",
    )
    pairs = [cmd[i + 1] for i, tok in enumerate(cmd) if tok == "-metadata"]
    assert pairs == ["artist=A", "album_artist=A", "album=A"]


# ── extract_video_id ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VIDEO_ID}",
        f"https://youtube.com/watch?v={VIDEO_ID}",
        f"https://m.youtube.com/watch?v={VIDEO_ID}",
        f"https://www.youtube.com/watch?list=PL123&v={VIDEO_ID}&t=42s",
        f"https://youtu.be/{VIDEO_ID}",
        f"https://youtu.be/{VIDEO_ID}?t=10",
        f"https://www.youtube.com/embed/{VIDEO_ID}",
        f"https://www.youtube.com/v/{VIDEO_ID}",
        f"https://www.youtube.com/shorts/{VIDEO_ID}",
        VIDEO_ID,
        f"  {VIDEO_ID}  ",
    ],
)
def test_extract_video_id_variants(url: Any) -> None:
    assert extract_video_id(url) == VIDEO_ID


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=tooshort",
        "not a url at all",
        "",
    ],
)
def test_extract_video_id_rejects_invalid(url: Any) -> None:
    with pytest.raises(ValueError):
        extract_video_id(url)


# ── YT_PLAYER_CLIENTS (regular-YouTube extractor clients) ───────────


def test_yt_player_clients_excludes_broken_bare_android() -> None:
    # The bare "android" InnerTube client is PO-token-gated and returns no
    # usable audio formats, so it must not be used for regular-YouTube
    # extraction (it made /yt/info 502 with "Requested format is not
    # available"). The list must be non-empty and only name working clients.
    assert YT_PLAYER_CLIENTS, "at least one player client is required"
    assert "android" not in YT_PLAYER_CLIENTS
    assert "android_vr" in YT_PLAYER_CLIENTS
    assert all(isinstance(client, str) and client for client in YT_PLAYER_CLIENTS)


# ── find_existing_download (idempotency check) ──────────────────────


def test_find_existing_download_matches_bracketed_id(tmp_path: Path) -> None:
    target = tmp_path / f"Some DJ Set [{VIDEO_ID}].mp3"
    target.write_bytes(b"audio")

    assert find_existing_download(str(tmp_path), VIDEO_ID) == str(target)


def test_find_existing_download_ignores_non_audio_extensions(tmp_path: Path) -> None:
    (tmp_path / f"Some DJ Set [{VIDEO_ID}].jpg").write_bytes(b"thumb")

    assert find_existing_download(str(tmp_path), VIDEO_ID) is None


def test_find_existing_download_no_char_class_false_positive(tmp_path: Path) -> None:
    # Regression: the old pattern f"*[{video_id}].*" treated [..] as a glob
    # character class, so any file ending in one of the id's characters
    # matched. "mix-Q.mp3" ends with "Q", which is inside the class.
    (tmp_path / "mix-Q.mp3").write_bytes(b"audio")

    assert find_existing_download(str(tmp_path), VIDEO_ID) is None


def test_find_existing_download_handles_glob_chars_in_dir(tmp_path: Path) -> None:
    weird_dir = tmp_path / "music [archive]"
    weird_dir.mkdir()
    target = weird_dir / f"Track [{VIDEO_ID}].opus"
    target.write_bytes(b"audio")

    assert find_existing_download(str(weird_dir), VIDEO_ID) == str(target)


def test_find_existing_download_missing_dir_returns_none(tmp_path: Path) -> None:
    assert find_existing_download(str(tmp_path / "nope"), VIDEO_ID) is None


# ── resolve_download_filepath ───────────────────────────────────────


def test_resolve_filepath_from_requested_downloads(tmp_path: Path) -> None:
    final = tmp_path / f"Title [{VIDEO_ID}].mp3"
    final.write_bytes(b"audio")
    info = {"requested_downloads": [{"filepath": str(final)}]}

    assert resolve_download_filepath(info, "mp3") == str(final)


def test_resolve_filepath_accounts_for_extract_audio_extension(tmp_path: Path) -> None:
    # yt-dlp may record the pre-postprocessing media path (e.g. .webm);
    # FFmpegExtractAudio replaces the extension with the requested format.
    recorded = tmp_path / f"Title [{VIDEO_ID}].webm"
    converted = tmp_path / f"Title [{VIDEO_ID}].mp3"
    converted.write_bytes(b"audio")
    info = {"requested_downloads": [{"filepath": str(recorded)}]}

    assert resolve_download_filepath(info, "mp3") == str(converted)


def test_resolve_filepath_falls_back_to_legacy_keys(tmp_path: Path) -> None:
    final = tmp_path / f"Title [{VIDEO_ID}].m4a"
    final.write_bytes(b"audio")
    info = {"filepath": str(final)}

    assert resolve_download_filepath(info, "m4a") == str(final)


def test_resolve_filepath_returns_none_when_nothing_exists(tmp_path: Path) -> None:
    info = {"requested_downloads": [{"filepath": str(tmp_path / "missing.webm")}]}

    assert resolve_download_filepath(info, "mp3") is None


def test_resolve_filepath_handles_bad_info() -> None:
    assert resolve_download_filepath(None, "mp3") is None
    assert resolve_download_filepath({}, "mp3") is None
    assert resolve_download_filepath({"requested_downloads": "x"}, "mp3") is None


# ── derive_proxy_audio_container ────────────────────────────────────
# The container hint must be derived from the SAME format selection and
# acodec mapping the /yt/ stream proxy uses, otherwise the player gets a
# decode hint that does not match the bytes served.


def test_proxy_selectors_cover_all_qualities() -> None:
    assert set(PROXY_AUDIO_FORMAT_SELECTORS) == {
        "LOW",
        "MEDIUM",
        "HIGH",
        "LOSSLESS",
    }
    # The proxy's default quality — /yt/info extracts with this selector.
    assert PROXY_AUDIO_FORMAT_SELECTORS["HIGH"] == "ba[abr<=256]/ba"


def test_derive_proxy_audio_container_opus_maps_to_webm() -> None:
    assert derive_proxy_audio_container({"acodec": "opus"}) == "webm"


def test_derive_proxy_audio_container_aac_maps_to_mp4() -> None:
    assert derive_proxy_audio_container({"acodec": "mp4a.40.2"}) == "mp4"
    assert derive_proxy_audio_container({"acodec": "aac"}) == "mp4"


def test_derive_proxy_audio_container_uses_selected_format_not_best_abr() -> None:
    # The selected (top-level) acodec wins even when a higher-abr opus
    # format exists in the formats list — mirrors the proxy, which maps
    # Content-Type from the selected format's acodec only.
    info = {
        "acodec": "mp4a.40.2",
        "formats": [
            {"acodec": "opus", "vcodec": "none", "abr": 999, "ext": "webm"},
        ],
    }
    assert derive_proxy_audio_container(info) == "mp4"


def test_derive_proxy_audio_container_defaults_to_mp4() -> None:
    assert derive_proxy_audio_container({}) == "mp4"
    assert derive_proxy_audio_container({"acodec": None}) == "mp4"
    assert derive_proxy_audio_container(None) == "mp4"
    assert derive_proxy_audio_container("nope") == "mp4"


# ── find_active_download_job (in-flight dedupe) ─────────────────────
# POST /yt/download must reuse a non-terminal job for the same video:
# two parallel yt-dlp runs write the same outtmpl path (conflicting
# .part files), and during the FFmpegExtractAudio window the raw
# container file already matches the on-disk idempotency check even
# though the postprocessor is about to replace it.


def _job(job_id: Any, video_id: Any, status: Any) -> Any:
    return {"job_id": job_id, "video_id": video_id, "status": status}


@pytest.mark.parametrize("status", sorted(ACTIVE_DOWNLOAD_STATUSES))
def test_find_active_download_job_matches_each_active_status(status: Any) -> None:
    jobs = {"j1": _job("j1", VIDEO_ID, status)}

    found = find_active_download_job(jobs, VIDEO_ID)

    assert found is jobs["j1"]


def test_active_statuses_cover_the_full_non_terminal_lifecycle() -> None:
    assert {"queued", "downloading", "processing"} == ACTIVE_DOWNLOAD_STATUSES


@pytest.mark.parametrize("status", ["completed", "failed"])
def test_find_active_download_job_ignores_terminal_jobs(status: Any) -> None:
    jobs = {"j1": _job("j1", VIDEO_ID, status)}

    assert find_active_download_job(jobs, VIDEO_ID) is None


def test_find_active_download_job_ignores_other_videos() -> None:
    jobs = {"j1": _job("j1", "otherVideo1", "downloading")}

    assert find_active_download_job(jobs, VIDEO_ID) is None


def test_find_active_download_job_empty_store() -> None:
    assert find_active_download_job({}, VIDEO_ID) is None


def test_find_active_download_job_prefers_active_over_terminal() -> None:
    jobs = {
        "j1": _job("j1", VIDEO_ID, "failed"),
        "j2": _job("j2", VIDEO_ID, "processing"),
    }

    found = find_active_download_job(jobs, VIDEO_ID)

    assert found is jobs["j2"]


# ── classify_youtube_url ────────────────────────────────────────────
# Decides whether a pasted URL is a single video, an enumerable playlist
# or channel, or an un-enumerable auto-generated mix. A real "list=" id
# wins over the "v=" focus so pasting any playlist URL offers "download
# all", while RD* radio/mix lists fall back to the single video.

PLAYLIST_ID = "PL-TQY69MwxBRttHQST4uYTaFs4RQPLuOH"


def test_classify_pure_playlist_url() -> None:
    result = classify_youtube_url(f"https://www.youtube.com/playlist?list={PLAYLIST_ID}")
    assert result["kind"] == "playlist"
    assert result["playlist_id"] == PLAYLIST_ID
    assert result["enumerate_url"] == (f"https://www.youtube.com/playlist?list={PLAYLIST_ID}")


def test_classify_watch_with_playlist_prefers_playlist() -> None:
    # A real (non-RD) list wins over the focused video.
    result = classify_youtube_url(f"https://www.youtube.com/watch?v={VIDEO_ID}&list={PLAYLIST_ID}")
    assert result["kind"] == "playlist"
    assert result["playlist_id"] == PLAYLIST_ID


def test_classify_radio_mix_is_mix_not_playlist() -> None:
    # RD* lists are auto-generated radio/mixes — not enumerable as a set,
    # so they fall back to the single focused video.
    result = classify_youtube_url(
        f"https://www.youtube.com/watch?v={VIDEO_ID}&list=RD{VIDEO_ID}&start_radio=1"
    )
    assert result["kind"] == "mix"
    assert result["video_id"] == VIDEO_ID
    assert result["list_id"] == f"RD{VIDEO_ID}"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VIDEO_ID}",
        f"https://youtu.be/{VIDEO_ID}",
        f"https://www.youtube.com/shorts/{VIDEO_ID}",
    ],
)
def test_classify_single_video(url: Any) -> None:
    result = classify_youtube_url(url)
    assert result["kind"] == "video"
    assert result["video_id"] == VIDEO_ID


def test_classify_channel_handle() -> None:
    result = classify_youtube_url("https://www.youtube.com/@BookClubRadio")
    assert result["kind"] == "channel"
    assert result["enumerate_url"] == ("https://www.youtube.com/@BookClubRadio/videos")


def test_classify_channel_handle_with_tab_normalizes_to_videos() -> None:
    result = classify_youtube_url("https://www.youtube.com/@BookClubRadio/streams")
    assert result["kind"] == "channel"
    assert result["enumerate_url"] == ("https://www.youtube.com/@BookClubRadio/videos")


def test_classify_channel_id() -> None:
    result = classify_youtube_url("https://www.youtube.com/channel/UCabcdEFGHijklMNOpqrSTUvw")
    assert result["kind"] == "channel"
    assert result["enumerate_url"] == (
        "https://www.youtube.com/channel/UCabcdEFGHijklMNOpqrSTUvw/videos"
    )


@pytest.mark.parametrize(
    "url,expected",
    [
        (
            "https://www.youtube.com/c/SomeName",
            "https://www.youtube.com/c/SomeName/videos",
        ),
        (
            "https://www.youtube.com/user/LegacyName",
            "https://www.youtube.com/user/LegacyName/videos",
        ),
    ],
)
def test_classify_legacy_channel_paths(url: Any, expected: Any) -> None:
    result = classify_youtube_url(url)
    assert result["kind"] == "channel"
    assert result["enumerate_url"] == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://music.youtube.com/playlist?list=" + PLAYLIST_ID,
        "https://example.com/playlist?list=" + PLAYLIST_ID,
        "not a url",
        "",
    ],
)
def test_classify_unknown(url: Any) -> None:
    assert classify_youtube_url(url)["kind"] == "unknown"


# ── build_playlist_entries ──────────────────────────────────────────
# Parses a yt-dlp flat-extracted playlist/channel info dict into a bounded
# list of {videoId,title,uploader,duration}, skipping unavailable entries
# and reporting truncation.


def _flat_info(
    n: Any, *, playlist_count: Any = None, title: Any = "My Playlist", channel: Any = "Chan"
) -> Any:
    return {
        "title": title,
        "channel": channel,
        "playlist_count": playlist_count,
        "entries": [
            {"id": f"vid{i:08d}", "title": f"Track {i}", "channel": channel, "duration": 100 + i}
            for i in range(n)
        ],
    }


def test_build_playlist_entries_maps_fields() -> None:
    info = {
        "title": "Set",
        "uploader": "DJ",
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "One", "uploader": "DJ", "duration": 200},
        ],
    }
    out = build_playlist_entries(info, 100)
    assert out["title"] == "Set"
    assert out["uploader"] == "DJ"
    assert out["count"] == 1
    assert out["truncated"] is False
    assert out["entries"] == [
        {"videoId": "aaaaaaaaaaa", "title": "One", "uploader": "DJ", "duration": 200}
    ]


def test_build_playlist_entries_skips_unavailable() -> None:
    info = {
        "title": "T",
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "ok"},
            None,
            {"title": "no id"},
            {"id": "", "title": "empty id"},
            {"id": "bbbbbbbbbbb", "title": "ok2"},
        ],
    }
    out = build_playlist_entries(info, 100)
    assert [e["videoId"] for e in out["entries"]] == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
    assert out["count"] == 2


def test_build_playlist_entries_caps_and_marks_truncated() -> None:
    out = build_playlist_entries(_flat_info(10), 4)
    assert out["count"] == 4
    assert out["truncated"] is True
    assert [e["videoId"] for e in out["entries"]] == [f"vid{i:08d}" for i in range(4)]


def test_build_playlist_entries_truncated_from_playlist_count() -> None:
    # yt-dlp returned only the first 5 (playlistend cap) but the playlist
    # actually has 500 — still truncated even though entries <= max.
    out = build_playlist_entries(_flat_info(5, playlist_count=500), 100)
    assert out["count"] == 5
    assert out["totalCount"] == 500
    assert out["truncated"] is True


def test_build_playlist_entries_uploader_falls_back_to_channel() -> None:
    info = {"entries": [{"id": "aaaaaaaaaaa", "title": "x", "channel": "ChanX"}]}
    assert build_playlist_entries(info, 10)["entries"][0]["uploader"] == "ChanX"


def test_build_playlist_entries_duration_none_when_missing() -> None:
    info = {"entries": [{"id": "aaaaaaaaaaa", "title": "x"}]}
    assert build_playlist_entries(info, 10)["entries"][0]["duration"] is None


def test_build_playlist_entries_handles_bad_info() -> None:
    for bad in (None, {}, "nope", {"entries": "x"}):
        out = build_playlist_entries(bad, 10)
        assert out["count"] == 0
        assert out["entries"] == []
        assert out["truncated"] is False
