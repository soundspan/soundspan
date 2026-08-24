"""TIDAL track downloads and shared DASH manifest handling."""

from __future__ import annotations

import asyncio
import logging
import shutil
from base64 import b64decode
from pathlib import Path
from typing import Any, Protocol
from xml.etree.ElementTree import Element
from xml.etree.ElementTree import fromstring as xml_fromstring

from common.sidecar_runtime_utils import env_float
from tiddl.core.metadata import Cover, add_track_metadata
from tiddl.core.utils import parse_track_stream
from tiddl.core.utils.format import format_template

__all__ = (
    "_DASH_MANIFEST_MIME_TYPE",
    "_MAX_MANIFEST_BYTES",
    "AlbumAPIProtocol",
    "TrackDownloadAPIProtocol",
    "_download_album_tracks",
    "_download_track_sync",
    "_extract_dash_init_url",
    "_finalize_flac_download",
    "_get_album_tracks",
    "_get_album_with_tracks",
    "_parse_dash_mpd",
    "_prepend_dash_init_segment",
    "_resolve_dash_codec",
)

JsonObject = dict[str, Any]
log = logging.getLogger("tidal-streamer")


class TrackDownloadAPIProtocol(Protocol):
    """Typed boundary for the subset needed to download one track."""

    def get_track(self, track_id: int) -> Any: ...

    def get_album(self, album_id: int) -> Any: ...

    def get_track_stream(self, *, track_id: int, quality: str) -> Any: ...


class AlbumAPIProtocol(Protocol):
    """Typed boundary for the subset needed to inspect an album."""

    def get_album(self, album_id: int) -> Any: ...

    def get_album_items(self, album_id: int, *, limit: int, offset: int) -> Any: ...


class _AlbumDownloadRequestProtocol(Protocol):
    """Typed boundary for album download options supplied by the route."""

    @property
    def quality(self) -> str: ...

    @property
    def output_template(self) -> str: ...


class _TrackDownloaderProtocol(Protocol):
    """Typed boundary for the track downloader injected by the route."""

    def __call__(
        self,
        api: TrackDownloadAPIProtocol,
        track_id: int,
        quality: str,
        output_template: str,
        dest_base: Path,
    ) -> JsonObject: ...


def _sanitize_path_component(name: str) -> str:
    """Remove or replace chars that are invalid on most filesystems."""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    return name.strip(". ")


def _sanitize_download_relative_path(rendered_path: str) -> Path:
    """Validate and sanitize every rendered download-path component."""
    sanitized_parts = []
    for component in rendered_path.split("/"):
        sanitized = _sanitize_path_component(component)
        if not sanitized or sanitized in {".", ".."} or Path(sanitized).is_absolute():
            raise ValueError("Invalid output template path component")
        sanitized_parts.append(sanitized)
    return Path(*sanitized_parts)


def _require_contained_download_path(path: Path, destination_root: Path) -> Path:
    """Resolve a download path and reject targets outside the destination root."""
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(destination_root)
    except ValueError:
        raise ValueError("Download path resolves outside MUSIC_PATH") from None
    return resolved_path


def _build_download_file_path(
    relative_stem: Path,
    file_extension: str,
    dest_base: Path,
) -> tuple[Path, Path, Path]:
    """Build contained final and temporary paths from a rendered template."""
    relative_file = relative_stem.parent / f"{relative_stem.name}{file_extension}"
    destination_root = dest_base.resolve()
    file_path = _require_contained_download_path(
        destination_root / relative_file,
        destination_root,
    )
    tmp_path = _require_contained_download_path(
        file_path.with_suffix(file_path.suffix + ".tmp"),
        destination_root,
    )
    return relative_file, file_path, tmp_path


