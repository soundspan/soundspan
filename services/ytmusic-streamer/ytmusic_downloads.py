"""Regular-YouTube download orchestration, jobs, and HTTP routes."""

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor

from common.job_registry import JobRegistry
from common.sidecar_runtime_utils import env_int
from fastapi import HTTPException
from yt_download import (
    _stamp_audio_tags,
    build_audio_download_opts,
    bulk_album_metadata,
    find_active_download_job,
    find_existing_download,
    resolve_download_filepath,
)
from ytmusic_models import YtDownloadRequest
from ytmusic_runtime import _USER_AGENT, JsonObject, app, log
from ytmusic_stream import YTDLP_SOCKET_TIMEOUT, _extract_pacer

# Default destination for /yt/ downloads inside the shared music volume.
YT_DOWNLOAD_DIR = os.getenv("YT_DOWNLOAD_DIR", "/music/YouTube Downloads")

# Download job store (in-memory). Jobs are lost on restart.
_yt_download_tasks: set[asyncio.Task[None]] = set()
YT_DOWNLOAD_JOB_TTL = 6 * 60 * 60
YT_DOWNLOAD_CONCURRENCY = max(1, env_int("YT_DOWNLOAD_CONCURRENCY", "2"))
_yt_download_executor = ThreadPoolExecutor(
    max_workers=YT_DOWNLOAD_CONCURRENCY,
    thread_name_prefix="yt-download",
)
TERMINAL_DOWNLOAD_STATUSES = ("completed", "failed", "cancelled")
_yt_download_registry = JobRegistry(
    ttl_seconds=YT_DOWNLOAD_JOB_TTL,
    terminal_statuses=TERMINAL_DOWNLOAD_STATUSES,
)
_yt_download_jobs = _yt_download_registry.jobs


def _prune_yt_download_jobs() -> None:
    """Drop terminal jobs older than the TTL to bound memory."""
    pruned = _yt_download_registry.prune()
    if pruned:
        log.debug(f"Pruned {pruned} stale YT download job(s)")


def _new_yt_download_job(
    video_id: str,
    status: str = "queued",
    source: str | None = None,
    source_kind: str | None = None,
) -> JsonObject:
    """Create and register a download job record."""
    return _yt_download_registry.create(
        {
            "video_id": video_id,
            "status": status,
            "progress_pct": 0.0,
            "file_path": None,
            "title": "",
            "error": None,
            "already_existed": False,
            "source": source,
            "source_kind": source_kind,
            "cancel_requested": False,
        }
    )


def _yt_download_job_payload(job: JsonObject) -> JsonObject:
    """Public job-status shape returned to the backend."""
    keys = (
        "job_id",
        "video_id",
        "status",
        "progress_pct",
        "file_path",
        "title",
        "error",
        "already_existed",
        "source",
        "created_at",
    )
    return _yt_download_registry.payload(job, keys)


def _update_yt_download_progress(
    job: JsonObject, update: JsonObject, download_cancelled: type[Exception]
) -> None:
    """Apply one yt-dlp progress update to a download job."""
    if job.get("cancel_requested"):
        raise download_cancelled("cancelled by user")
    status = update.get("status")
    if status == "downloading":
        job["status"] = "downloading"
        total = update.get("total_bytes") or update.get("total_bytes_estimate") or 0
        downloaded = update.get("downloaded_bytes") or 0
        if total > 0:
            job["progress_pct"] = round(min(99.0, downloaded * 100.0 / total), 1)
    elif status == "finished":
        job["status"] = "processing"
        job["progress_pct"] = max(float(job.get("progress_pct") or 0), 99.0)


def _build_yt_download_opts(
    job: JsonObject,
    audio_format: str,
    quality: str,
    output_dir: str,
    download_cancelled: type[Exception],
) -> JsonObject:
    """Build yt-dlp options for a bounded audio download."""
    outtmpl = os.path.join(output_dir, "%(title)s [%(id)s].%(ext)s")

    def _progress_hook(update: JsonObject) -> None:
        _update_yt_download_progress(job, update, download_cancelled)

    return build_audio_download_opts(
        outtmpl,
        audio_format,
        quality,
        _USER_AGENT,
        YTDLP_SOCKET_TIMEOUT,
        _progress_hook,
    )


def _complete_yt_download(
    job: JsonObject, info: JsonObject, audio_format: str, output_dir: str
) -> None:
    """Resolve output metadata and mark a successful download completed."""
    video_id = job["video_id"]
    filepath = resolve_download_filepath(info, audio_format)
    if not filepath:
        filepath = find_existing_download(output_dir, video_id)
    if not filepath:
        raise ValueError("Download completed but output file not found")

    bulk_tags = bulk_album_metadata(job.get("source"), job.get("source_kind"))
    if bulk_tags:
        _stamp_audio_tags(filepath, bulk_tags, log)

    job["file_path"] = filepath
    job["title"] = info.get("title", "")
    job["progress_pct"] = 100.0
    job["status"] = "completed"
    log.info(f"YT download completed for {video_id}: {filepath}")


