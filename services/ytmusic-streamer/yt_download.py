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
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

# Audio file extensions produced by the download postprocessors (plus raw
# bestaudio containers in case postprocessing is skipped).
AUDIO_EXTENSIONS = {".mp3", ".opus", ".flac", ".m4a", ".ogg", ".webm"}

# Download-job states that mean a download is still in flight.
ACTIVE_DOWNLOAD_STATUSES = {"queued", "downloading", "processing"}


def find_active_download_job(
    jobs: dict[str, dict[str, Any]], video_id: str
) -> dict[str, Any] | None:
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
        if job.get("video_id") == video_id and job.get("status") in ACTIVE_DOWNLOAD_STATUSES:
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


class _WarningLogger(Protocol):
    """Minimal logger surface used by the shared tag-stamping helper."""

    def warning(self, message: str) -> None: ...


def _sanitize_path_component(name: str) -> str:
    """Replace filesystem-reserved characters and trim unsafe suffixes."""
    for char in '<>:"/\\|?*':
        name = name.replace(char, "_")
    return name.strip(". ")


def _sanitize_download_relative_path(rendered_path: str) -> Path:
    """Validate and sanitize every component of a relative download path."""
    sanitized_parts: list[str] = []
    for component in rendered_path.split("/"):
        sanitized = _sanitize_path_component(component)
        if not sanitized or sanitized in {".", ".."} or Path(sanitized).is_absolute():
            raise ValueError("Invalid output template path component")
        sanitized_parts.append(sanitized)
    return Path(*sanitized_parts)


def _require_contained_download_path(path: Path, destination_root: Path) -> Path:
    """Resolve a path and reject targets outside the configured music root."""
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(destination_root.resolve())
    except ValueError:
        raise ValueError("Download path resolves outside MUSIC_PATH") from None
    return resolved_path


def build_album_track_paths(
    music_path: Path,
    album_artist: str,
    album_title: str,
    track_number: int,
    track_title: str,
    audio_format: str,
) -> tuple[Path, Path, Path]:
    """Build deterministic contained paths for one album track and its temp file."""
    if track_number < 1:
        raise ValueError("Track number must be positive")
    components = (
        _sanitize_path_component(album_artist),
        _sanitize_path_component(album_title),
        _sanitize_path_component(f"{track_number:02d}. {track_title}"),
    )
    relative_stem = _sanitize_download_relative_path("/".join(components))
    extension = audio_format.lstrip(".")
    relative_path = relative_stem.parent / f"{relative_stem.name}.{extension}"
    destination_root = music_path.resolve()
    final_path = _require_contained_download_path(
        destination_root / relative_path, destination_root
    )
    tmp_path = final_path.with_name(f"{final_path.stem}.tmp{final_path.suffix}")
    return relative_path, final_path, _require_contained_download_path(tmp_path, destination_root)


