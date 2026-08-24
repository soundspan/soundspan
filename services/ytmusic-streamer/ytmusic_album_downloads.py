"""YouTube Music album download jobs and HTTP routes."""

import asyncio
import glob
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from itertools import islice
from pathlib import Path
from typing import Any

from common.sidecar_runtime_utils import env_int
from fastapi import HTTPException, Query
from yt_download import (
    _build_album_track_candidates,
    _build_album_track_tmp_path,
    _read_embedded_video_id,
    _require_contained_download_path,
    _stamp_audio_tags,
    build_album_track_paths,
    build_audio_download_opts,
)
from ytmusic_client import _get_public_ytmusic
from ytmusic_downloads import TERMINAL_DOWNLOAD_STATUSES
from ytmusic_library import get_public_album_metadata
from ytmusic_models import YtAlbumDownloadRequest
from ytmusic_runtime import _USER_AGENT, JsonObject, _sanitized_http_error, app, log
from ytmusic_stream import YTDLP_SOCKET_TIMEOUT, _browse_public_bounded, _extract_pacer

MUSIC_PATH = Path(os.getenv("MUSIC_PATH", "/music"))
YT_ALBUM_DOWNLOAD_JOB_TTL = 6 * 60 * 60
YT_ALBUM_DOWNLOAD_CONCURRENCY = max(1, env_int("YT_ALBUM_DOWNLOAD_CONCURRENCY", "1"))
_yt_album_download_executor = ThreadPoolExecutor(
    max_workers=YT_ALBUM_DOWNLOAD_CONCURRENCY,
    thread_name_prefix="yt-album-download",
)
_yt_album_download_jobs: dict[str, JsonObject] = {}
_yt_album_download_tasks: set[asyncio.Task[None]] = set()
_album_track_install_lock = threading.Lock()
_MAX_OWNED_TEMP_ARTIFACTS = 64


def _album_search_artists(value: object) -> list[str]:
    """Flatten ytmusicapi album artists into non-empty names."""
    if not isinstance(value, list):
        return []
    names: list[str] = []
    for artist in value:
        name = artist.get("name") if isinstance(artist, dict) else artist
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return names


def _normalize_album_search_item(value: object) -> JsonObject | None:
    """Map one public album-search result to the download contract."""
    if not isinstance(value, dict):
        return None
    browse_id = value.get("browseId")
    if not isinstance(browse_id, str) or not browse_id.strip():
        return None
    title = value.get("title")
    return {
        "browse_id": browse_id.strip(),
        "title": title.strip() if isinstance(title, str) else "",
        "artists": _album_search_artists(value.get("artists")),
    }


@app.get("/yt/album-search")
async def yt_album_search(
    query: str = Query(..., min_length=1, pattern=r".*\S.*"),
    limit: int = 10,
) -> JsonObject:
    """Search public YouTube Music albums for the download workflow."""
    clamped_limit = max(1, min(25, limit))
    try:
        yt = _get_public_ytmusic("native")
        search = partial(yt.search, filter="albums", limit=clamped_limit)
        raw_items = await _browse_public_bounded(search, query)
        items = raw_items if isinstance(raw_items, list) else []
        albums = [
            album
            for item in items[:clamped_limit]
            if (album := _normalize_album_search_item(item)) is not None
        ]
        return {"albums": albums}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            "Public album search", error, 500, "Album search failed"
        ) from error


def _prune_yt_album_download_jobs() -> None:
    """Drop terminal album jobs older than the bounded retention period."""
    cutoff = time.time() - YT_ALBUM_DOWNLOAD_JOB_TTL
    stale = [
        job_id
        for job_id, job in _yt_album_download_jobs.items()
        if job.get("status") in TERMINAL_DOWNLOAD_STATUSES and job.get("created_at", 0) <= cutoff
    ]
    for job_id in stale:
        del _yt_album_download_jobs[job_id]


