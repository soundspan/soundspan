"""Bounded, rate-limited AcoustID lookup client and response parser."""

from __future__ import annotations

import json
import math
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Protocol, TypedDict

from fingerprinting import MAX_FINGERPRINT_BYTES

ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup"
DEFAULT_HTTP_TIMEOUT_SECONDS = 10.0
MAX_HTTP_ATTEMPTS = 3
MAX_REQUESTS_PER_SECOND = 3
MAX_RESPONSE_BYTES = 1024 * 1024
RESPONSE_READ_CHUNK_BYTES = 16 * 1024

#: Minimum AcoustID confidence accepted for persisted MusicBrainz identity.
ACOUSTID_MATCH_SCORE_THRESHOLD = 0.70


class AcoustIDCandidate(TypedDict):
    """Accepted MusicBrainz identity from one AcoustID result."""

    recordingMbid: str
    releaseGroupMbid: str | None
    score: float


class AcoustIDLookupError(RuntimeError):
    """Report one bounded lookup that exhausted transient retries."""


Transport = Callable[[str, bytes, float], bytes]


def _candidate_from_result(result: object) -> AcoustIDCandidate | None:
    """Validate the first recording attached to one scored result."""
    if not isinstance(result, dict):
        return None
    score = result.get("score")
    recordings = result.get("recordings")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return None
    if not math.isfinite(float(score)) or score < ACOUSTID_MATCH_SCORE_THRESHOLD:
        return None
    if not isinstance(recordings, list) or not recordings or not isinstance(recordings[0], dict):
        return None
    recording_id = recordings[0].get("id")
    if not isinstance(recording_id, str) or not recording_id:
        return None
    release_group_id: str | None = None
    release_groups = recordings[0].get("releasegroups")
    if isinstance(release_groups, list) and release_groups and isinstance(release_groups[0], dict):
        candidate_id = release_groups[0].get("id")
        if isinstance(candidate_id, str) and candidate_id:
            release_group_id = candidate_id
    return {
        "recordingMbid": recording_id,
        "releaseGroupMbid": release_group_id,
        "score": float(score),
    }


def parse_lookup_response(response: str) -> AcoustIDCandidate | None:
    """Return the highest-scored accepted recording from an AcoustID response."""
    try:
        payload: object = json.loads(response)
    except (json.JSONDecodeError, TypeError) as error:
        raise AcoustIDLookupError("AcoustID returned invalid JSON") from error
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        raise AcoustIDLookupError("AcoustID returned an unsuccessful response")
    results = payload.get("results")
    if not isinstance(results, list):
        raise AcoustIDLookupError("AcoustID response omitted results")
    candidates = [candidate for result in results if (candidate := _candidate_from_result(result))]
    return max(candidates, key=lambda candidate: candidate["score"], default=None)


class RateLimiter:
    """Enforce at most three request starts in any rolling second."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._clock = clock
        self._sleep = sleep
        self._request_times: list[float] = []

    def acquire(self) -> None:
        """Wait until one request fits inside the fixed three-request window."""
        now = self._clock()
        recent = [timestamp for timestamp in self._request_times if now - timestamp < 1.0]
        if len(recent) >= MAX_REQUESTS_PER_SECOND:
            self._sleep(max(0.0, 1.0 - (now - recent[0])))
            now = self._clock()
            recent = [timestamp for timestamp in recent if now - timestamp < 1.0]
        self._request_times = [*recent, now][-MAX_REQUESTS_PER_SECOND:]


def _urlopen_transport(url: str, body: bytes, timeout: float) -> bytes:
    """POST one form body and close the response deterministically."""
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(  # noqa: S310 -- fixed HTTPS URL
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(  # noqa: S310 -- request is fixed to the HTTPS API URL
        request,
        timeout=timeout,
    ) as response:
        return _read_response(response, deadline)


def _set_response_socket_timeout(response: object, timeout: float) -> None:
    """Apply the remaining total budget to urllib's active response socket."""
    file_pointer = getattr(response, "fp", None)
    raw_stream = getattr(file_pointer, "raw", None)
    response_socket = getattr(raw_stream, "_sock", None)
    if response_socket is not None:
        response_socket.settimeout(timeout)


class _ReadableResponse(Protocol):
    """The subset of an HTTP response the bounded reader relies on."""

    def read(self, size: int = ..., /) -> bytes: ...


def _read_response(response: _ReadableResponse, deadline: float) -> bytes:
    """Read one response under total-deadline and byte-size bounds."""
    payload = bytearray()
    for _ in range((MAX_RESPONSE_BYTES // RESPONSE_READ_CHUNK_BYTES) + 2):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("AcoustID total deadline exceeded")
        _set_response_socket_timeout(response, remaining)
        chunk = response.read(min(RESPONSE_READ_CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - len(payload)))
        if time.monotonic() >= deadline:
            raise TimeoutError("AcoustID total deadline exceeded")
        if not isinstance(chunk, bytes):
            raise AcoustIDLookupError("AcoustID transport returned a non-bytes response")
        if not chunk:
            return bytes(payload)
        payload.extend(chunk)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise AcoustIDLookupError("AcoustID response exceeded the size limit")
    raise AcoustIDLookupError("AcoustID response exceeded the size limit")


def _is_retryable(error: Exception) -> bool:
    """Classify bounded transport retries without retrying stable client errors."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or error.code in {502, 503, 504}
    return isinstance(error, (TimeoutError, urllib.error.URLError))


class AcoustIDClient:
    """Look up one persisted fingerprint with bounded retries and redaction."""

    def __init__(
        self,
        api_key: str,
        *,
        transport: Transport = _urlopen_transport,
        limiter: RateLimiter | None = None,
        sleep: Callable[[float], None] = time.sleep,
        random_value: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must be configured")
        self._api_key = api_key
        self._transport = transport
        self._limiter = limiter or RateLimiter()
        self._sleep = sleep
        self._random_value = random_value
        self._clock = clock

    def lookup(self, fingerprint: str, duration: int) -> AcoustIDCandidate | None:
        """POST one lookup, retry transient failures, and parse its best result."""
        if not fingerprint or len(fingerprint.encode("utf-8")) > MAX_FINGERPRINT_BYTES:
            raise AcoustIDLookupError("invalid fingerprint")
        if duration < 1:
            raise AcoustIDLookupError("invalid duration")
        body = urllib.parse.urlencode(
            {
                "client": self._api_key,
                "duration": duration,
                "fingerprint": fingerprint,
                "format": "json",
                "meta": "recordings+releasegroups",
            }
        ).encode()
        deadline = self._clock() + DEFAULT_HTTP_TIMEOUT_SECONDS
        for attempt in range(MAX_HTTP_ATTEMPTS):
            self._limiter.acquire()
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise AcoustIDLookupError("TimeoutError")
            try:
                response = self._transport(ACOUSTID_LOOKUP_URL, body, remaining)
                return parse_lookup_response(response.decode("utf-8"))
            except Exception as error:
                if not _is_retryable(error) or attempt + 1 >= MAX_HTTP_ATTEMPTS:
                    raise AcoustIDLookupError(type(error).__name__) from error
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise AcoustIDLookupError("TimeoutError") from error
                delay = self._random_value() * min(4.0, 0.5 * (2**attempt))
                self._sleep(min(delay, remaining))
        raise AssertionError("bounded lookup loop exhausted without returning")
