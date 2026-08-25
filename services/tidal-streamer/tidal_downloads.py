"""TIDAL track downloads and shared DASH manifest handling."""

from __future__ import annotations

import asyncio
import logging
import shutil
import threading
from base64 import b64decode
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import uuid4
from xml.etree.ElementTree import Element
from xml.etree.ElementTree import fromstring as xml_fromstring

from common.download_paths import (
    require_contained_download_path as _require_contained_download_path,
)
from common.download_paths import (
    sanitize_download_relative_path as _sanitize_download_relative_path,
)
from common.sidecar_runtime_utils import env_float
from mutagen.easymp4 import EasyMP4
from mutagen.flac import FLAC
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

_MAX_FILENAME_BYTES = 255
_MAX_COLLISION_COUNTER = 5
# Backend queue claims serialize downloads across replicas; this lock closes in-process races.
_DOWNLOAD_INSTALL_LOCK = threading.Lock()


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


def _build_download_file_path(
    relative_stem: Path,
    file_extension: str,
    dest_base: Path,
) -> tuple[Path, Path, Path]:
    """Build a final path and a ``<stem>.<32 lowercase uuid4 hex>.tmp`` path."""
    relative_file = relative_stem.parent / f"{relative_stem.name}{file_extension}"
    destination_root = dest_base.resolve()
    file_path = _require_contained_download_path(
        destination_root / relative_file,
        destination_root,
    )
    temporary_name = _build_bounded_filename(
        file_path.stem,
        f".{uuid4().hex}",
        ".tmp",
    )
    tmp_path = _require_contained_download_path(
        file_path.with_name(temporary_name),
        destination_root,
    )
    return relative_file, file_path, tmp_path


def _build_bounded_filename(stem: str, suffix: str, extension: str) -> str:
    """Build one UTF-8 filename component within the common 255-byte limit."""
    reserved_bytes = len(f"{suffix}{extension}".encode())
    stem_budget = _MAX_FILENAME_BYTES - reserved_bytes
    if stem_budget < 1:
        raise ValueError("Download filename suffix exceeds the 255-byte component limit")
    bounded_stem = stem.encode()[:stem_budget].decode(errors="ignore")
    if not bounded_stem:
        raise ValueError("Download filename has no stem within the 255-byte component limit")
    return f"{bounded_stem}{suffix}{extension}"


def _parse_tidal_comment(tag_values: object) -> int | None:
    """Parse the single identity value written by tiddl's comment metadata."""
    if not isinstance(tag_values, list) or not tag_values:
        return None
    comment = tag_values[0]
    if not isinstance(comment, str) or not comment.startswith("tidal:"):
        return None
    track_id = comment.removeprefix("tidal:")
    if not track_id.isdigit():
        return None
    return int(track_id)


def _read_embedded_tidal_id(path: Path) -> int | None:
    """Read a tiddl-written track identity, returning None for every failure."""
    try:
        if path.suffix.lower() == ".flac":
            return _parse_tidal_comment(FLAC(path).get("COMMENT"))
        if path.suffix.lower() == ".m4a":
            return _parse_tidal_comment(EasyMP4(path).get("comment"))
    except Exception:
        return None
    return None


def _resolve_final_download_path(
    planned_path: Path,
    destination_root: Path,
    track_id: int,
) -> Path:
    """Reuse planned legacy files but require identity for occupied suffixes."""
    candidates = _build_download_candidates(planned_path, track_id)
    for candidate_index, candidate in enumerate(candidates):
        contained_candidate = _require_contained_download_path(candidate, destination_root)
        if not contained_candidate.exists():
            if contained_candidate != planned_path:
                log.info(
                    "Download path collision at %s; saving track %s to %s",
                    planned_path,
                    track_id,
                    contained_candidate,
                )
            return contained_candidate
        embedded_id = _read_embedded_tidal_id(contained_candidate)
        if embedded_id == track_id:
            if contained_candidate != planned_path:
                log.info(
                    "Download path collision at %s; saving track %s to %s",
                    planned_path,
                    track_id,
                    contained_candidate,
                )
            return contained_candidate
        if candidate_index == 0 and embedded_id is None:
            log.debug(
                "Refreshing unidentified legacy file at planned path %s for track %s",
                contained_candidate,
                track_id,
            )
            return contained_candidate

    raise RuntimeError(
        f"No safe download path for TIDAL track {track_id}; all {len(candidates)} candidates "
        "are occupied by other or unidentified files"
    )


