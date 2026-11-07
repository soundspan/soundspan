"""Policy for opt-in yt-dlp JavaScript-client fallback attempts."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from typing import TypeVar

from ytmusic_runtime import log

T = TypeVar("T")

_FLAG_NAME = "YTMUSIC_JS_CLIENT_FALLBACK"
_TRUTHY_FLAG_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSY_FLAG_VALUES = frozenset({"", "0", "false", "no", "off"})
_MAX_EXCEPTION_CHAIN_LINKS = 10


class SpoolLimitExceeded(RuntimeError):
    """Raised when a YouTube Music spool download exceeds a configured limit."""


def parse_bool_flag(raw: str | None) -> bool:
    """Parse the supported environment-flag spellings, defaulting safely off."""
    normalized = (raw or "").strip().lower()
    if normalized in _TRUTHY_FLAG_VALUES:
        return True
    if normalized in _FALSY_FLAG_VALUES:
        return False
    log.warning("Invalid %s=%r; defaulting to false", _FLAG_NAME, raw)
    return False


JS_CLIENT_FALLBACK_ENABLED = parse_bool_flag(os.getenv(_FLAG_NAME))
JS_FALLBACK_SLOT_WAIT_SECONDS = 15.0
_JS_FALLBACK_SLOT = threading.BoundedSemaphore(1)


def is_age_restricted_message(text: str) -> bool:
    """Return whether an extraction message matches the age-verification failure."""
    lowered = text.lower()
    return "Sign in to confirm your age" in text or ("age" in lowered and "confirm" in lowered)


def _exception_links(error: BaseException) -> tuple[BaseException, ...]:
    """Return direct Python and yt-dlp exception links."""
    links = [link for link in (error.__cause__, error.__context__) if link is not None]
    exc_info = getattr(error, "exc_info", None)
    if isinstance(exc_info, tuple) and len(exc_info) > 1 and isinstance(exc_info[1], BaseException):
        links.append(exc_info[1])
    return tuple(links)


def is_fallback_eligible(error: BaseException) -> bool:
    """Reject fallback for policy failures anywhere in a bounded exception chain."""
    pending = [error]
    visited: set[int] = set()
    for _ in range(_MAX_EXCEPTION_CHAIN_LINKS):
        if not pending:
            break
        current = pending.pop()
        identity = id(current)
        if identity in visited:
            continue
        visited.add(identity)
        if isinstance(current, SpoolLimitExceeded) or is_age_restricted_message(str(current)):
            return False
        pending.extend(_exception_links(current))
    return True


def run_with_js_fallback(
    primary: Callable[[], T],
    fallback: Callable[[], T],
    *,
    label: str,
) -> T:
    """Run one eligible fallback attempt under the process-wide solver slot."""
    try:
        return primary()
    except Exception as error:
        if not JS_CLIENT_FALLBACK_ENABLED or not is_fallback_eligible(error):
            raise
        if not _JS_FALLBACK_SLOT.acquire(timeout=JS_FALLBACK_SLOT_WAIT_SECONDS):
            log.warning("JavaScript-client fallback slot is busy for %s", label)
            raise
        try:
            log.warning(
                "Primary clients failed for %s; retrying with yt-dlp's JavaScript-player clients",
                label,
            )
            result = fallback()
            log.info("JavaScript-client fallback succeeded for %s", label)
            return result
        finally:
            _JS_FALLBACK_SLOT.release()
