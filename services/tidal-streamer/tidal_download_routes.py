"""Administrative TIDAL track and album download routes."""

import asyncio

from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
from tidal_album_artist import _album_primary_artist_name
from tidal_auth import require_admin_credentials
from tidal_downloads import (
    _download_album_tracks,
    _download_track_sync,
    _get_album_with_tracks,
)
from tidal_models import AdminCredentials, DownloadAlbumRequest, DownloadTrackRequest
from tidal_play_downloads import (
    PlayDownload,
    find_play_download,
    listen,
    start_play_download,
    wait_play_download,
)
from tidal_runtime import MUSIC_PATH, JsonObject, _build_api, _sanitized_http_error, app
from tiddl.core.api import ApiError


def _api_error_status(error: Exception) -> int:
    """Report TIDAL credential rejections as 401 so callers refresh and retry."""
    return 401 if getattr(error, "status", None) == 401 else 400


@app.post("/download/track")
async def download_track(
    req: DownloadTrackRequest,
    creds: AdminCredentials = Depends(  # noqa: B008 -- FastAPI dependency declaration
        require_admin_credentials
    ),
) -> JsonObject:
    """Download one track using the resolved administrative credentials."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        return await asyncio.to_thread(
            _download_track_sync,
            api=api,
            track_id=req.track_id,
            quality=req.quality,
            output_template=req.output_template,
            dest_base=MUSIC_PATH,
        )
    except ApiError as error:
        raise _sanitized_http_error(
            f"TIDAL API download for track {req.track_id}",
            error,
            _api_error_status(error),
            "TIDAL API error",
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            f"download for track {req.track_id}", error, 500, "Download failed"
        ) from error


@app.post("/download/album")
async def download_album(
    req: DownloadAlbumRequest,
    creds: AdminCredentials = Depends(  # noqa: B008 -- FastAPI dependency declaration
        require_admin_credentials
    ),
) -> JsonObject:
    """Download an album using the resolved administrative credentials."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        album, tracks = await asyncio.to_thread(_get_album_with_tracks, api, req.album_id)
        results, errors = await _download_album_tracks(
            api,
            tracks,
            req,
            MUSIC_PATH,
            _download_track_sync,
        )
        return {
            "album_id": req.album_id,
            "album_title": album.title,
            "artist": _album_primary_artist_name(album) or "Unknown",
            "total_tracks": len(tracks),
            "downloaded": len(results),
            "failed": len(errors),
            "tracks": results,
            "errors": errors,
        }
    except ApiError as error:
        raise _sanitized_http_error(
            f"TIDAL API download for album {req.album_id}",
            error,
            _api_error_status(error),
            "TIDAL API error",
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            f"download for album {req.album_id}", error, 500, "Download failed"
        ) from error


def _play_download_headers(download: PlayDownload) -> dict[str, str]:
    """Describe the download and the audio listeners receive."""
    headers = {
        "Cache-Control": "no-cache",
        "X-Download-Id": download.download_id,
        "X-Tidal-Quality": download.quality,
        "X-Tidal-Codec": download.codec,
    }
    if download.bit_depth:
        headers["X-Tidal-Bit-Depth"] = str(download.bit_depth)
    if download.sample_rate:
        headers["X-Tidal-Sample-Rate"] = str(download.sample_rate)
    return headers


@app.post("/download/track/play")
async def play_download_track(
    req: DownloadTrackRequest,
    creds: AdminCredentials = Depends(  # noqa: B008 -- FastAPI dependency declaration
        require_admin_credentials
    ),
) -> StreamingResponse:
    """Download one track into the library and stream its bytes as they arrive."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        download = await start_play_download(
            api,
            req.track_id,
            req.quality,
            req.output_template,
            MUSIC_PATH,
        )
    except ApiError as error:
        raise _sanitized_http_error(
            f"TIDAL API play download for track {req.track_id}",
            error,
            _api_error_status(error),
            "TIDAL API error",
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            f"play download for track {req.track_id}", error, 500, "Download failed"
        ) from error
    return StreamingResponse(
        listen(download),
        media_type=download.content_type,
        headers=_play_download_headers(download),
    )


@app.get("/download/track/play/{download_id}")
async def play_download_result(download_id: str) -> JsonObject:
    """Wait for a play download to be installed and describe the file."""
    download = find_play_download(download_id)
    if download is None:
        raise HTTPException(status_code=404, detail="Unknown play download")
    try:
        return await wait_play_download(download)
    except TimeoutError as error:
        raise _sanitized_http_error(
            f"play download {download_id}", error, 504, "Download still running"
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            f"play download {download_id}", error, 502, "Download failed"
        ) from error
