"""Behavioral coverage for bounded AcoustID lookups."""

from __future__ import annotations

import json
import urllib.error

import acoustid_lookup
import pytest


def _response(score: float = 0.91) -> str:
    return json.dumps(
        {
            "status": "ok",
            "results": [
                {
                    "score": score,
                    "recordings": [
                        {
                            "id": "recording-mbid",
                            "releasegroups": [{"id": "release-group-mbid"}],
                        }
                    ],
                }
            ],
        }
    )


def test_parse_lookup_response_accepts_candidate_at_threshold() -> None:
    """Persist identity only when the best score meets the named threshold."""
    assert acoustid_lookup.parse_lookup_response(_response(0.70)) == {
        "recordingMbid": "recording-mbid",
        "releaseGroupMbid": "release-group-mbid",
        "score": 0.70,
    }


def test_parse_lookup_response_rejects_candidate_below_threshold() -> None:
    """Treat low-confidence candidates as a completed lookup without identity."""
    assert acoustid_lookup.parse_lookup_response(_response(0.699)) is None


def test_parse_lookup_response_selects_highest_scored_recording() -> None:
    """Select the candidate attached to the highest valid result score."""
    payload = json.loads(_response(0.72))
    payload["results"].append(
        {
            "score": 0.95,
            "recordings": [{"id": "best-recording", "releasegroups": []}],
        }
    )

    assert acoustid_lookup.parse_lookup_response(json.dumps(payload)) == {
        "recordingMbid": "best-recording",
        "releaseGroupMbid": None,
        "score": 0.95,
    }


def test_rate_limiter_caps_each_rolling_second() -> None:
    """Delay the fourth request until the oldest of three requests expires."""
    now = [0.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    limiter = acoustid_lookup.RateLimiter(clock=lambda: now[0], sleep=sleep)

    limiter.acquire()
    now[0] = 0.1
    limiter.acquire()
    now[0] = 0.2
    limiter.acquire()
    now[0] = 0.3
    limiter.acquire()

    assert sleeps == [pytest.approx(0.7)]


def test_client_posts_secret_in_body_not_url() -> None:
    """Keep the API key out of the request URL while sending required fields."""
    requests: list[tuple[str, bytes, float]] = []

    def transport(url: str, body: bytes, timeout: float) -> bytes:
        requests.append((url, body, timeout))
        return _response().encode()

    client = acoustid_lookup.AcoustIDClient(
        "top-secret",
        transport=transport,
        limiter=acoustid_lookup.RateLimiter(clock=lambda: 0.0, sleep=lambda _s: None),
        clock=lambda: 0.0,
    )

    assert client.lookup("fingerprint-value", 247) is not None
    url, body, timeout = requests[0]
    assert "top-secret" not in url
    assert b"client=top-secret" in body
    assert timeout == acoustid_lookup.DEFAULT_HTTP_TIMEOUT_SECONDS


def test_client_caps_transient_retries_with_backoff() -> None:
    """Stop after three transient attempts and keep failure text secret-free."""
    calls = 0
    sleeps: list[float] = []

    def transport(_url: str, _body: bytes, _timeout: float) -> bytes:
        nonlocal calls
        calls += 1
        raise urllib.error.URLError("offline")

    client = acoustid_lookup.AcoustIDClient(
        "top-secret",
        transport=transport,
        limiter=acoustid_lookup.RateLimiter(clock=lambda: 0.0, sleep=lambda _s: None),
        sleep=sleeps.append,
        random_value=lambda: 0.5,
    )

    with pytest.raises(acoustid_lookup.AcoustIDLookupError) as caught:
        client.lookup("fingerprint-value", 247)

    assert calls == acoustid_lookup.MAX_HTTP_ATTEMPTS
    assert sleeps == [0.25, 0.5]
    assert "top-secret" not in str(caught.value)


def test_client_rejects_oversized_fingerprint_before_transport() -> None:
    """Reject an oversized persisted fingerprint before building an HTTP request."""
    calls = 0

    def transport(_url: str, _body: bytes, _timeout: float) -> bytes:
        nonlocal calls
        calls += 1
        return _response().encode()

    client = acoustid_lookup.AcoustIDClient("configured", transport=transport)

    with pytest.raises(acoustid_lookup.AcoustIDLookupError):
        client.lookup("a" * (acoustid_lookup.MAX_FINGERPRINT_BYTES + 1), 247)

    assert calls == 0


def test_client_retries_share_one_total_deadline() -> None:
    """Stop retrying when the first attempt consumes the lookup's total budget."""
    now = [0.0]
    calls = 0

    def transport(_url: str, _body: bytes, _timeout: float) -> bytes:
        nonlocal calls
        calls += 1
        now[0] = acoustid_lookup.DEFAULT_HTTP_TIMEOUT_SECONDS + 0.1
        raise TimeoutError

    client = acoustid_lookup.AcoustIDClient(
        "configured",
        transport=transport,
        limiter=acoustid_lookup.RateLimiter(clock=lambda: now[0], sleep=lambda _s: None),
        sleep=lambda _seconds: None,
        clock=lambda: now[0],
    )

    with pytest.raises(acoustid_lookup.AcoustIDLookupError):
        client.lookup("fingerprint", 247)

    assert calls == 1


def test_urlopen_transport_enforces_total_read_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop a trickling response when the exchange consumes its total budget."""
    now = iter([0.0, 0.4, 1.1])

    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self, _size: int) -> bytes:
            return b"x"

    monkeypatch.setattr(acoustid_lookup.time, "monotonic", lambda: next(now))
    monkeypatch.setattr(
        acoustid_lookup.urllib.request, "urlopen", lambda *_args, **_kwargs: Response()
    )

    with pytest.raises(TimeoutError):
        acoustid_lookup._urlopen_transport("https://example.test", b"body", 1.0)