def _new_yt_album_download_job(browse_id: str) -> JsonObject:
    """Create and register an isolated album download job."""
    _prune_yt_album_download_jobs()
    job: JsonObject = {
        "job_id": uuid.uuid4().hex,
        "browse_id": browse_id,
        "status": "queued",
        "progress_pct": 0.0,
        "album_title": "",
        "album_artist": "",
        "total_tracks": 0,
        "downloaded": 0,
        "failed": 0,
        "errors": [],
        "error": None,
        "cancel_requested": False,
        "created_at": time.time(),
    }
    _yt_album_download_jobs[str(job["job_id"])] = job
    return job


def _yt_album_download_job_payload(job: JsonObject) -> JsonObject:
    """Return the stable public album-job payload."""
    keys = (
        "job_id",
        "browse_id",
        "status",
        "progress_pct",
        "album_title",
        "album_artist",
        "total_tracks",
        "downloaded",
        "failed",
        "errors",
        "error",
        "created_at",
    )
    return {key: job.get(key) for key in keys}


def _track_details(track: JsonObject, index: int) -> tuple[str, str, int, list[str]]:
    """Validate the public album fields required for one download."""
    video_id = track.get("videoId")
    title = track.get("title")
    if not isinstance(video_id, str) or not video_id:
        raise ValueError("Album track has no video id")
    if not isinstance(title, str) or not title:
        raise ValueError("Album track has no title")
    number = track.get("trackNumber")
    track_number = number if isinstance(number, int) and number > 0 else index
    raw_artists = track.get("artists")
    artists = (
        [artist for artist in raw_artists if isinstance(artist, str)]
        if isinstance(raw_artists, list)
        else []
    )
    return video_id, title, track_number, artists


def _album_track_tags(
    track: JsonObject, index: int, album_title: str, album_artist: str, year: str
) -> dict[str, str]:
    """Build scanner-compatible tags for one album track."""
    video_id, title, track_number, artists = _track_details(track, index)
    return {
        "artist": ", ".join(artists) or album_artist,
        "album_artist": album_artist,
        "album": album_title,
        "title": title,
        "track": str(track_number),
        "date": year,
        "comment": f"ytmusic:{video_id}",
    }


def _resolve_album_track_path(
    planned_path: Path,
    destination_root: Path,
    video_id: str,
) -> Path:
    """Resolve one bounded identity-checked album path without overwriting files."""
    candidates = _build_album_track_candidates(planned_path, video_id)
    first_free: Path | None = None
    for index, candidate in enumerate(candidates):
        contained = _require_contained_download_path(candidate, destination_root)
        if not contained.exists():
            if first_free is None:
                first_free = contained
            continue
        if not contained.is_file():
            continue
        embedded_id = _read_embedded_video_id(contained)
        if embedded_id == video_id:
            return contained
        if embedded_id is None and index == 0:
            log.debug(
                "Keeping legacy YouTube Music album track without embedded identity at %s",
                contained,
            )
            return contained
    if first_free is not None:
        return first_free
    raise RuntimeError(
        f"No safe download path for YouTube Music video {video_id}; all {len(candidates)} "
        "candidates are occupied by other or unidentified files"
    )


def _install_album_track(
    tmp_path: Path,
    planned_path: Path,
    destination_root: Path,
    video_id: str,
) -> Path:
    """Atomically install a tagged temp file into a race-safe resolved candidate."""
    with _album_track_install_lock:
        final_path = _resolve_album_track_path(planned_path, destination_root, video_id)
        if final_path.is_file():
            tmp_path.unlink()
            return final_path
        if final_path != planned_path:
            log.info(
                "Album path collision at %s; saving YouTube Music video %s to %s",
                planned_path,
                video_id,
                final_path,
            )
        os.replace(tmp_path, final_path)
        return final_path


def _album_progress_hook(job: JsonObject, download_cancelled: type[Exception]) -> Any:
    """Create a progress hook that supports cancellation and processing state."""

    def update(progress: JsonObject) -> None:
        if job.get("cancel_requested"):
            raise download_cancelled("cancelled by user")
        if progress.get("status") == "finished":
            job["status"] = "processing"

    return update


