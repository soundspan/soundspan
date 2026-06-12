"""
Unit tests for the pure /yt/ download helpers in yt_download.py.

The helpers are kept in a standalone module (no yt-dlp / FastAPI imports)
so these tests run without the sidecar's heavy runtime dependencies.
"""

import sys
from pathlib import Path

import pytest

# app.py imports fastapi/ytmusicapi at module scope, so tests import the
# pure helper module directly from the sidecar directory instead.
SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from yt_download import (  # noqa: E402
    ACTIVE_DOWNLOAD_STATUSES,
    PROXY_AUDIO_FORMAT_SELECTORS,
    derive_proxy_audio_container,
    extract_video_id,
    find_active_download_job,
    find_existing_download,
    resolve_download_filepath,
)

VIDEO_ID = "dQw4w9WgXcQ"


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
def test_extract_video_id_variants(url):
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
def test_extract_video_id_rejects_invalid(url):
    with pytest.raises(ValueError):
        extract_video_id(url)


# ── find_existing_download (idempotency check) ──────────────────────

def test_find_existing_download_matches_bracketed_id(tmp_path):
    target = tmp_path / f"Some DJ Set [{VIDEO_ID}].mp3"
    target.write_bytes(b"audio")

    assert find_existing_download(str(tmp_path), VIDEO_ID) == str(target)


def test_find_existing_download_ignores_non_audio_extensions(tmp_path):
    (tmp_path / f"Some DJ Set [{VIDEO_ID}].jpg").write_bytes(b"thumb")

    assert find_existing_download(str(tmp_path), VIDEO_ID) is None


def test_find_existing_download_no_char_class_false_positive(tmp_path):
    # Regression: the old pattern f"*[{video_id}].*" treated [..] as a glob
    # character class, so any file ending in one of the id's characters
    # matched. "mix-Q.mp3" ends with "Q", which is inside the class.
    (tmp_path / "mix-Q.mp3").write_bytes(b"audio")

    assert find_existing_download(str(tmp_path), VIDEO_ID) is None


def test_find_existing_download_handles_glob_chars_in_dir(tmp_path):
    weird_dir = tmp_path / "music [archive]"
    weird_dir.mkdir()
    target = weird_dir / f"Track [{VIDEO_ID}].opus"
    target.write_bytes(b"audio")

    assert find_existing_download(str(weird_dir), VIDEO_ID) == str(target)


def test_find_existing_download_missing_dir_returns_none(tmp_path):
    assert find_existing_download(str(tmp_path / "nope"), VIDEO_ID) is None


# ── resolve_download_filepath ───────────────────────────────────────

def test_resolve_filepath_from_requested_downloads(tmp_path):
    final = tmp_path / f"Title [{VIDEO_ID}].mp3"
    final.write_bytes(b"audio")
    info = {"requested_downloads": [{"filepath": str(final)}]}

    assert resolve_download_filepath(info, "mp3") == str(final)


def test_resolve_filepath_accounts_for_extract_audio_extension(tmp_path):
    # yt-dlp may record the pre-postprocessing media path (e.g. .webm);
    # FFmpegExtractAudio replaces the extension with the requested format.
    recorded = tmp_path / f"Title [{VIDEO_ID}].webm"
    converted = tmp_path / f"Title [{VIDEO_ID}].mp3"
    converted.write_bytes(b"audio")
    info = {"requested_downloads": [{"filepath": str(recorded)}]}

    assert resolve_download_filepath(info, "mp3") == str(converted)


def test_resolve_filepath_falls_back_to_legacy_keys(tmp_path):
    final = tmp_path / f"Title [{VIDEO_ID}].m4a"
    final.write_bytes(b"audio")
    info = {"filepath": str(final)}

    assert resolve_download_filepath(info, "m4a") == str(final)


def test_resolve_filepath_returns_none_when_nothing_exists(tmp_path):
    info = {
        "requested_downloads": [
            {"filepath": str(tmp_path / "missing.webm")}
        ]
    }

    assert resolve_download_filepath(info, "mp3") is None


def test_resolve_filepath_handles_bad_info():
    assert resolve_download_filepath(None, "mp3") is None
    assert resolve_download_filepath({}, "mp3") is None
    assert resolve_download_filepath({"requested_downloads": "x"}, "mp3") is None


# ── derive_proxy_audio_container ────────────────────────────────────
# The container hint must be derived from the SAME format selection and
# acodec mapping the /yt/ stream proxy uses, otherwise the player gets a
# decode hint that does not match the bytes served.

def test_proxy_selectors_cover_all_qualities():
    assert set(PROXY_AUDIO_FORMAT_SELECTORS) == {
        "LOW",
        "MEDIUM",
        "HIGH",
        "LOSSLESS",
    }
    # The proxy's default quality — /yt/info extracts with this selector.
    assert PROXY_AUDIO_FORMAT_SELECTORS["HIGH"] == "ba[abr<=256]/ba"


def test_derive_proxy_audio_container_opus_maps_to_webm():
    assert derive_proxy_audio_container({"acodec": "opus"}) == "webm"


def test_derive_proxy_audio_container_aac_maps_to_mp4():
    assert derive_proxy_audio_container({"acodec": "mp4a.40.2"}) == "mp4"
    assert derive_proxy_audio_container({"acodec": "aac"}) == "mp4"


def test_derive_proxy_audio_container_uses_selected_format_not_best_abr():
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


def test_derive_proxy_audio_container_defaults_to_mp4():
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

def _job(job_id, video_id, status):
    return {"job_id": job_id, "video_id": video_id, "status": status}


@pytest.mark.parametrize("status", sorted(ACTIVE_DOWNLOAD_STATUSES))
def test_find_active_download_job_matches_each_active_status(status):
    jobs = {"j1": _job("j1", VIDEO_ID, status)}

    found = find_active_download_job(jobs, VIDEO_ID)

    assert found is jobs["j1"]


def test_active_statuses_cover_the_full_non_terminal_lifecycle():
    assert ACTIVE_DOWNLOAD_STATUSES == {"queued", "downloading", "processing"}


@pytest.mark.parametrize("status", ["completed", "failed"])
def test_find_active_download_job_ignores_terminal_jobs(status):
    jobs = {"j1": _job("j1", VIDEO_ID, status)}

    assert find_active_download_job(jobs, VIDEO_ID) is None


def test_find_active_download_job_ignores_other_videos():
    jobs = {"j1": _job("j1", "otherVideo1", "downloading")}

    assert find_active_download_job(jobs, VIDEO_ID) is None


def test_find_active_download_job_empty_store():
    assert find_active_download_job({}, VIDEO_ID) is None


def test_find_active_download_job_prefers_active_over_terminal():
    jobs = {
        "j1": _job("j1", VIDEO_ID, "failed"),
        "j2": _job("j2", VIDEO_ID, "processing"),
    }

    found = find_active_download_job(jobs, VIDEO_ID)

    assert found is jobs["j2"]