def _finalize_flac_download(
    tmp_path: Path,
    planned_file_path: Path,
    destination_root: Path,
    track_id: int,
) -> Path:
    """Extract a FLAC stream and return its contained final codec-specific path."""
    from tiddl.core.utils.ffmpeg import FFmpegError, extract_flac

    try:
        converted_path = extract_flac(tmp_path)
    except (FFmpegError, FileNotFoundError) as error:
        log.warning(
            "FLAC extraction failed for track %s: %s; saving original download",
            track_id,
            error,
        )
        return _fallback_flac_download(tmp_path, planned_file_path, destination_root)

    try:
        trusted_converted_path = _require_regular_converted_path(
            converted_path,
            destination_root,
        )
    except ValueError as error:
        log.warning(
            "FLAC extraction returned an unsafe path for track %s: %s; saving original download",
            track_id,
            error,
        )
        return _fallback_flac_download(tmp_path, planned_file_path, destination_root)

    return _install_converted_flac_download(
        tmp_path,
        trusted_converted_path,
        planned_file_path,
        destination_root,
        track_id,
    )


def _require_regular_converted_path(converted_path: Path, destination_root: Path) -> Path:
    """Validate an extractor result before it can become a library file."""
    resolved_path = _require_contained_download_path(converted_path.resolve(), destination_root)
    if converted_path.is_symlink() or not resolved_path.is_file():
        raise ValueError("Converted download is not a regular non-symlink file")
    return resolved_path


def _fallback_flac_download(
    tmp_path: Path,
    planned_file_path: Path,
    destination_root: Path,
) -> Path:
    """Remove ffmpeg output and retain the original download at its planned path."""
    tmp_path.with_suffix(".tmp.flac").unlink(missing_ok=True)
    shutil.move(str(tmp_path), str(planned_file_path))
    _remove_stale_codec_sibling(planned_file_path, destination_root)
    return planned_file_path


def _remove_stale_codec_sibling(final_path: Path, destination_root: Path) -> None:
    """Remove only the opposite known codec sibling beside a completed download."""
    contained_final_path = _require_contained_download_path(final_path, destination_root)
    if contained_final_path.suffix == ".flac":
        sibling_extension = ".m4a"
    elif contained_final_path.suffix == ".m4a":
        sibling_extension = ".flac"
    else:
        return
    sibling_path = contained_final_path.with_suffix(sibling_extension)
    _require_contained_download_path(sibling_path, destination_root)
    sibling_path.unlink(missing_ok=True)


def _cleanup_failed_flac_install(
    tmp_path: Path,
    converted_path: Path,
    final_path: Path,
    track_id: int,
) -> None:
    """Best-effort cleanup that retains one recoverable copy after install failure."""
    if final_path.is_file() and not final_path.is_symlink():
        preserved_path = final_path
    elif tmp_path.is_file() and not tmp_path.is_symlink():
        preserved_path = tmp_path
    else:
        preserved_path = converted_path
    if converted_path != preserved_path:
        _unlink_failed_flac_path(converted_path, track_id)
    if tmp_path != preserved_path:
        _unlink_failed_flac_path(tmp_path, track_id)
    ffmpeg_path = tmp_path.with_suffix(".tmp.flac")
    if ffmpeg_path != preserved_path:
        _unlink_failed_flac_path(ffmpeg_path, track_id)


def _unlink_failed_flac_path(path: Path, track_id: int) -> None:
    """Remove a failed-install artifact without replacing the active exception."""
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        log.warning("Could not clean FLAC artifact for track %s: %s", track_id, error)


def _install_converted_flac_download(
    tmp_path: Path,
    converted_path: Path,
    planned_file_path: Path,
    destination_root: Path,
    track_id: int,
) -> Path:
    """Install a validated extractor result and remove temporary codec siblings."""
    final_path = planned_file_path.with_suffix(converted_path.suffix)
    try:
        final_path = _require_contained_download_path(final_path, destination_root)
        shutil.move(str(converted_path), str(final_path))
        tmp_path.unlink(missing_ok=True)
        tmp_path.with_suffix(".tmp.flac").unlink(missing_ok=True)
        _remove_stale_codec_sibling(final_path, destination_root)
    except Exception:
        _cleanup_failed_flac_install(tmp_path, converted_path, final_path, track_id)
        raise
    return final_path


