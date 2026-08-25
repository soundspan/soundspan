"""Shared fixtures for tidal-streamer tests."""

from __future__ import annotations

import sys
import types
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any, Literal

import pytest
from httpx import ASGITransport, AsyncClient

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]


def _install_tiddl_stub() -> None:
    """Provide a lightweight `tiddl` stub so import-only tests can run."""
    if "tiddl" in sys.modules:
        return

    class _PlaceholderClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.args = args
            self.kwargs = kwargs

    class _PlaceholderApiError(Exception):
        """Fallback error used when tiddl is unavailable in tests."""

    class _PlaceholderAuthClientError(Exception):
        """Fallback auth error used when tiddl is unavailable in tests."""

    def _missing_tiddl(*_args: Any, **_kwargs: Any) -> Any:
        raise ModuleNotFoundError("tiddl is not installed in the test environment")

    def export(module: types.ModuleType, name: str, value: object) -> None:
        module.__dict__[name] = value

    tiddl_module = types.ModuleType("tiddl")
    core_module = types.ModuleType("tiddl.core")
    auth_module = types.ModuleType("tiddl.core.auth")
    auth_client_module = types.ModuleType("tiddl.core.auth.client")
    api_module = types.ModuleType("tiddl.core.api")
    utils_module = types.ModuleType("tiddl.core.utils")
    format_module = types.ModuleType("tiddl.core.utils.format")
    metadata_module = types.ModuleType("tiddl.core.metadata")

    export(auth_module, "AuthAPI", _PlaceholderClient)
    export(auth_module, "AuthClientError", _PlaceholderAuthClientError)
    export(auth_client_module, "AuthClient", _PlaceholderClient)
    export(api_module, "TidalAPI", _PlaceholderClient)
    export(api_module, "TidalClient", _PlaceholderClient)
    export(api_module, "ApiError", _PlaceholderApiError)
    export(utils_module, "get_track_stream_data", _missing_tiddl)
    export(utils_module, "parse_track_stream", _missing_tiddl)
    export(format_module, "format_template", _missing_tiddl)
    export(metadata_module, "add_track_metadata", _missing_tiddl)
    export(metadata_module, "Cover", _PlaceholderClient)

    export(tiddl_module, "core", core_module)
    export(core_module, "auth", auth_module)
    export(core_module, "api", api_module)
    export(core_module, "utils", utils_module)
    export(core_module, "metadata", metadata_module)
    export(utils_module, "format", format_module)

    sys.modules["tiddl"] = tiddl_module
    sys.modules["tiddl.core"] = core_module
    sys.modules["tiddl.core.auth"] = auth_module
    sys.modules["tiddl.core.auth.client"] = auth_client_module
    sys.modules["tiddl.core.api"] = api_module
    sys.modules["tiddl.core.utils"] = utils_module
    sys.modules["tiddl.core.utils.format"] = format_module
    sys.modules["tiddl.core.metadata"] = metadata_module


_install_tiddl_stub()


# Shared secret the `client` fixture presents on every request so the F31
# inbound-auth dependency lets the existing behaviour suites through. Tests
# that exercise the auth gate itself (test_internal_auth.py) build their own
# clients and manage this env var directly.
INTERNAL_API_SECRET = "test-internal-secret-value"
APP_MODULES = (
    "app",
    "tidal_auth",
    "tidal_browse",
    "tidal_cache",
    "tidal_download_routes",
    "tidal_downloads",
    "tidal_lifecycle",
    "tidal_models",
    "tidal_runtime",
    "tidal_search",
    "tidal_serializers",
    "tidal_stream",
)


def _clear_app_modules() -> None:
    """Remove the entrypoint and split modules so each test gets fresh state."""
    for module_name in APP_MODULES:
        sys.modules.pop(module_name, None)


@pytest.fixture(autouse=True)
def internal_api_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a known INTERNAL_API_SECRET for the app under test."""
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_API_SECRET)


@pytest.fixture(autouse=True)
def local_app_module() -> Iterator[None]:
    """Ensure `import app` resolves to this sidecar during the test."""
    _clear_app_modules()
    sys.path.insert(0, str(SERVICE_ROOT))
    sys.path.insert(0, str(REPOSITORY_ROOT))
    try:
        yield
    finally:
        _clear_app_modules()
        while str(SERVICE_ROOT) in sys.path:
            sys.path.remove(str(SERVICE_ROOT))
        while str(REPOSITORY_ROOT) in sys.path:
            sys.path.remove(str(REPOSITORY_ROOT))


@pytest.fixture()
def anyio_backend() -> Literal["asyncio"]:
    """Use asyncio for all async tests."""
    return "asyncio"


@pytest.fixture()
async def client() -> AsyncIterator[AsyncClient]:
    """Async HTTP client wired to the FastAPI app under test.

    Presents the internal-auth header by default so behaviour tests reach the
    handlers through the F31 `require_internal_secret` dependency.
    """
    from app import app

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-secret": INTERNAL_API_SECRET},
    ) as ac:
        yield ac
