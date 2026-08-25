"""Administrative TIDAL track and album download routes."""

import asyncio

from fastapi import Depends
from tidal_auth import require_admin_credentials
from tidal_downloads import (
    _download_album_tracks,
    _download_track_sync,
    _get_album_with_tracks,
)
from tidal_models import AdminCredentials, DownloadAlbumRequest, DownloadTrackRequest
from tidal_runtime import MUSIC_PATH, JsonObject, _build_api, _sanitized_http_error, app
from tiddl.core.api import ApiError


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
            400,
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
            "artist": album.artist.name if album.artist else "Unknown",
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
            400,
            "TIDAL API error",
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            f"download for album {req.album_id}", error, 500, "Download failed"
        ) from error