def _build_download_candidates(planned_path: Path, track_id: int) -> tuple[Path, ...]:
    """Build the planned path and five byte-bounded identity alternatives."""
    candidates = [planned_path]
    for counter in range(1, _MAX_COLLISION_COUNTER + 1):
        identity_suffix = (
            f" [tidal-{track_id}]" if counter == 1 else f" [tidal-{track_id}-{counter}]"
        )
        candidate_name = _build_bounded_filename(
            planned_path.stem,
            identity_suffix,
            planned_path.suffix,
        )
        candidates.append(planned_path.with_name(candidate_name))
    return tuple(candidates)


def _finalize_flac_download(
    tmp_path: Path,
    planned_file_path: Path,
    destination_root: Path,
    track_id: int,
) -> Path:
    """Extract a FLAC stream and return its contained final codec-specific path."""
    from tiddl.core.utils.ffmpeg import FFmpegError, extract_flac

    try:
        try:
            converted_path = extract_flac(tmp_path)
        except (FFmpegError, FileNotFoundError) as error:
            log.warning(
                "FLAC extraction failed for track %s: %s; saving original download",
                track_id,
                error,
            )
            return _fallback_flac_download(
                tmp_path,
                planned_file_path,
                destination_root,
                track_id,
            )

        try:
            trusted_converted_path = _require_regular_converted_path(
                converted_path,
                destination_root,
            )
        except ValueError as error:
            log.warning(
                "FLAC extraction returned an unsafe path for track %s: %s; "
                "saving original download",
                track_id,
                error,
            )
            return _fallback_flac_download(
                tmp_path,
                planned_file_path,
                destination_root,
                track_id,
            )

        return _install_converted_flac_download(
            tmp_path,
            trusted_converted_path,
            planned_file_path,
            destination_root,
            track_id,
        )
    except Exception:
        _cleanup_staged_download(tmp_path, track_id)
        raise


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
    track_id: int,
) -> Path:
    """Remove ffmpeg output and retain the original download at its planned path."""
    _cleanup_extractor_intermediates(tmp_path, track_id, None)
    final_path = _resolve_final_download_path(planned_file_path, destination_root, track_id)
    shutil.move(str(tmp_path), str(final_path))
    return final_path


def _remove_stale_codec_siblings(
    planned_path: Path,
    final_path: Path,
    destination_root: Path,
    track_id: int,
) -> None:
    """Remove current-track codec siblings for both planned and resolved stems."""
    contained_planned_path = _require_contained_download_path(planned_path, destination_root)
    contained_final_path = _require_contained_download_path(final_path, destination_root)
    sibling_extension = _opposite_codec_extension(contained_final_path)
    if sibling_extension is None:
        return
    sibling_paths = {
        contained_planned_path.with_suffix(sibling_extension),
        contained_final_path.with_suffix(sibling_extension),
    }
    for sibling_path in sibling_paths:
        _remove_owned_codec_sibling(sibling_path, destination_root, track_id)


def _opposite_codec_extension(path: Path) -> str | None:
    """Return the other supported library codec extension."""
    if path.suffix == ".flac":
        return ".m4a"
    if path.suffix == ".m4a":
        return ".flac"
    return None


def _remove_owned_codec_sibling(
    sibling_path: Path,
    destination_root: Path,
    track_id: int,
) -> None:
    """Remove one sibling only when its embedded identity matches the download."""
    contained_sibling_path = _require_contained_download_path(sibling_path, destination_root)
    if not contained_sibling_path.exists():
        return
    sibling_track_id = _read_embedded_tidal_id(contained_sibling_path)
    # Planned UNKNOWN files may be refreshed, but deletion requires positive ownership proof.
    if sibling_track_id != track_id:
        log.debug(
            "Keeping codec sibling %s for track %s because its embedded TIDAL id is %s",
            contained_sibling_path,
            track_id,
            sibling_track_id,
        )
        return
    contained_sibling_path.unlink()


def _cleanup_failed_flac_install(
    tmp_path: Path,
    converted_path: Path,
    track_id: int,
) -> None:
    """Remove UUID staging and a validated extractor result after failure."""
    _cleanup_staged_download(tmp_path, track_id)
    if converted_path not in _extractor_intermediate_paths(tmp_path):
        _unlink_staged_path(converted_path, track_id)