def _download_track_sync(
    api: TrackDownloadAPIProtocol,
    track_id: int,
    quality: str,
    output_template: str,
    dest_base: Path,
) -> JsonObject:
    """
    Download a single track synchronously.

    Returns a dict with file info on success.
    """
    # 1. Fetch track metadata
    track = api.get_track(track_id)
    album = api.get_album(track.album.id)

    # 2. Build output path from template
    relative_path = format_template(
        template=output_template,
        item=track,
        album=album,
        with_asterisk_ext=False,
    )
    relative_stem = _sanitize_download_relative_path(relative_path)

    # 3. Get stream data
    stream = api.get_track_stream(track_id=track_id, quality=quality)
    urls, file_extension = parse_track_stream(stream)
    urls = _prepend_dash_init_segment(stream, urls, track_id)

    relative_file, file_path, tmp_path = _build_download_file_path(
        relative_stem,
        file_extension,
        dest_base,
    )

    # Download raw bytes
    from tiddl.core.utils.download import download as download_bytes

    stream_data = download_bytes(urls)

    # 4. Write to disk
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Write to temp file first, then move (atomic-ish)
    tmp_path.write_bytes(stream_data)

    # 5. If FLAC, ffmpeg extraction may be needed
    if file_extension == ".flac":
        file_path = _finalize_flac_download(
            tmp_path,
            file_path,
            dest_base.resolve(),
            track_id,
        )
        relative_file = relative_file.with_suffix(file_path.suffix)
    else:
        shutil.move(str(tmp_path), str(file_path))

    # 6. Embed metadata
    try:
        # Fetch cover
        cover = None
        if album.cover:
            cover = Cover(album.cover)

        add_track_metadata(
            path=file_path,
            track=track,
            album_artist=track.artists[0].name if track.artists else "",
            date=str(album.releaseDate.date()) if album.releaseDate else "",
            cover_data=cover.fetch_data() if cover else None,
        )
    except Exception as error:
        log.warning("Failed to embed metadata for track %s: %s", track_id, error)

    return {
        "track_id": track_id,
        "title": track.title,
        "artist": track.artists[0].name if track.artists else "Unknown",
        "album": album.title,
        "quality": stream.audioQuality,
        "file_path": str(file_path),
        "relative_path": relative_file.as_posix(),
        "file_size": file_path.stat().st_size,
    }


# Maximum decoded manifest size we're willing to parse (1 MiB).
_MAX_MANIFEST_BYTES = 1 * 1024 * 1024

_DASH_NS = "{urn:mpeg:dash:schema:mpd:2011}"
_DASH_MANIFEST_MIME_TYPE = "application/dash+xml"


def _parse_dash_mpd(manifest_b64: str) -> Element | None:
    """Decode and parse a base64-encoded DASH MPD manifest.

    Returns the parsed ElementTree root, or ``None`` if the manifest is
    invalid, oversized, or unparseable.  Enforces a size cap to prevent
    resource abuse from unexpectedly large upstream payloads.
    """
    try:
        raw = b64decode(manifest_b64)
        if len(raw) > _MAX_MANIFEST_BYTES:
            log.warning("DASH manifest exceeds size cap (%d bytes)", len(raw))
            return None
        return xml_fromstring(raw.decode())  # noqa: S314 -- input is size-bounded and only queried, not expanded
    except Exception as exc:
        log.debug("Failed to parse DASH MPD manifest: %s", exc)
        return None


def _find_segment_template(tree: Element) -> Element | None:
    """Locate the SegmentTemplate element in a DASH MPD.

    DASH allows SegmentTemplate at either the Representation level or the
    AdaptationSet level.  Try Representation first (most common), then fall
    back to AdaptationSet.
    """
    ns = _DASH_NS
    seg_tpl = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}Representation/{ns}SegmentTemplate")
    if seg_tpl is None:
        seg_tpl = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}SegmentTemplate")
    return seg_tpl


