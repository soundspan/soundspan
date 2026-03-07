"""Shared fixtures for tidal-downloader tests."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _install_tiddl_stub() -> None:
    """Provide a lightweight `tiddl` stub so import-only tests can run."""
    if "tiddl" in sys.modules:
        return

    class _PlaceholderClient:
        def __init__(self, *args, **kwargs) -> None:
            self.args = args
            self.kwargs = kwargs

    class _PlaceholderApiError(Exception):
        """Fallback error used when tiddl is unavailable in tests."""

    class _PlaceholderAuthClientError(Exception):
        """Fallback auth error used when tiddl is unavailable in tests."""

    def _missing_tiddl(*_args, **_kwargs):
        raise ModuleNotFoundError("tiddl is not installed in the test environment")

    tiddl_module = types.ModuleType("tiddl")
    core_module = types.ModuleType("tiddl.core")
    auth_module = types.ModuleType("tiddl.core.auth")
    auth_client_module = types.ModuleType("tiddl.core.auth.client")
    api_module = types.ModuleType("tiddl.core.api")
    utils_module = types.ModuleType("tiddl.core.utils")
    format_module = types.ModuleType("tiddl.core.utils.format")
    metadata_module = types.ModuleType("tiddl.core.metadata")

    auth_module.AuthAPI = _PlaceholderClient
    auth_module.AuthClientError = _PlaceholderAuthClientError
    auth_client_module.AuthClient = _PlaceholderClient
    api_module.TidalAPI = _PlaceholderClient
    api_module.TidalClient = _PlaceholderClient
    api_module.ApiError = _PlaceholderApiError
    utils_module.get_track_stream_data = _missing_tiddl
    utils_module.parse_track_stream = _missing_tiddl
    format_module.format_template = _missing_tiddl
    metadata_module.add_track_metadata = _missing_tiddl
    metadata_module.Cover = _PlaceholderClient

    tiddl_module.core = core_module
    core_module.auth = auth_module
    core_module.api = api_module
    core_module.utils = utils_module
    core_module.metadata = metadata_module
    utils_module.format = format_module

    sys.modules["tiddl"] = tiddl_module
    sys.modules["tiddl.core"] = core_module
    sys.modules["tiddl.core.auth"] = auth_module
    sys.modules["tiddl.core.auth.client"] = auth_client_module
    sys.modules["tiddl.core.api"] = api_module
    sys.modules["tiddl.core.utils"] = utils_module
    sys.modules["tiddl.core.utils.format"] = format_module
    sys.modules["tiddl.core.metadata"] = metadata_module


_install_tiddl_stub()


@pytest.fixture(autouse=True)
def local_app_module():
    """Ensure `import app` resolves to this sidecar during the test."""
    sys.modules.pop("app", None)
    sys.path.insert(0, str(SERVICE_ROOT))
    try:
        yield
    finally:
        sys.modules.pop("app", None)
        while str(SERVICE_ROOT) in sys.path:
            sys.path.remove(str(SERVICE_ROOT))


@pytest.fixture()
def anyio_backend():
    """Use asyncio for all async tests."""
    return "asyncio"


@pytest.fixture()
async def client():
    """Async HTTP client wired to the FastAPI app under test."""
    from app import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
