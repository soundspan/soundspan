"""Album track pagination regression tests."""

from __future__ import annotations

from types import SimpleNamespace


def _album_items(count: int, start: int = 0) -> list[SimpleNamespace]:
    """Build album items containing downloadable tracks."""
    return [
        SimpleNamespace(
            item=SimpleNamespace(isrc=f"US{number:010d}", id=number, title="t")
        )
        for number in range(start, start + count)
    ]


def test_paginates_all_pages():
    """Pagination returns every track and requests each page once."""
    import app

    calls = []

    def get_album_items(album_id, limit, offset):
        calls.append((album_id, limit, offset))
        page_lengths = {0: 100, 100: 100, 200: 50}
        return SimpleNamespace(
            items=_album_items(page_lengths[offset], offset),
            limit=100,
            totalNumberOfItems=250,
        )

    fake_api = SimpleNamespace(get_album_items=get_album_items)

    tracks = app._get_album_tracks(fake_api, 123)

    assert len(tracks) == 250
    assert calls == [(123, 100, 0), (123, 100, 100), (123, 100, 200)]


def test_zero_limit_does_not_infinite_loop():
    """An echoed zero limit cannot prevent pagination from terminating."""
    import app

    calls = []

    def get_album_items(album_id, limit, offset):
        calls.append((album_id, limit, offset))
        if len(calls) == 1:
            page = _album_items(100)
        elif len(calls) == 2:
            page = []
        else:
            raise AssertionError("album pagination did not terminate")
        return SimpleNamespace(
            items=page,
            limit=0,
            totalNumberOfItems=10**9,
        )

    fake_api = SimpleNamespace(get_album_items=get_album_items)

    tracks = app._get_album_tracks(fake_api, 123)

    assert len(tracks) == 100
    assert len(calls) <= 2


def test_stops_on_empty_first_page():
    """An empty first page terminates pagination immediately."""
    import app

    calls = []

    def get_album_items(album_id, limit, offset):
        calls.append((album_id, limit, offset))
        return SimpleNamespace(items=[], limit=100, totalNumberOfItems=0)

    fake_api = SimpleNamespace(get_album_items=get_album_items)

    tracks = app._get_album_tracks(fake_api, 123)

    assert tracks == []
    assert len(calls) == 1