def _select_album_track_paths(
    *,
    music_path: Path,
    album_artist: str,
    album_title: str,
    track_number: int,
    title: str,
    audio_format: str,
    video_id: str,
) -> tuple[Path, Path | None]:
    """Return an existing resume target or planned and unique temporary paths."""
    _relative, planned_path, planned_tmp_path = build_album_track_paths(
        music_path, album_artist, album_title, track_number, title, audio_format
    )
    destination_root = music_path.resolve()
    final_path = _resolve_album_track_path(planned_path, destination_root, video_id)
    if final_path.is_file():
        return final_path, None
    tmp_path = (
        planned_tmp_path
        if final_path == planned_path
        else _build_album_track_tmp_path(final_path, destination_root)
    )
    final_path.parent.mkdir(parents=True, exist_ok=True)
    return planned_path, tmp_path


def _extract_album_track(
    job: JsonObject,
    video_id: str,
    tmp_path: Path,
    audio_format: str,
    quality: str,
) -> None:
    """Run one bounded yt-dlp extraction into a unique temporary path."""
    import yt_dlp

    _extract_pacer.wait()
    hook = _album_progress_hook(job, yt_dlp.utils.DownloadCancelled)
    options = build_audio_download_opts(
        str(tmp_path.with_suffix(".%(ext)s")),
        audio_format,
        quality,
        _USER_AGENT,
        YTDLP_SOCKET_TIMEOUT,
        hook,
    )
    if job.get("cancel_requested"):
        raise yt_dlp.utils.DownloadCancelled("cancelled by user")
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    if not info or not tmp_path.is_file():
        raise ValueError("Track download completed without an output file")


def _tag_album_track(
    tmp_path: Path,
    track: JsonObject,
    index: int,
    album_title: str,
    album_artist: str,
    year: str,
    video_id: str,
) -> None:
    """Stamp scanner-compatible tags and require readable track identity."""
    _stamp_audio_tags(
        str(tmp_path),
        _album_track_tags(track, index, album_title, album_artist, year),
        log,
    )
    if _read_embedded_video_id(tmp_path) == video_id:
        return
    raise ValueError("Track identity metadata could not be embedded")


def _cleanup_album_track_temp(tmp_path: Path) -> None:
    """Remove bounded yt-dlp artifacts owned by one UUID temporary stem."""
    owned_pattern = f"{glob.escape(str(tmp_path.with_suffix('')))}.*"
    artifact_names = islice(glob.iglob(owned_pattern), _MAX_OWNED_TEMP_ARTIFACTS)
    for artifact_name in artifact_names:
        artifact = Path(artifact_name)
        try:
            artifact.unlink(missing_ok=True)
        except OSError as error:
            log.warning(
                "Could not remove YouTube Music album temp artifact %s: %s", artifact, error
            )


def _download_album_track_sync(
    *,
    job: JsonObject,
    track: JsonObject,
    index: int,
    album_title: str,
    album_artist: str,
    year: str,
    audio_format: str,
    quality: str,
    music_path: Path,
) -> str:
    """Download, tag, and atomically place one album track."""
    video_id, title, track_number, _artists = _track_details(track, index)
    planned_path, tmp_path = _select_album_track_paths(
        music_path=music_path,
        album_artist=album_artist,
        album_title=album_title,
        track_number=track_number,
        title=title,
        audio_format=audio_format,
        video_id=video_id,
    )
    if tmp_path is None:
        return str(planned_path)
    succeeded = False
    try:
        _extract_album_track(job, video_id, tmp_path, audio_format, quality)
        _tag_album_track(
            tmp_path,
            track,
            index,
            album_title,
            album_artist,
            year,
            video_id,
        )
        installed_path = _install_album_track(
            tmp_path,
            planned_path,
            music_path.resolve(),
            video_id,
        )
        succeeded = True
        return str(installed_path)
    finally:
        if not succeeded:
            _cleanup_album_track_temp(tmp_path)


def _record_track_failure(job: JsonObject, track: JsonObject, error: Exception) -> None:
    """Log full track failure detail and store only a generic payload error."""
    video_id = track.get("videoId") if isinstance(track.get("videoId"), str) else ""
    title = track.get("title") if isinstance(track.get("title"), str) else ""
    log.error("YT album track failed for %s (%s): %s", title, video_id, error, exc_info=True)
    errors = job.get("errors")
    if isinstance(errors, list):
        errors.append({"video_id": video_id, "title": title, "error": "Track download failed"})
    job["failed"] = int(job.get("failed") or 0) + 1


