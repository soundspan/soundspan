"""Behavioral coverage for TIDAL album artist resolution and search credits."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def _search_results(album: Any) -> SimpleNamespace:
    """Build the minimal TIDAL search result shape used by serializers."""
    empty_items = type("Items", (), {"items": []})()
    album_items = type("Items", (), {"items": [album]})()
    return SimpleNamespace(tracks=empty_items, albums=album_items, artists=empty_items)


def _search_album(artists: list[Any]) -> SimpleNamespace:
    """Build a search-shaped album with the fields read by serializers."""
    return SimpleNamespace(
        id=3008329,
        title="Mountain Music",
        artist=None,
        artists=artists,
        numberOfTracks=10,
        releaseDate=None,
        type="ALBUM",
        audioQuality="LOSSLESS",
        cover="cover-id",
    )


def test_search_album_main_artist_supplies_credit_and_primary_name() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=None,
        artists=[SimpleNamespace(name="Alabama", type="MAIN")],
    )

    assert tidal_album_artist._album_artist_credit(album) == "Alabama"
    assert tidal_album_artist._album_primary_artist_name(album) == "Alabama"


def test_collaboration_credit_joins_main_artists_and_primary_uses_first() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=None,
        artists=[
            SimpleNamespace(name="A", type="MAIN"),
            SimpleNamespace(name="B", type="MAIN"),
            SimpleNamespace(name="Guest", type="FEATURED"),
        ],
    )

    assert tidal_album_artist._album_artist_credit(album) == "A & B"
    assert tidal_album_artist._album_primary_artist_name(album) == "A"


def test_populated_singular_artist_supplies_primary_name() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=SimpleNamespace(name="Primary"),
        artists=[SimpleNamespace(name="Listed", type="MAIN")],
    )

    assert tidal_album_artist._album_primary_artist_name(album) == "Primary"


def test_duplicate_main_artists_appear_once_in_credit() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=None,
        artists=[
            SimpleNamespace(name="A", type="MAIN"),
            SimpleNamespace(name="A", type="MAIN"),
            SimpleNamespace(name="B", type="MAIN"),
        ],
    )

    assert tidal_album_artist._album_artist_credit(album) == "A & B"


def test_entries_without_type_fall_back_to_first_named_artist() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=None,
        artists=[SimpleNamespace(name="Fallback"), SimpleNamespace(name="Later")],
    )

    assert tidal_album_artist._album_artist_credit(album) == "Fallback"
    assert tidal_album_artist._album_primary_artist_name(album) == "Fallback"


def test_empty_artist_list_returns_empty_names() -> None:
    import tidal_album_artist

    album = SimpleNamespace(artist=None, artists=[])

    assert tidal_album_artist._album_artist_credit(album) == ""
    assert tidal_album_artist._album_primary_artist_name(album) == ""


def test_none_artist_list_returns_empty_names() -> None:
    import tidal_album_artist

    album = SimpleNamespace(artist=None, artists=None)

    assert tidal_album_artist._album_artist_credit(album) == ""
    assert tidal_album_artist._album_primary_artist_name(album) == ""


def test_non_string_and_empty_names_are_skipped() -> None:
    import tidal_album_artist

    album = SimpleNamespace(
        artist=SimpleNamespace(name=123),
        artists=[
            SimpleNamespace(name="", type="MAIN"),
            SimpleNamespace(name=None, type="MAIN"),
            SimpleNamespace(name=456, type="MAIN"),
            SimpleNamespace(name="Valid", type="MAIN"),
        ],
    )

    assert tidal_album_artist._album_artist_credit(album) == "Valid"
    assert tidal_album_artist._album_primary_artist_name(album) == "Valid"


def test_search_serializers_use_album_artist_credit() -> None:
    import tidal_search

    album = _search_album([SimpleNamespace(name="Alabama", type="MAIN")])
    results = _search_results(album)

    admin_response = tidal_search._serialize_admin_search(results)
    user_response = tidal_search._serialize_user_search(results)

    assert admin_response["albums"][0]["artist"] == "Alabama"
    assert user_response["albums"][0]["artist"] == "Alabama"


def test_search_serializers_preserve_unknown_artist_fallback() -> None:
    import tidal_search

    results = _search_results(_search_album([]))

    admin_response = tidal_search._serialize_admin_search(results)
    user_response = tidal_search._serialize_user_search(results)

    assert admin_response["albums"][0]["artist"] == "Unknown"
    assert user_response["albums"][0]["artist"] == "Unknown"
