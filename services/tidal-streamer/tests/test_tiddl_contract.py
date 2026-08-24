"""Contract checks for the real installed tiddl download utilities."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

TIDDL_CONTRACT_PROBE = """
import inspect
import json
from importlib import import_module


def annotation_name(annotation):
    if isinstance(annotation, type):
        return f"{annotation.__module__}.{annotation.__qualname__}"
    return str(annotation)


try:
    ffmpeg_module = import_module("tiddl.core.utils.ffmpeg")
    download_module = import_module("tiddl.core.utils.download")
except ModuleNotFoundError:
    print(json.dumps({"importable": False}))
else:
    extract_signature = inspect.signature(ffmpeg_module.extract_flac)
    extract_parameters = list(extract_signature.parameters.values())
    download_signature = inspect.signature(download_module.download)
    download_parameters = list(download_signature.parameters.values())
    contract = {
        "importable": True,
        "extract_flac": {
            "parameter_count": len(extract_parameters),
            "parameters": [
                {
                    "annotation": annotation_name(parameter.annotation),
                    "default_empty": parameter.default is inspect.Parameter.empty,
                    "kind": parameter.kind.name,
                }
                for parameter in extract_parameters
            ],
            "return_annotation": annotation_name(extract_signature.return_annotation),
        },
        "ffmpeg_error": {
            "is_type": isinstance(ffmpeg_module.FFmpegError, type),
            "is_runtime_error": issubclass(ffmpeg_module.FFmpegError, RuntimeError),
        },
        "download": {
            "parameter_count": len(download_parameters),
            "parameters": [
                {
                    "annotation": annotation_name(parameter.annotation),
                    "default_empty": parameter.default is inspect.Parameter.empty,
                    "kind": parameter.kind.name,
                }
                for parameter in download_parameters
            ],
        },
    }
    print(json.dumps(contract))
"""


def _inspect_real_tiddl() -> object:
    """Inspect installed tiddl in a process isolated from the suite stub."""
    result = subprocess.run(  # noqa: S603 -- fixed interpreter executes a code-owned probe
        [sys.executable, "-c", TIDDL_CONTRACT_PROBE],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        pytest.fail(f"tiddl contract probe returned invalid JSON: {error}")


def test_real_tiddl_download_utility_contract() -> None:
    contract = _inspect_real_tiddl()
    assert isinstance(contract, dict)
    if contract == {"importable": False}:
        pytest.skip("real tiddl is not installed")

    assert contract == {
        "importable": True,
        "extract_flac": {
            "parameter_count": 1,
            "parameters": [
                {
                    "annotation": "pathlib.Path",
                    "default_empty": True,
                    "kind": "POSITIONAL_OR_KEYWORD",
                }
            ],
            "return_annotation": "pathlib.Path",
        },
        "ffmpeg_error": {"is_type": True, "is_runtime_error": True},
        "download": {
            "parameter_count": 1,
            "parameters": [
                {
                    "annotation": "list[str]",
                    "default_empty": True,
                    "kind": "POSITIONAL_OR_KEYWORD",
                }
            ],
        },
    }
