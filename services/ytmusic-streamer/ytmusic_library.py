"""Authenticated metadata and user-library HTTP routes."""

import asyncio
from typing import Literal, cast

from fastapi import HTTPException, Query
from ytmusic_client import _get_public_ytmusic, _run_ytmusic_with_auth_retry
from ytmusic_runtime import JsonObject, _sanitized_http_error, app
from ytmusic_stream import _browse_public_bounded, _validate_video_id

_AUTO_PLAYLIST_PREFIXES = ("RDTMAK", "RDEM", "RDAMPL", "RDAuto", "RDCLAK", "RDAO")
_SPECIAL_PLAYLIST_IDS = {"LM", "SE", "RDPN"}


def _format_album_response(browse_id: str, album: JsonObject) -> JsonObject:
    """Build a normalized album response dict from a ytmusicapi get_album() result."""
    tracks = []
    for t in album.get("tracks", []):
        artists = t.get("artists", [])
        tracks.append(
            {
                "videoId": t.get("videoId"),
                "title": t.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a.get("name") for a in artists],
                "trackNumber": t.get("trackNumber"),
                "duration": t.get("duration"),
                "duration_seconds": t.get("duration_seconds"),
                "isExplicit": t.get("isExplicit", False),
                "likeStatus": t.get("likeStatus"),
            }
        )

    thumbnails = album.get("thumbnails", [])
    return {
        "browseId": browse_id,
        "title": album.get("title"),
        "artist": album.get("artists", [{}])[0].get("name") if album.get("artists") else "Unknown",
        "artists": [a.get("name") for a in album.get("artists", [])],
        "year": album.get("year"),
        "trackCount": album.get("trackCount"),
        "duration": album.get("duration"),
        "type": album.get("type", "Album"),
        "thumbnails": thumbnails,
        "coverUrl": thumbnails[-1].get("url") if thumbnails else None,
        "tracks": tracks,
        "description": album.get("description"),
    }


