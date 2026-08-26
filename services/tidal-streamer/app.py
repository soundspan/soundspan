"""TIDAL Streamer entrypoint and compatibility facade.

The Node.js backend communicates with this FastAPI sidecar on port 8585.
Route behavior lives in focused modules; this shim assembles them and forwards
legacy module-level overrides used by the existing behavioral tests.
"""

import sys
import types
from pathlib import Path
from typing import Any

_MODULE_PATH = Path(__file__).resolve()
if len(_MODULE_PATH.parents) >= 3:
    REPOSITORY_ROOT = _MODULE_PATH.parents[2]
    if (REPOSITORY_ROOT / "services").is_dir() and str(REPOSITORY_ROOT) not in sys.path:
        sys.path.append(str(REPOSITORY_ROOT))

from services.common.sidecar_runtime_utils import ensure_repository_root_on_path

ensure_repository_root_on_path(__file__)

import tidal_auth as _auth
import tidal_browse as _browse
import tidal_cache as _cache
import tidal_download_routes as _download_routes
import tidal_downloads as _downloads
import tidal_lifecycle as _lifecycle
import tidal_models as _models
import tidal_runtime as _runtime
import tidal_search as _search
import tidal_serializers as _serializers
import tidal_stream as _stream

app = _runtime.app
app.router.lifespan_context = _cache._app_lifespan

_MODULES = (
    _runtime,
    _models,
    _cache,
    _serializers,
    _auth,
    _search,
    _downloads,
    _download_routes,
    _stream,
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

    uvicorn.run(app, host="0.0.0.0", port=8585)  # noqa: S104 -- container service accepts pod traffic
