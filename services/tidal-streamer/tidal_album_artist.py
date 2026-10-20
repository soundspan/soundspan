"""Pure artist-name resolution for TIDAL album objects."""

from typing import Any


def _album_artists(album: Any) -> list[Any]:
    """Return the album artist list or an empty list for malformed shapes."""
    artists = getattr(album, "artists", None)
    return artists if isinstance(artists, list) else []


def _artist_name(artist: Any) -> str:
    """Return a non-empty artist name or an empty string."""
    name = getattr(artist, "name", None)
    return name if isinstance(name, str) and name else ""


def _album_primary_artist_name(album: Any) -> str:
    """Resolve the singular, first main, or first named album artist."""
    artist_name = _artist_name(getattr(album, "artist", None))
    if artist_name:
        return artist_name

    artists = _album_artists(album)
    for artist in artists:
        artist_name = _artist_name(artist)
        if getattr(artist, "type", None) == "MAIN" and artist_name:
            return artist_name
    for artist in artists:
        artist_name = _artist_name(artist)
        if artist_name:
            return artist_name
    return ""


def _album_artist_credit(album: Any) -> str:
    """Join unique main album artists in provider order for display and matching."""
    names: list[str] = []
    for artist in _album_artists(album):
        name = _artist_name(artist)
        if getattr(artist, "type", None) == "MAIN" and name and name not in names:
            names.append(name)
    return " & ".join(names) or _album_primary_artist_name(album)