def build_audio_download_opts(
    outtmpl: str,
    audio_format: str,
    quality: str,
    user_agent: str,
    socket_timeout: float,
    progress_hook: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Build shared yt-dlp options for bounded audio extraction."""
    options: dict[str, Any] = {
        "format": PROXY_AUDIO_FORMAT_SELECTORS.get(quality, PROXY_AUDIO_FORMAT_SELECTORS["HIGH"]),
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": audio_format,
                "preferredquality": "320" if audio_format == "mp3" else "0",
            },
            {"key": "FFmpegMetadata"},
            {"key": "EmbedThumbnail"},
        ],
        "writethumbnail": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": socket_timeout,
        "http_headers": {
            "User-Agent": user_agent,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {"youtube": {"player_client": YT_PLAYER_CLIENTS}},
    }
    if progress_hook is not None:
        options["progress_hooks"] = [progress_hook]
    return options


def _safe_remove(path: str) -> None:
    """Remove a file if it exists, swallowing cleanup-only OS errors."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _stamp_audio_tags(filepath: str, tags: dict[str, str], logger: _WarningLogger) -> None:
    """Best-effort stream-copy tag rewrite compatible with the library scanner."""
    if not tags:
        return
    root, ext = os.path.splitext(filepath)
    tmp_path = f"{root}.tagtmp{ext}"
    command = build_tag_rewrite_command(filepath, tags, tmp_path)
    try:
        result = subprocess.run(  # noqa: S603 -- argv is built from code-owned ffmpeg options
            command, capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            os.replace(tmp_path, filepath)
            return
        logger.warning(f"ffmpeg tag stamp failed for {filepath}: {(result.stderr or '')[:300]}")
    except Exception as error:
        logger.warning(f"Failed to stamp audio tags on {filepath}: {error}")
    _safe_remove(tmp_path)


_VIDEO_ID_PATTERNS = [
    r"(?:youtube\.com|m\.youtube\.com)/watch\?.*?v=([a-zA-Z0-9_-]{11})",
    r"youtu\.be/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/embed/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/v/([a-zA-Z0-9_-]{11})",
    r"youtube\.com/shorts/([a-zA-Z0-9_-]{11})",
]


def _match_video_id(url: str) -> str | None:
    """Return the 11-char video ID for a single-video URL/bare ID, else None."""
    for pattern in _VIDEO_ID_PATTERNS:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    stripped = url.strip()
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", stripped):
        return stripped
    return None


def extract_video_id(url: str) -> str:
    """
    Extract an 11-char YouTube video ID from any common URL format.
    Accepts: youtube.com/watch?v=, youtu.be/, m.youtube.com/watch?v=,
    embed/, /v/, shorts/, or a bare 11-char ID.
    Raises ValueError when no video ID can be extracted.
    """
    video_id = _match_video_id(url)
    if video_id is None:
        raise ValueError(f"Could not extract video ID from: {url}")
    return video_id


# Playlist / channel URL patterns for bulk-download classification. A
# "list=" query param identifies a playlist (or, when RD*-prefixed, an
# auto-generated radio/mix that cannot be enumerated as a static set).
_LIST_PARAM_RE = re.compile(r"[?&]list=([A-Za-z0-9_-]+)")
_CHANNEL_HANDLE_RE = re.compile(r"youtube\.com/(@[A-Za-z0-9_.\-]+)")
_CHANNEL_ID_RE = re.compile(r"youtube\.com/channel/(UC[A-Za-z0-9_\-]+)")
_CHANNEL_LEGACY_RE = re.compile(r"youtube\.com/(c|user)/([A-Za-z0-9_.\-]+)")


def classify_youtube_url(url: str) -> dict[str, Any]:
    """
    Classify a pasted YouTube URL for the bulk-download flow. Returns a dict
    whose "kind" is one of:

      - "video":    a single video        -> {"kind","video_id"}
      - "playlist": an enumerable playlist -> {"kind","playlist_id","enumerate_url"}
      - "channel":  a channel             -> {"kind","channel","enumerate_url"}
      - "mix":      an auto-generated radio/mix (list=RD*), not enumerable as
                    a set, so it falls back to the focused video
                    -> {"kind","video_id"(maybe None),"list_id"}
      - "unknown":  anything else (incl. music.youtube.com, handled elsewhere)

    A real (non-RD) "list=" wins over the "v=" focus, so pasting any playlist
    URL — even a watch URL opened from within a playlist — offers
    "download all". Channels normalize to their /videos uploads tab.
    """
    text = (url or "").strip()
    if not text or "music.youtube.com" in text.lower():
        return {"kind": "unknown"}

    # Bare 11-char video ID.
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", text):
        return {"kind": "video", "video_id": text}

    if "youtube.com/" not in text and "youtu.be/" not in text:
        return {"kind": "unknown"}

    list_match = _LIST_PARAM_RE.search(text)
    if list_match:
        list_id = list_match.group(1)
        if list_id.startswith("RD"):
            return {
                "kind": "mix",
                "video_id": _match_video_id(text),
                "list_id": list_id,
            }
        return {
            "kind": "playlist",
            "playlist_id": list_id,
            "enumerate_url": f"https://www.youtube.com/playlist?list={list_id}",
        }

    video_id = _match_video_id(text)
    if video_id:
        return {"kind": "video", "video_id": video_id}

    handle = _CHANNEL_HANDLE_RE.search(text)
    if handle:
        return {
            "kind": "channel",
            "channel": handle.group(1),
            "enumerate_url": f"https://www.youtube.com/{handle.group(1)}/videos",
        }
    ucid = _CHANNEL_ID_RE.search(text)
    if ucid:
        return {
            "kind": "channel",
            "channel": ucid.group(1),
            "enumerate_url": (f"https://www.youtube.com/channel/{ucid.group(1)}/videos"),
        }
    legacy = _CHANNEL_LEGACY_RE.search(text)
    if legacy:
        prefix, name = legacy.group(1), legacy.group(2)
        return {
            "kind": "channel",
            "channel": name,
            "enumerate_url": f"https://www.youtube.com/{prefix}/{name}/videos",
        }

    return {"kind": "unknown"}


def build_playlist_entries(info: Any, max_entries: int) -> dict[str, Any]:
    """
    Parse a yt-dlp flat-extracted playlist/channel info dict into a bounded,
    JSON-serializable summary for the bulk-download preview:

        {"title","uploader","totalCount","truncated","count","entries":[
            {"videoId","title","uploader","duration"} ]}

    Skips unavailable entries (None, missing/blank id). Caps the returned
    entries to max_entries and sets "truncated" when the playlist holds more
    than were returned (either more entries came back than the cap, or
    yt-dlp's reported playlist_count exceeds what we kept after a fetch cap).
    Tolerant of malformed input (returns an empty summary).
    """
    empty: dict[str, Any] = {
        "title": "",
        "uploader": "",
        "totalCount": None,
        "truncated": False,
        "count": 0,
        "entries": [],
    }
    if not isinstance(info, dict):
        return empty

    raw = info.get("entries")
    raw = raw if isinstance(raw, list) else []
    entries: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if not isinstance(video_id, str) or not video_id:
            continue
        duration = entry.get("duration")
        entries.append(
            {
                "videoId": video_id,
                "title": str(entry.get("title") or ""),
                "uploader": str(entry.get("uploader") or entry.get("channel") or ""),
                "duration": int(duration) if isinstance(duration, (int, float)) else None,
            }
        )

    total_count = info.get("playlist_count")
    if not isinstance(total_count, int):
        total_count = None

    cap = max(0, max_entries)
    capped = entries[:cap]
    truncated = bool(
        len(entries) > len(capped) or (total_count is not None and total_count > len(capped))
    )
    return {
        "title": str(info.get("title") or ""),
        "uploader": str(info.get("uploader") or info.get("channel") or ""),
        "totalCount": total_count,
        "truncated": truncated,
        "count": len(capped),
        "entries": capped,
    }


def bulk_album_metadata(source: str | None, kind: str | None = None) -> dict[str, str] | None:
    """
    Audio tags to stamp on a bulk-download file so a *channel's* videos group
    under one artist/album instead of each video's own (often per-DJ) YouTube
    artist tag. `source` is the channel title and `kind` is the bulk source
    type ("channel" or "playlist") carried on the download job.

    Only **channels** are collapsed to a single artist — a channel is one
    coherent entity. **Playlists** are curated, frequently multi-artist
    collections, so collapsing them would bury the real artists; their tracks
    keep their native per-video metadata (returns None). Single-video downloads
    (no source/kind) likewise keep native metadata. An unknown/missing kind is
    treated conservatively as "do not collapse".

    artist is overridden alongside album_artist on purpose: the library scanner
    prefers albumartist for grouping but falls back to the artist tag, so
    setting both makes "one coherent artist" robust across container/parser
    quirks.
    """
    if kind != "channel":
        return None
    if not isinstance(source, str):
        return None
    label = source.strip()
    if not label:
        return None
    return {"artist": label, "album_artist": label, "album": label}


def build_tag_rewrite_command(filepath: str, tags: dict[str, Any], tmp_path: str) -> list[str]:
    """
    Build the ffmpeg argv that rewrites `tags` onto `filepath`, stream-copying
    (no re-encode) into `tmp_path`. ffmpeg-written tags stay readable by the
    backend scanner's music-metadata parser — mutagen-written Vorbis tags
    silently break it ("Offset is outside the bounds of the DataView"). `-c
    copy` avoids re-encoding and `-map_metadata 0` preserves existing tags
    (title etc.). `tmp_path` should share filepath's extension so ffmpeg infers
    the output container.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        filepath,
        "-map_metadata",
        "0",
        "-c",
        "copy",
    ]
    for key, value in tags.items():
        cmd += ["-metadata", f"{key}={value}"]
    cmd.append(tmp_path)
    return cmd


def find_existing_download(output_dir: str, video_id: str) -> str | None:
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
        path for path in glob.glob(pattern) if os.path.splitext(path)[1].lower() in AUDIO_EXTENSIONS
    ]
    return matches[0] if matches else None


def resolve_download_filepath(info: Any, audio_format: str) -> str | None:
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
