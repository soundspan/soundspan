"""Entrypoint wiring tests for the standalone DCLAP process."""

from __future__ import annotations

import importlib.util
import threading
from pathlib import Path
from types import ModuleType

import pytest


def _load_main() -> ModuleType:
    """Load the service entrypoint without executing its script guard."""
    main_path = Path(__file__).resolve().parents[1] / "__main__.py"
    spec = importlib.util.spec_from_file_location("dclap_main_test_module", main_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_main_runs_uvicorn_server_on_the_calling_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Let Uvicorn own main-thread signal handling without a server wrapper thread."""
    module = _load_main()
    calling_thread = threading.get_ident()
    run_threads: list[int] = []

    class FakeServer:
        def __init__(self, _config: object) -> None:
            pass

        def run(self) -> None:
            run_threads.append(threading.get_ident())

    monkeypatch.setattr(module, "DclapProvider", lambda: object())
    monkeypatch.setattr(module, "create_app", lambda _provider: object())
    monkeypatch.setattr(module.uvicorn, "Config", lambda *args, **kwargs: object())
    monkeypatch.setattr(module.uvicorn, "Server", FakeServer)

    module.main()

    assert run_threads == [calling_thread]
