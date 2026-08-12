"""Thread-safety regression tests for TIDAL browse-session caches."""

from __future__ import annotations

import threading
import types
from typing import Any

import pytest


def _assert_lock_held(lock: threading.Lock) -> None:
    acquired = lock.acquire(blocking=False)
    if acquired:
        lock.release()
    assert not acquired, "browse-session dictionary operation ran without mutual exclusion"


def _assert_lock_available(lock: threading.Lock, operation: str) -> None:
    acquired = lock.acquire(blocking=False)
    assert acquired, f"lock held across blocking {operation}"
    lock.release()


class _IterationLockCheckingDict(dict[Any, Any]):
    def __init__(self, values: Any, lock: threading.Lock) -> None:
        super().__init__(values)
        self._lock = lock

    def __iter__(self) -> Any:
        _assert_lock_held(self._lock)
        return super().__iter__()

    def items(self) -> Any:
        _assert_lock_held(self._lock)
        return super().items()

    def pop(self, key: Any, default: Any = None) -> Any:
        _assert_lock_held(self._lock)
        return super().pop(key, default)


class _AccessLockCheckingDict(dict[Any, Any]):
    def __init__(self, values: Any, lock: threading.Lock) -> None:
        super().__init__(values)
        self._lock = lock

    def get(self, key: Any, default: Any = None) -> Any:
        _assert_lock_held(self._lock)
        return super().get(key, default)

    def __setitem__(self, key: Any, value: Any) -> None:
        _assert_lock_held(self._lock)
        super().__setitem__(key, value)

    def __iter__(self) -> Any:
        _assert_lock_held(self._lock)
        return super().__iter__()

    def __len__(self) -> int:
        _assert_lock_held(self._lock)
        return super().__len__()

    def pop(self, key: Any, default: Any = None) -> Any:
        _assert_lock_held(self._lock)
        return super().pop(key, default)


def test_invalidate_user_api_locks_auth_and_browse_state(monkeypatch: pytest.MonkeyPatch) -> None:
    import app

    browse_lock = threading.Lock()
    auth_lock = threading.Lock()
    browse_sessions = _IterationLockCheckingDict(
        {
            "target:HIGH": object(),
            "target:LOSSLESS": object(),
            "other:HIGH": object(),
        },
        browse_lock,
    )
    auth_state = _AccessLockCheckingDict(
        {"target": {"access_token": "target"}, "other": {"access_token": "other"}},
        auth_lock,
    )

    monkeypatch.setattr(app, "_browse_sessions_lock", browse_lock, raising=False)
    monkeypatch.setattr(app, "_browse_sessions", browse_sessions)
    monkeypatch.setattr(app, "_user_auth_state_lock", auth_lock, raising=False)
    monkeypatch.setattr(app, "_user_auth_state", auth_state)
    monkeypatch.setattr(app, "_user_apis", {"target": object(), "other": object()})

    def assert_stream_clear_is_unlocked(user_id: str) -> None:
        assert user_id == "target"
        _assert_lock_available(browse_lock, "stream-cache clear")
        _assert_lock_available(auth_lock, "stream-cache clear")

    monkeypatch.setattr(app, "_clear_stream_cache", assert_stream_clear_is_unlocked)

    app._invalidate_user_api("target")

    assert dict.copy(browse_sessions) == {"other:HIGH": browse_sessions["other:HIGH"]}
    assert dict.copy(auth_state) == {"other": {"access_token": "other"}}
    assert set(app._user_apis) == {"other"}


def test_store_user_session_locks_auth_and_prunes_browse_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    browse_lock = threading.Lock()
    auth_lock = threading.Lock()
    browse_sessions = _IterationLockCheckingDict(
        {"target:HIGH": object(), "other:HIGH": object()}, browse_lock
    )
    auth_state = _AccessLockCheckingDict({}, auth_lock)
    api: Any = object()

    monkeypatch.setattr(app, "_browse_sessions_lock", browse_lock, raising=False)
    monkeypatch.setattr(app, "_browse_sessions", browse_sessions)
    monkeypatch.setattr(app, "_user_auth_state_lock", auth_lock, raising=False)
    monkeypatch.setattr(app, "_user_auth_state", auth_state)
    monkeypatch.setattr(app, "_user_apis", {})

    app._store_user_session("target", api, "access", "refresh", "tidal", "US")

    assert app._user_apis == {"target": api}
    assert dict.copy(auth_state) == {
        "target": {
            "access_token": "access",
            "refresh_token": "refresh",
            "tidal_user_id": "tidal",
            "country_code": "US",
        }
    }
    assert set(dict.copy(browse_sessions)) == {"other:HIGH"}