def _update_completed_track_progress(job: JsonObject) -> None:
    """Update album progress from the settled track count."""
    total = int(job.get("total_tracks") or 0)
    settled = int(job.get("downloaded") or 0) + int(job.get("failed") or 0)
    job["progress_pct"] = round(settled * 100.0 / total, 1) if total > 0 else 0.0


async def _download_album_tracks(
    job: JsonObject,
    tracks: list[JsonObject],
    audio_format: str,
    quality: str,
    music_path: Path,
) -> None:
    """Download album tracks sequentially within one job."""
    loop = asyncio.get_running_loop()
    for index, track in enumerate(tracks, start=1):
        if job.get("cancel_requested"):
            job["status"] = "cancelled"
            return
        job["status"] = "downloading"
        work = partial(
            _download_album_track_sync,
            job=job,
            track=track,
            index=index,
            album_title=str(job["album_title"]),
            album_artist=str(job["album_artist"]),
            year=str(job.get("year") or ""),
            audio_format=audio_format,
            quality=quality,
            music_path=music_path,
        )
        try:
            await loop.run_in_executor(_yt_album_download_executor, work)
            job["downloaded"] = int(job.get("downloaded") or 0) + 1
        except Exception as error:
            if job.get("cancel_requested"):
                job["status"] = "cancelled"
                return
            _record_track_failure(job, track, error)
        _update_completed_track_progress(job)


def _complete_album_job(job: JsonObject) -> None:
    """Set the terminal album state from its successful track count."""
    if job.get("status") == "cancelled":
        return
    if int(job.get("downloaded") or 0) == 0:
        job["status"] = "failed"
        job["error"] = "Album download failed"
        return
    job["status"] = "completed"
    job["progress_pct"] = 100.0


async def _run_yt_album_download_job(
    job: JsonObject, audio_format: str, quality: str, music_path: Path
) -> None:
    """Fetch album metadata and own the complete background job lifecycle."""
    try:
        if job.get("cancel_requested"):
            job["status"] = "cancelled"
            return
        job["status"] = "processing"
        album = await get_public_album_metadata(str(job["browse_id"]))
        tracks = album.get("tracks")
        if not isinstance(tracks, list):
            raise ValueError("Album response has no track list")
        job["album_title"] = str(album.get("title") or "Unknown Album")
        job["album_artist"] = str(album.get("artist") or "Unknown Artist")
        job["year"] = str(album.get("year") or "")
        job["total_tracks"] = len(tracks)
        await _download_album_tracks(job, tracks, audio_format, quality, music_path)
        _complete_album_job(job)
    except Exception as error:
        log.error("YT album download failed for %s: %s", job.get("browse_id"), error, exc_info=True)
        job["status"] = "cancelled" if job.get("cancel_requested") else "failed"
        job["error"] = None if job.get("cancel_requested") else "Album download failed"


@app.post("/yt/download/album")
async def yt_album_download(req: YtAlbumDownloadRequest) -> JsonObject:
    """Start an isolated background YouTube Music album download job."""
    job = _new_yt_album_download_job(req.browse_id)
    task = asyncio.create_task(_run_yt_album_download_job(job, req.format, req.quality, MUSIC_PATH))
    _yt_album_download_tasks.add(task)
    task.add_done_callback(_yt_album_download_tasks.discard)
    return {"job_id": job["job_id"], "status": job["status"]}


@app.get("/yt/download/album/{job_id}")
async def yt_album_download_status(job_id: str) -> JsonObject:
    """Return an album job, or 404 after restart/expiry."""
    job = _yt_album_download_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Album download job not found")
    return _yt_album_download_job_payload(job)


@app.delete("/yt/download/album/{job_id}")
async def yt_album_download_cancel(job_id: str) -> JsonObject:
    """Cancel a queued or in-flight album job."""
    job = _yt_album_download_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Album download job not found")
    if job.get("status") not in TERMINAL_DOWNLOAD_STATUSES:
        job["cancel_requested"] = True
        if job.get("status") == "queued":
            job["status"] = "cancelled"
    return _yt_album_download_job_payload(job)