def _extractor_intermediate_paths(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Return every filename shape the FLAC extractor can derive from UUID staging."""
    return (
        tmp_path.with_suffix(".flac"),
        tmp_path.with_suffix(".m4a"),
        tmp_path.with_suffix(".tmp.flac"),
    )


def _cleanup_extractor_intermediates(
    tmp_path: Path,
    track_id: int,
    additional_path: Path | None,
) -> None:
    """Best-effort remove bounded extractor intermediates for one staged download."""
    intermediate_paths = _extractor_intermediate_paths(tmp_path)
    for intermediate_path in intermediate_paths:
        _unlink_staged_path(intermediate_path, track_id)
    if additional_path is not None and additional_path not in intermediate_paths:
        _unlink_staged_path(additional_path, track_id)


def _cleanup_staged_download(tmp_path: Path, track_id: int) -> None:
    """Best-effort remove the exact UUID temp and its known extractor outputs."""
    _unlink_staged_path(tmp_path, track_id)
    _cleanup_extractor_intermediates(tmp_path, track_id, None)


def _unlink_staged_path(path: Path, track_id: int) -> None:
    """Remove a staged artifact without replacing the active exception."""
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        log.warning("Could not clean staged artifact for track %s: %s", track_id, error)


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
        final_path = _resolve_final_download_path(final_path, destination_root, track_id)
        shutil.move(str(converted_path), str(final_path))
    except Exception:
        _cleanup_failed_flac_install(tmp_path, converted_path, track_id)
        raise
    _cleanup_staged_download(tmp_path, track_id)
    return final_path


def _install_staged_download(
    tmp_path: Path,
    planned_file_path: Path,
    file_extension: str,
    destination_root: Path,
    track_id: int,
) -> Path:
    """Move one staged download into its identity-checked final candidate."""
    if file_extension == ".flac":
        return _finalize_flac_download(
            tmp_path,
            planned_file_path,
            destination_root,
            track_id,
        )
    final_path = _resolve_final_download_path(
        planned_file_path,
        destination_root,
        track_id,
    )
    shutil.move(str(tmp_path), str(final_path))
    return final_path


def _fetch_download_cover(album: Any, track_id: int) -> tuple[bool, bytes | None]:
    """Fetch optional cover bytes before installation without failing the audio download."""
    if not album.cover:
        return True, None
    try:
        return True, cast(bytes, Cover(album.cover).fetch_data())
    except Exception as error:
        log.warning("Failed to embed metadata for track %s: %s", track_id, error)
        return False, None


def _embed_download_metadata(
    path: Path,
    track: Any,
    album: Any,
    track_id: int,
    cover_data: bytes | None,
) -> None:
    """Embed metadata and retain the completed audio when tagging fails."""
    try:
        add_track_metadata(
            path=path,
            track=track,
            album_artist=track.artists[0].name if track.artists else "",
            date=str(album.releaseDate.date()) if album.releaseDate else "",
            cover_data=cover_data,
            comment=f"tidal:{track_id}",
        )
    except Exception as error:
        log.warning("Failed to embed metadata for track %s: %s", track_id, error)


def _install_download_with_metadata(
    tmp_path: Path,
    planned_file_path: Path,
    file_extension: str,
    destination_root: Path,
    track_id: int,
    track: Any,
    album: Any,
) -> Path:
    """Serialize candidate allocation, installation, tagging, and codec cleanup."""
    cover_fetched, cover_data = _fetch_download_cover(album, track_id)
    with _DOWNLOAD_INSTALL_LOCK:
        final_path = _install_staged_download(
            tmp_path,
            planned_file_path,
            file_extension,
            destination_root,
            track_id,
        )
        if cover_fetched:
            _embed_download_metadata(final_path, track, album, track_id, cover_data)
        _remove_stale_codec_siblings(
            planned_file_path,
            final_path,
            destination_root,
            track_id,
        )
    return final_path


def _build_download_result(
    track: Any,
    album: Any,
    stream: Any,
    track_id: int,
    file_path: Path,
    relative_file: Path,
) -> JsonObject:
    """Describe one installed track for the download API response."""
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

    _relative_file, planned_file_path, tmp_path = _build_download_file_path(
        relative_stem,
        file_extension,
        dest_base,
    )

    # Download raw bytes
    from tiddl.core.utils.download import download as download_bytes

    stream_data = download_bytes(urls)

    # 4. Write to disk
    planned_file_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        # The 33-byte ``.<uuid4 hex>`` infix is included in the 255-byte name budget.
        tmp_path.write_bytes(stream_data)

        # 5-6. Install, embed identity, then clean only same-track codec siblings.
        destination_root = dest_base.resolve()
        file_path = _install_download_with_metadata(
            tmp_path,
            planned_file_path,
            file_extension,
            destination_root,
            track_id,
            track,
            album,
        )
    except Exception:
        _cleanup_staged_download(tmp_path, track_id)
        raise
    relative_file = file_path.relative_to(destination_root)
    return _build_download_result(track, album, stream, track_id, file_path, relative_file)


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
