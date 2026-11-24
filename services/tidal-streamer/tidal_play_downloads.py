"""Download one TIDAL track into the library while streaming it to listeners.

A play download fetches a track once from TIDAL and hands every listener its
bytes as they arrive. When the last segment lands, the same bytes are
installed exactly like ``/download/track`` (FLAC extraction, tags, identity
checks). Listeners joining a running download replay it from the start, and the
download finishes even if every listener leaves, so nothing plays without
ending up in the library.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any
from uuid import uuid4

from tidal_downloads import (
    _DASH_MANIFEST_MIME_TYPE,
    JsonObject,
    TrackDownloadAPIProtocol,
    _install_track_download,
    _plan_track_download,
    _resolve_dash_codec,
)
from tidal_runtime import log

from services.common.sidecar_runtime_utils import build_stream_proxy_client

# Finished downloads keep their result (not their audio) this long for the
# backend to collect.
_RESULT_TTL_SECONDS = 600.0
_RESULT_WAIT_SECONDS = 600.0
_CHUNK_SIZE = 65536


@dataclass
class PlayDownload:
    """One running or finished play download."""

    download_id: str
    track_id: int
    content_type: str
    quality: str
    codec: str
    bit_depth: int | None
    sample_rate: int | None
    chunks: list[bytes] = field(default_factory=list)
    finished: bool = False
    listeners: int = 0
    result: JsonObject | None = None
    error: Exception | None = None
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)

    def has_audio_after(self, seen: int) -> bool:
        """Whether a listener that has `seen` chunks has something to do."""
        return seen < len(self.chunks) or self.finished

    def release_audio_when_idle(self) -> None:
        """Drop buffered audio once it is installed and nobody is listening."""
        if self.finished and self.listeners == 0:
            self.chunks = []


_ACTIVE_BY_TRACK: dict[int, PlayDownload] = {}
_BY_ID: dict[str, PlayDownload] = {}
_TASKS: set[asyncio.Task[None]] = set()


def _stream_format(stream: Any, file_extension: str) -> tuple[str, str]:
    """Content type and codec label of the bytes listeners receive."""
    if getattr(stream, "manifestMimeType", None) == _DASH_MANIFEST_MIME_TYPE:
        codec = (_resolve_dash_codec(stream.manifest) or "").lower()
        if codec.startswith("mp4a"):
            codec = "aac"
        return "audio/mp4", codec or "aac"
    if file_extension == ".flac":
        return "audio/flac", "flac"
    return "audio/mp4", "aac"


async def start_play_download(
    api: TrackDownloadAPIProtocol,
    track_id: int,
    quality: str,
    output_template: str,
    dest_base: Path,
) -> PlayDownload:
    """Join the running download of a track or start a new one."""
    running = _ACTIVE_BY_TRACK.get(track_id)
    if running is not None:
        return running
    plan = await asyncio.to_thread(
        _plan_track_download, api, track_id, quality, output_template, dest_base
    )
    running = _ACTIVE_BY_TRACK.get(track_id)
    if running is not None:
        return running
    content_type, codec = _stream_format(plan.stream, plan.file_extension)
    download = PlayDownload(
        download_id=uuid4().hex,
        track_id=track_id,
        content_type=content_type,
        quality=str(getattr(plan.stream, "audioQuality", "") or ""),
        codec=codec,
        bit_depth=getattr(plan.stream, "bitDepth", None),
        sample_rate=getattr(plan.stream, "sampleRate", None),
    )
    _ACTIVE_BY_TRACK[track_id] = download
    _BY_ID[download.download_id] = download
    task = asyncio.create_task(_run_play_download(download, plan))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return download


async def _run_play_download(download: PlayDownload, plan: Any) -> None:
    """Fetch every segment once, then install the complete file."""
    client = build_stream_proxy_client()
    try:
        for url in plan.urls:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(_CHUNK_SIZE):
                    async with download.changed:
                        download.chunks.append(chunk)
                        download.changed.notify_all()
        data = b"".join(download.chunks)
        download.result = await asyncio.to_thread(_install_track_download, plan, data)
        log.info(
            "Play download installed track %s at %s",
            download.track_id,
            download.result.get("relative_path"),
        )
    except Exception as error:
        download.error = error
        log.error("Play download failed for track %s: %s", download.track_id, error)
    finally:
        await client.aclose()
        if _ACTIVE_BY_TRACK.get(download.track_id) is download:
            del _ACTIVE_BY_TRACK[download.track_id]
        async with download.changed:
            download.finished = True
            download.changed.notify_all()
        download.release_audio_when_idle()
        asyncio.get_running_loop().call_later(
            _RESULT_TTL_SECONDS, _BY_ID.pop, download.download_id, None
        )


async def listen(download: PlayDownload) -> AsyncGenerator[bytes, None]:
    """Yield a download's bytes from the start, waiting for new ones."""
    download.listeners += 1
    index = 0
    try:
        while True:
            async with download.changed:
                await download.changed.wait_for(partial(download.has_audio_after, index))
                pending = download.chunks[index:]
                finished = download.finished
            for chunk in pending:
                yield chunk
            index += len(pending)
            if finished and index >= len(download.chunks):
                return
    finally:
        download.listeners -= 1
        download.release_audio_when_idle()


def find_play_download(download_id: str) -> PlayDownload | None:
    """A download started by this sidecar within the result window."""
    return _BY_ID.get(download_id)


async def wait_play_download(download: PlayDownload) -> JsonObject:
    """Wait for a download to install; raises its failure or a timeout."""
    async with download.changed:
        await asyncio.wait_for(
            download.changed.wait_for(lambda: download.finished),
            timeout=_RESULT_WAIT_SECONDS,
        )
    if download.error is not None:
        raise download.error
    if download.result is None:
        raise RuntimeError("Play download finished without a result")
    return download.result