def _extract_dash_init_url(manifest_b64: str) -> str | None:
    """Extract the initialization segment URL from a DASH MPD manifest.

    tiddl's ``parse_manifest_XML`` only returns media segment URLs but omits
    the init segment whose moov atom carries total-duration metadata.  Without
    it the ``<audio>`` element cannot determine the full track length, causing
    the seek bar to show only a single-fragment duration (~4 s).
    """
    tree = _parse_dash_mpd(manifest_b64)
    if tree is None:
        return None
    seg_tpl = _find_segment_template(tree)
    if seg_tpl is not None:
        return seg_tpl.get("initialization")
    return None


def _prepend_dash_init_segment(
    stream: Any,
    urls: list[str],
    track_id: int,
    *,
    warn_on_missing: bool = True,
) -> list[str]:
    """Prepend a DASH initialization URL while preserving download fallback behavior."""
    if getattr(stream, "manifestMimeType", None) != _DASH_MANIFEST_MIME_TYPE:
        return urls

    init_url = _extract_dash_init_url(stream.manifest)
    if not init_url:
        if warn_on_missing:
            log.warning(
                "Could not prepend DASH init segment for track %s; "
                "manifest is invalid or lacks initialization URL",
                track_id,
            )
        return urls

    updated_urls = [init_url, *(url for url in urls if url != init_url)]
    log.info(
        "Prepended DASH init segment for track %s (%d total segments)",
        track_id,
        len(updated_urls),
    )
    return updated_urls


def _resolve_dash_codec(manifest_b64: str) -> str | None:
    """Read the ``codecs`` attribute from the DASH MPD Representation element.

    Returns the raw codec string (e.g. ``"flac"``, ``"mp4a.40.2"``) so the
    caller can report the true codec instead of guessing from the file
    extension.
    """
    tree = _parse_dash_mpd(manifest_b64)
    if tree is None:
        return None
    ns = _DASH_NS
    rep = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}Representation")
    if rep is not None:
        return rep.get("codecs")
    return None


_ALBUM_PAGE_HARD_CAP = 1000


def _get_album_tracks(api: AlbumAPIProtocol, album_id: int) -> list[Any]:
    """Fetch downloadable album tracks with bounded offset pagination."""
    assert album_id is not None  # noqa: S101 -- internal typed invariant before paginated API calls

    tracks = []
    offset = 0
    page_size = 100
    for _ in range(_ALBUM_PAGE_HARD_CAP):
        items = api.get_album_items(album_id, limit=page_size, offset=offset)
        page = list(getattr(items, "items", None) or [])
        for album_item in page:
            if hasattr(album_item, "item") and hasattr(album_item.item, "isrc"):
                tracks.append(album_item.item)
        if not page:
            break
        offset += len(page)
        total = getattr(items, "totalNumberOfItems", 0) or 0
        if offset >= total:
            break
    return tracks


def _get_album_with_tracks(api: AlbumAPIProtocol, album_id: int) -> tuple[Any, list[Any]]:
    """Fetch album metadata and its paginated tracks synchronously."""
    album = api.get_album(album_id)
    tracks = _get_album_tracks(api, album_id)
    return album, tracks


async def _download_album_tracks(
    api: TrackDownloadAPIProtocol,
    tracks: list[Any],
    req: _AlbumDownloadRequestProtocol,
    dest_base: Path,
    download_track_sync: _TrackDownloaderProtocol,
) -> tuple[list[JsonObject], list[JsonObject]]:
    """Download album tracks sequentially and return successes and failures."""
    results = []
    errors = []
    for index, track in enumerate(tracks):
        if index > 0:
            delay = env_float("TIDAL_TRACK_DELAY", "3")
            log.debug(
                "Rate limit: waiting %ss before track %s/%s",
                delay,
                index + 1,
                len(tracks),
            )
            await asyncio.sleep(delay)
        try:
            result = await asyncio.to_thread(
                download_track_sync,
                api=api,
                track_id=track.id,
                quality=req.quality,
                output_template=req.output_template,
                dest_base=dest_base,
            )
            results.append(result)
        except Exception as error:
            log.error(
                "Failed to download track %s (%s): %s",
                track.id,
                track.title,
                error,
            )
            errors.append(
                {
                    "track_id": track.id,
                    "title": track.title,
                    "error": "Download failed",
                }
            )
    return results, errors
