"""Wire serializers for tidalapi browse objects."""

from typing import Any

from tidal_runtime import JsonObject, log


def _tidal_image_url(image_id: Any, w: int = 480, h: int = 480) -> str | None:
    """Convert a TIDAL image UUID to a resources.tidal.com URL."""
    if not image_id:
        return None
    uuid_path = str(image_id).replace("-", "/")
    return f"https://resources.tidal.com/images/{uuid_path}/{w}x{h}.jpg"


def _serialize_page_item(item: Any) -> JsonObject:
    """Serialize a single item from a tidalapi PageCategory."""
    result = {"title": getattr(item, "name", None) or getattr(item, "title", None) or ""}
    type_name = type(item).__name__.lower()
    if hasattr(item, "id"):
        if "playlist" in type_name:
            result["type"] = "playlist"
            result["playlistId"] = str(item.id)
        elif "mix" in type_name:
            result["type"] = "mix"
            result["mixId"] = str(item.id)
        elif "album" in type_name:
            result["type"] = "album"
            result["albumId"] = str(item.id)
        else:
            result["type"] = type_name

    thumb = None
    if callable(getattr(item, "image", None)):
        try:
            thumb = item.image(320)
        except Exception as error:
            log.debug("Failed to extract page item thumbnail: %s", error)
    if not thumb and hasattr(item, "image") and isinstance(item.image, str):
        thumb = _tidal_image_url(item.image, 320, 320)
    result["thumbnailUrl"] = thumb
    result["subtitle"] = (
        getattr(item, "sub_title", None) or getattr(item, "description", None) or ""
    )
    return result


def _serialize_page(page: Any) -> list[JsonObject]:
    """Serialize a tidalapi Page to shelf format."""
    shelves = []
    for category in page.categories or []:
        items_list = getattr(category, "items", None) or []
        serialized_items = [
            serialized
            for serialized in (_serialize_page_item(item) for item in items_list)
            if serialized.get("playlistId") or serialized.get("mixId") or serialized.get("albumId")
        ]
        if not serialized_items:
            continue
        shelves.append(
            {
                "title": getattr(category, "title", "") or "",
                "contents": serialized_items,
            }
        )
    return shelves


def _extract_page_links(page: Any) -> list[JsonObject]:
    """Extract individual PageLink items from a genre or mood Page."""
    results = []
    for category in page.categories or []:
        items = getattr(category, "items", None) or []
        for item in items:
            results.append(_serialize_genre(item))
    return results


def _serialize_genre(genre: Any) -> JsonObject:
    """Serialize a tidalapi genre or mood PageLink to a dictionary."""
    image = None
    image_id = getattr(genre, "image_id", None)
    if image_id and isinstance(image_id, str):
        image = _tidal_image_url(image_id, 320, 320)
    if not image and hasattr(genre, "image") and genre.image:
        if callable(genre.image):
            try:
                image = genre.image(320)
            except Exception as error:
                log.debug("Failed to extract genre image: %s", error)
        elif isinstance(genre.image, str):
            image = _tidal_image_url(genre.image, 320, 320)

    path = getattr(genre, "api_path", "") or getattr(genre, "path", "") or ""
    if path.startswith("pages/"):
        path = path[len("pages/") :]
    return {
        "name": getattr(genre, "name", "") or getattr(genre, "title", "") or "",
        "path": path,
        "hasPlaylists": bool(getattr(genre, "has_playlists", True)),
        "imageUrl": image,
    }


def _serialize_mix(mix: Any) -> JsonObject:
    """Serialize a tidalapi Mix to a dictionary."""
    image = None
    if callable(getattr(mix, "image", None)):
        try:
            image = mix.image(320)
        except Exception as error:
            log.debug("Failed to extract mix thumbnail: %s", error)
    return {
        "mixId": str(getattr(mix, "id", "")),
        "title": getattr(mix, "title", "") or "",
        "subTitle": getattr(mix, "sub_title", "") or "",
        "thumbnailUrl": image,
    }


def _serialize_track(track: Any) -> JsonObject:
    """Serialize a tidalapi Track to a dictionary."""
    artist = track.artist if hasattr(track, "artist") else None
    artist_name = getattr(artist, "name", "Unknown") if artist else "Unknown"
    artists = (
        [getattr(item, "name", "") for item in (track.artists or [])]
        if hasattr(track, "artists") and track.artists
        else [artist_name]
    )
    album = track.album if hasattr(track, "album") else None
    album_name = getattr(album, "name", "") if album else ""
    thumbnail = None
    if album and callable(getattr(album, "image", None)):
        try:
            thumbnail = album.image(320)
        except Exception as error:
            log.debug("Failed to extract track album art: %s", error)
    return {
        "trackId": track.id,
        "title": getattr(track, "name", "") or "",
        "artist": artist_name,
        "artists": artists,
        "album": album_name,
        "duration": getattr(track, "duration", 0) or 0,
        "isrc": getattr(track, "isrc", None),
        "thumbnailUrl": thumbnail,
    }


def _serialize_playlist_preview(playlist: Any) -> JsonObject:
    """Serialize a tidalapi Playlist to a preview dictionary."""
    image = None
    if callable(getattr(playlist, "image", None)):
        try:
            image = playlist.image(320)
        except Exception as error:
            log.debug("Failed to extract playlist preview image: %s", error)
    return {
        "playlistId": str(getattr(playlist, "id", "")),
        "title": getattr(playlist, "name", "") or "",
        "numTracks": getattr(playlist, "num_tracks", 0) or 0,
        "thumbnailUrl": image,
    }


def _serialize_playlist_detail(playlist: Any) -> JsonObject:
    """Serialize a tidalapi Playlist to a detail dictionary with tracks."""
    image = None
    if callable(getattr(playlist, "image", None)):
        try:
            image = playlist.image(320)
        except Exception as error:
            log.debug("Failed to extract playlist detail image: %s", error)
    tracks_list = playlist.tracks() if callable(getattr(playlist, "tracks", None)) else []
    return {
        "id": str(getattr(playlist, "id", "")),
        "title": getattr(playlist, "name", "") or "",
        "trackCount": getattr(playlist, "num_tracks", 0) or 0,
        "thumbnailUrl": image,
        "tracks": [_serialize_track(track) for track in tracks_list],
    }
