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

# Download-job states that mean a download is still in flight.
ACTIVE_DOWNLOAD_STATUSES = {"queued", "downloading", "processing"}


def find_active_download_job(jobs: dict, video_id: str) -> Optional[dict]:
    """
    Return a non-terminal download job for video_id from the in-memory job
    store, or None. POST /yt/download reuses such a job instead of starting
    a second concurrent yt-dlp download: parallel downloads of the same
    video write the same output-template path (conflicting .part files),
    and during the FFmpegExtractAudio window the raw container file
    (.webm/.m4a) would falsely satisfy the on-disk idempotency check even
    though the postprocessor is about to replace it.
    """
    for job in jobs.values():
        if (
            job.get("video_id") == video_id
            and job.get("status") in ACTIVE_DOWNLOAD_STATUSES
        ):
            return job
    return None

# yt-dlp format selectors used by the /yt/ stream proxy and downloads,
# keyed by the app's quality levels. /yt/info extracts with the same
# selector (HIGH, the proxy's default) so its audioFormat hint is derived
# from the exact format the proxy will serve.
PROXY_AUDIO_FORMAT_SELECTORS = {
    "LOW": "ba[abr<=64]/worstaudio/ba",
    "MEDIUM": "ba[abr<=128]/ba[abr<=192]/ba",
    "HIGH": "ba[abr<=256]/ba",
    "LOSSLESS": "ba/bestaudio",
}

# yt-dlp InnerTube player clients for regular youtube.com extraction
# (/yt/info, /yt/proxy, and /yt/download). The bare "android" client is
# now PO-token-gated by YouTube and returns no usable progressive audio
# formats for many videos, so the selectors above match nothing and yt-dlp
# raises "Requested format is not available" (surfacing as a 502 on
# /yt/info). "android_vr" and "android_music" still serve the DASH audio
# formats anonymously; listing both lets yt-dlp fall through if one breaks.
# NOTE: this is the regular-YouTube client. The authenticated
# music.youtube.com stream path keeps its own ["android_music"] context.
YT_PLAYER_CLIENTS = ["android_vr", "android_music"]

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


def derive_proxy_audio_container(info: Any) -> str:
    """
    Derive the audio container ("webm" or "mp4") the /yt/ stream proxy will
    serve, from a yt-dlp info dict that was extracted with the SAME format
    selector the proxy uses (PROXY_AUDIO_FORMAT_SELECTORS). Mirrors the
    proxy's Content-Type mapping exactly: the selected format's acodec is
    opus -> "webm"; AAC/unknown -> "mp4".
    """
    if not isinstance(info, dict):
        return "mp4"
    acodec = str(info.get("acodec") or "")
    if "opus" in acodec:
        return "webm"
    return "mp4"
