"""
Pure helper logic for the sidecar's /yt/ download flow.

Deliberately free of yt-dlp / FastAPI / httpx imports so the functions can
be unit-tested (services/ytmusic-streamer/tests/test_yt.py) without
installing the sidecar's heavy runtime dependencies. app.py imports these
helpers for video-id parsing, download idempotency checks, and resolving
the final output path from a yt-dlp info dict.
"""

import glob
import os
import re
from typing import Any, Optional

# Audio file extensions produced by the download postprocessors (plus raw
# bestaudio containers in case postprocessing is skipped).
AUDIO_EXTENSIONS = {".mp3", ".opus", ".flac", ".m4a", ".ogg", ".webm"}

_VIDEO_ID_PATTERNS = [
    r"(?:youtube\.com|m\.youtube\.com)/watch\?.*?v=([a-zA-Z0-9_-]{11})",
    r"youtu\.be/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/embed/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/v/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/shorts/([a-zA-Z0-9_-]{11})",
]


def extract_video_id(url: str) -> str:
    """
    Extract an 11-char YouTube video ID from any common URL format.
    Accepts: youtube.com/watch?v=, youtu.be/, m.youtube.com/watch?v=,
    embed/, /v/, shorts/, or a bare 11-char ID.
    Raises ValueError when no video ID can be extracted.
    """
    for pattern in _VIDEO_ID_PATTERNS:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    # Bare 11-char ID
    stripped = url.strip()
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", stripped):
        return stripped
    raise ValueError(f"Could not extract video ID from: {url}")


def find_existing_download(output_dir: str, video_id: str) -> Optional[str]:
    """
    Return the path of an already-downloaded audio file for video_id in
    output_dir, or None. Files are written as "%(title)s [%(id)s].%(ext)s",
    so we match on the literal "[video_id]" marker. Both the directory and
    the bracketed marker are glob-escaped — "[...]" is a glob character
    class, and the unescaped pattern used to false-positive on any file
    ending in one of the id's characters.
    """
    pattern = os.path.join(
        glob.escape(output_dir),
        f"*{glob.escape('[' + video_id + ']')}.*",
    )
    matches = [
        path
        for path in glob.glob(pattern)
        if os.path.splitext(path)[1].lower() in AUDIO_EXTENSIONS
    ]
    return matches[0] if matches else None


def resolve_download_filepath(info: Any, audio_format: str) -> Optional[str]:
    """
    Resolve the final output file from a yt-dlp info dict after a download.

    yt-dlp records the downloaded path in requested_downloads[0]["filepath"]
    (with "filepath"/"_filename" as legacy fallbacks). The FFmpegExtractAudio
    postprocessor converts the media to the requested audio format and
    replaces the extension, so when a recorded path does not exist on disk
    we also probe the format-substituted variant. Returns None when no
    candidate exists on disk.
    """
    if not isinstance(info, dict):
        return None

    candidates: list[str] = []
    requested = info.get("requested_downloads")
    if isinstance(requested, list):
        for entry in requested:
            if isinstance(entry, dict) and entry.get("filepath"):
                candidates.append(str(entry["filepath"]))
    for key in ("filepath", "_filename"):
        if info.get(key):
            candidates.append(str(info[key]))

    seen: set[str] = set()
    for filepath in candidates:
        if filepath in seen:
            continue
        seen.add(filepath)
        if os.path.isfile(filepath):
            return filepath
        root, _ext = os.path.splitext(filepath)
        converted = f"{root}.{audio_format}"
        if os.path.isfile(converted):
            return converted
    return None


def derive_audio_container(formats: Any) -> str:
    """
    Derive the audio container ("webm" or "mp4") that the /yt/ stream proxy
    will most likely serve, from a yt-dlp formats list. Mirrors the proxy's
    best-audio selection: audio-only formats sorted by abr descending.
    Opus-in-webm maps to "webm"; AAC/unknown map to "mp4".
    """
    if not isinstance(formats, list):
        return "mp4"

    audio_formats = [
        f
        for f in formats
        if isinstance(f, dict)
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") in ("none", None)
    ]
    if not audio_formats:
        return "mp4"

    audio_formats.sort(key=lambda f: f.get("abr", 0) or 0, reverse=True)
    best = audio_formats[0]
    acodec = str(best.get("acodec") or "")
    ext = str(best.get("ext") or "")
    if "opus" in acodec or ext == "webm":
        return "webm"
    return "mp4"