def _yt_download_sync(job: JsonObject, audio_format: str, quality: str, output_dir: str) -> None:
    """Run a blocking yt-dlp download and update its job record."""
    import yt_dlp

    video_id = job["video_id"]
    _extract_pacer.wait()
    ydl_opts = _build_yt_download_opts(
        job, audio_format, quality, output_dir, yt_dlp.utils.DownloadCancelled
    )
    url = f"https://www.youtube.com/watch?v={video_id}"

    if job.get("cancel_requested"):
        job["status"] = "cancelled"
        return

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
    if not info:
        raise ValueError("Download failed — no info returned")
    _complete_yt_download(job, info, audio_format, output_dir)


async def _run_yt_download_job(
    job: JsonObject, audio_format: str, quality: str, output_dir: str
) -> None:
    """Background task wrapper that records failures on the job."""
    try:
        # Dedicated executor, NOT asyncio.to_thread: to_thread shares the
        # loop's default pool with all other endpoints' blocking calls.
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            _yt_download_executor,
            _yt_download_sync,
            job,
            audio_format,
            quality,
            output_dir,
        )
    except Exception as e:
        if job.get("cancel_requested"):
            job["status"] = "cancelled"
            job["error"] = None
            log.info(f"YT download cancelled for {job['video_id']}")
        else:
            log.error(f"YT download failed for {job['video_id']}: {e}")
            job["status"] = "failed"
            job["error"] = str(e)


@app.post("/yt/download")
async def yt_download(req: YtDownloadRequest) -> JsonObject:
    """
    Start a background audio download for a regular YouTube video.
    Returns {job_id, status} immediately; poll GET /yt/download/{job_id}
    for progress. Uses yt-dlp with FFmpeg postprocessors for format
    conversion, metadata embedding, and thumbnail embedding.
    No OAuth required.
    """
    video_id = req.video_id
    output_dir = YT_DOWNLOAD_DIR
    audio_format = req.format.lower()

    if audio_format not in ("mp3", "opus", "flac", "m4a"):
        raise HTTPException(status_code=400, detail=f"Unsupported format: {audio_format}")

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Reuse a non-terminal job for the same video: a second concurrent
    # yt-dlp run would clash on the same output path, and during the
    # postprocessing window the raw container file would falsely satisfy
    # the on-disk idempotency check below. No awaits between this check
    # and job registration, so it is atomic on the event loop.
    active = find_active_download_job(_yt_download_jobs, video_id)
    if active:
        log.info(
            f"YT download already in flight for {video_id} "
            f"(job={active['job_id']}, status={active['status']})"
        )
        return {"job_id": active["job_id"], "status": active["status"]}

    # Check for existing download (idempotent)
    existing = find_existing_download(output_dir, video_id)
    if existing:
        log.info(f"YT download already exists: {existing}")
        job = _new_yt_download_job(
            video_id,
            status="completed",
            source=req.source,
            source_kind=req.source_kind,
        )
        job["progress_pct"] = 100.0
        job["file_path"] = existing
        job["title"] = os.path.basename(existing)
        job["already_existed"] = True
        return {"job_id": job["job_id"], "status": job["status"]}

    job = _new_yt_download_job(video_id, source=req.source, source_kind=req.source_kind)
    task = asyncio.create_task(_run_yt_download_job(job, audio_format, req.quality, output_dir))
    _yt_download_tasks.add(task)
    task.add_done_callback(_yt_download_tasks.discard)
    log.info(
        f"YT download queued for {video_id} "
        f"(job={job['job_id']}, format={audio_format}, quality={req.quality})"
    )
    return {"job_id": job["job_id"], "status": job["status"]}


@app.get("/yt/download/{job_id}")
async def yt_download_status(job_id: str) -> JsonObject:
    """
    Return the status of a download job started via POST /yt/download.
    404 when the job is unknown (e.g. after a sidecar restart).
    """
    job = _yt_download_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Download job not found")
    return _yt_download_job_payload(job)


@app.get("/yt/downloads")
async def yt_downloads_list() -> JsonObject:
    """
    List all known download jobs (active + recent terminal within the 6h
    TTL), newest first, for the downloads view. The store is in-memory and
    per-pod, so it resets on a sidecar restart.
    """
    _prune_yt_download_jobs()
    jobs = sorted(
        _yt_download_jobs.values(),
        key=lambda j: j.get("created_at") or 0,
        reverse=True,
    )
    return {"jobs": [_yt_download_job_payload(j) for j in jobs]}


@app.delete("/yt/downloads/{job_id}")
async def yt_download_cancel(job_id: str) -> JsonObject:
    """
    Cancel a download job. A still-queued job never starts; an in-flight job
    is aborted at its next progress tick. Terminal jobs are a no-op. 404 when
    the job is unknown.
    """
    job = _yt_download_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Download job not found")
    if job["status"] in TERMINAL_DOWNLOAD_STATUSES:
        return _yt_download_job_payload(job)
    job["cancel_requested"] = True
    if job["status"] == "queued":
        # Not yet picked up by a worker — settle it terminally now; the
        # worker's pre-download check also bails if it starts in the meantime.
        job["status"] = "cancelled"
    log.info(f"YT download cancel requested for {job['video_id']} (job={job_id})")
    return _yt_download_job_payload(job)
