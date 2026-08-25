"""
YouTube Music Streamer — FastAPI sidecar for soundspan.

Uses `ytmusicapi` for search/browse/library and `yt-dlp` for audio stream
URL extraction. Streams audio by proxying from YouTube's CDN — no files
are saved to disk.

Supports **per-user** OAuth credentials: each soundspan user connects their
own YouTube Music account. Credentials are stored as individual files
(`oauth_{user_id}.json`) and each user gets a separate YTMusic instance.

The Node.js backend communicates with this service over HTTP on port 8586,
passing `user_id` as a query parameter for per-user credential scoping on
user-private operations and per-user cache segmentation for public search.
"""

# This remains the Uvicorn and test entrypoint. It assembles the route modules
# and forwards legacy module-level overrides to each owning module.

import sys
import types
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if (REPOSITORY_ROOT / "services").is_dir() and str(REPOSITORY_ROOT) not in sys.path:
    sys.path.append(str(REPOSITORY_ROOT))

import ytmusic_album_downloads as _album_downloads
import ytmusic_auth as _auth
import ytmusic_browse as _browse
import ytmusic_client as _client
import ytmusic_downloads as _downloads
import ytmusic_library as _library
import ytmusic_lifecycle as _lifecycle
import ytmusic_models as _models
import ytmusic_runtime as _runtime
import ytmusic_search as _search
import ytmusic_stream as _stream

app = _runtime.app

_MODULES = (
    _runtime,
    _models,
    _client,
    _search,
    _auth,
    _stream,
    _library,
    _downloads,
    _album_downloads,
    _browse,
    _lifecycle,
)
_ENTRYPOINT_NAMES = frozenset(
    name for module in _MODULES for name in vars(module) if not name.startswith("__")
)
_ATTRIBUTE_OWNERS = {
    name: tuple(module for module in _MODULES if name in vars(module)) for name in _ENTRYPOINT_NAMES
}


def __getattr__(name: str) -> Any:
    """Resolve legacy entrypoint attributes from their owning split modules."""
    owners = _ATTRIBUTE_OWNERS.get(name, ())
    for owner in owners:
        try:
            return getattr(owner, name)
        except AttributeError:
            continue
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class _EntrypointModule(types.ModuleType):
    """Forward test and runtime overrides to every module using a symbol."""

    def __setattr__(self, name: str, value: object) -> None:
        owners = _ATTRIBUTE_OWNERS.get(name)
        if owners:
            for owner in owners:
                setattr(owner, name, value)
            return
        super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        owners = _ATTRIBUTE_OWNERS.get(name)
        if owners:
            for owner in owners:
                if name in vars(owner):
                    delattr(owner, name)
            return
        super().__delattr__(name)


sys.modules[__name__].__class__ = _EntrypointModule


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8586)  # noqa: S104 -- container service must accept pod traffic