@app.get("/album/{browse_id}")
async def get_album(browse_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get album details and track listing from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    try:
        if user_id == "__public__":
            yt = _get_public_ytmusic("native")
            album = await _browse_public_bounded(yt.get_album, browse_id)
        else:
            album = await asyncio.to_thread(
                _run_ytmusic_with_auth_retry,
                user_id,
                operation=f"get_album({browse_id})",
                func=lambda yt: yt.get_album(browse_id),
            )
        return _format_album_response(browse_id, album)
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(f"Get album {browse_id}", e, 500, "Failed to load album") from e


@app.get("/artist/{channel_id}")
async def get_artist(channel_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get artist details from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    try:
        if user_id == "__public__":
            yt = _get_public_ytmusic("native")
            artist = await _browse_public_bounded(yt.get_artist, channel_id)
        else:
            artist = await asyncio.to_thread(
                _run_ytmusic_with_auth_retry,
                user_id,
                operation=f"get_artist({channel_id})",
                func=lambda yt: yt.get_artist(channel_id),
            )

        songs = []
        for s in (artist.get("songs", {}).get("results", []))[:10]:
            artists = s.get("artists", [])
            songs.append(
                {
                    "videoId": s.get("videoId"),
                    "title": s.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "album": s.get("album", {}).get("name") if s.get("album") else None,
                    "duration": s.get("duration"),
                }
            )

        albums = []
        for a in (artist.get("albums", {}).get("results", []))[:20]:
            albums.append(
                {
                    "browseId": a.get("browseId"),
                    "title": a.get("title"),
                    "year": a.get("year"),
                    "type": a.get("type", "Album"),
                    "thumbnails": a.get("thumbnails", []),
                }
            )

        thumbnails = artist.get("thumbnails", [])
        return {
            "channelId": channel_id,
            "name": artist.get("name"),
            "description": artist.get("description"),
            "thumbnails": thumbnails,
            "subscribers": artist.get("subscribers"),
            "songs": songs,
            "albums": albums,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get artist {channel_id}", e, 500, "Failed to load artist"
        ) from e


@app.get("/song/{video_id}")
async def get_song(video_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get song metadata from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    video_id = _validate_video_id(video_id)
    try:
        if user_id == "__public__":
            yt = _get_public_ytmusic("native")
            song = await _browse_public_bounded(yt.get_song, video_id)
        else:
            song = await asyncio.to_thread(
                _run_ytmusic_with_auth_retry,
                user_id,
                operation=f"get_song({video_id})",
                func=lambda yt: yt.get_song(video_id),
            )
        video_details = song.get("videoDetails", {})

        return {
            "videoId": video_details.get("videoId"),
            "title": video_details.get("title"),
            "artist": video_details.get("author"),
            "duration": int(video_details.get("lengthSeconds", 0)),
            "thumbnails": video_details.get("thumbnail", {}).get("thumbnails", []),
            "isOwner": video_details.get("isOwnerViewing", False),
            "viewCount": video_details.get("viewCount"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(f"Get song {video_id}", e, 500, "Failed to load song") from e


@app.get("/library/songs")
async def library_songs(
    user_id: str = Query(...), limit: int = 100, order: str = "recently_added"
) -> JsonObject:
    """Get user's liked/library songs from YouTube Music."""
    try:
        songs = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_library_songs(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_songs(
                limit=limit,
                order=cast(Literal["a_to_z", "z_to_a", "recently_added"], order),
            ),
        )
        items = []
        for s in songs:
            artists = s.get("artists", [])
            album = s.get("album", {}) or {}
            items.append(
                {
                    "videoId": s.get("videoId"),
                    "title": s.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "artists": [a.get("name") for a in artists],
                    "album": album.get("name") if album else None,
                    "duration": s.get("duration"),
                    "duration_seconds": s.get("duration_seconds"),
                    "thumbnails": s.get("thumbnails", []),
                }
            )
        return {"songs": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get library songs for user {user_id}",
            e,
            500,
            "Failed to load library songs",
        ) from e


@app.get("/library/albums")
async def library_albums(
    user_id: str = Query(...), limit: int = 100, order: str = "recently_added"
) -> JsonObject:
    """Get user's saved albums from YouTube Music."""
    try:
        albums = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_library_albums(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_albums(
                limit=limit,
                order=cast(Literal["a_to_z", "z_to_a", "recently_added"], order),
            ),
        )
        items = []
        for a in albums:
            artists = a.get("artists", [])
            items.append(
                {
                    "browseId": a.get("browseId"),
                    "title": a.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "artists": [a_name.get("name") for a_name in artists],
                    "year": a.get("year"),
                    "thumbnails": a.get("thumbnails", []),
                    "type": a.get("type", "Album"),
                }
            )
        return {"albums": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get library albums for user {user_id}",
            e,
            500,
            "Failed to load library albums",
        ) from e


@app.get("/library/playlists")
async def library_playlists(
    user_id: str = Query(...),
    limit: int = Query(25, ge=1, le=100),
    mixes_only: bool = False,
) -> JsonObject:
    """Get user's library playlists from YouTube Music.

    When mixes_only=true, filters to auto-generated/personalized mixes
    (e.g. "My Supermix", "Discover Mix", "Fresh finds, old favorites"),
    excluding user-created playlists and special IDs like Liked Music.
    """
    try:
        playlists = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_library_playlists(limit={limit})",
            func=lambda yt: yt.get_library_playlists(limit),
        )
        items = []
        for p in playlists:
            pid = p.get("playlistId", "")
            if mixes_only:
                if pid in _SPECIAL_PLAYLIST_IDS:
                    continue
                if not any(pid.startswith(prefix) for prefix in _AUTO_PLAYLIST_PREFIXES):
                    continue
            items.append(
                {
                    "playlistId": pid,
                    "title": p.get("title", ""),
                    "description": p.get("description", ""),
                    "thumbnails": p.get("thumbnails", []),
                    "count": p.get("count"),
                }
            )
        return {"playlists": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get library playlists for user {user_id}",
            e,
            500,
            "Failed to load library playlists",
        ) from e