def test_build_browse_session_locks_dict_ops_and_constructs_unlocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    browse_lock = threading.Lock()
    auth_lock = threading.Lock()
    credentials = {"access_token": "old-access", "refresh_token": "old-refresh"}
    browse_sessions = _AccessLockCheckingDict({"oldest": object()}, browse_lock)
    auth_state = _AccessLockCheckingDict({"target": credentials}, auth_lock)
    loaded_tokens = {}
    session: Any = types.SimpleNamespace()

    def load_oauth_session(**kwargs: Any) -> None:
        _assert_lock_available(browse_lock, "OAuth session load")
        _assert_lock_available(auth_lock, "OAuth session load")
        loaded_tokens.update(kwargs)

    def build_session(_config: Any) -> Any:
        _assert_lock_available(browse_lock, "session construction")
        _assert_lock_available(auth_lock, "session construction")
        with auth_lock:
            credentials["access_token"] = "new-access"
            credentials["refresh_token"] = "new-refresh"
        session.load_oauth_session = load_oauth_session
        return session

    monkeypatch.setattr(app, "_browse_sessions_lock", browse_lock, raising=False)
    monkeypatch.setattr(app, "_browse_sessions", browse_sessions)
    monkeypatch.setattr(app, "_user_auth_state_lock", auth_lock, raising=False)
    monkeypatch.setattr(app, "_user_auth_state", auth_state)
    monkeypatch.setattr(app, "_BROWSE_SESSION_MAX", 1)
    monkeypatch.setattr(app, "Config", lambda **kwargs: kwargs)
    monkeypatch.setattr(app, "Session", build_session)

    result = app._build_browse_session("target")

    assert result is session
    assert loaded_tokens["access_token"] == "old-access"
    assert loaded_tokens["refresh_token"] == "old-refresh"
    assert set(dict.copy(browse_sessions)) == {f"target:{app.TIDALAPI_DEFAULT_QUALITY.value}"}


def test_build_public_browse_session_locks_dict_ops_and_constructs_unlocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    lock = threading.Lock()
    sessions = _AccessLockCheckingDict({"oldest": object()}, lock)
    session = object()

    def build_session(_config: Any) -> Any:
        _assert_lock_available(lock, "public session construction")
        return session

    monkeypatch.setattr(app, "_public_browse_sessions_lock", lock, raising=False)
    monkeypatch.setattr(app, "_public_browse_sessions", sessions)
    monkeypatch.setattr(app, "_PUBLIC_BROWSE_SESSION_MAX", 1)
    monkeypatch.setattr(app, "Config", lambda **kwargs: kwargs)
    monkeypatch.setattr(app, "Session", build_session)

    result = app._build_public_browse_session()

    assert result is session
    assert set(dict.copy(sessions)) == {app.TIDALAPI_DEFAULT_QUALITY.value}


def test_browse_session_eviction_preserves_size_cap_and_removes_oldest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app

    maximum = 3
    sessions = {f"old-{index}": object() for index in range(maximum)}
    monkeypatch.setattr(app, "_browse_sessions", sessions)
    monkeypatch.setattr(app, "_BROWSE_SESSION_MAX", maximum)
    monkeypatch.setattr(
        app,
        "_user_auth_state",
        {"target": {"access_token": "access", "refresh_token": "refresh"}},
    )
    monkeypatch.setattr(app, "Config", lambda **kwargs: kwargs)
    monkeypatch.setattr(
        app,
        "Session",
        lambda _config: types.SimpleNamespace(load_oauth_session=lambda **_kwargs: None),
    )

    app._build_browse_session("target")

    assert len(sessions) == maximum
    assert "old-0" not in sessions
    assert f"target:{app.TIDALAPI_DEFAULT_QUALITY.value}" in sessions
