"""Lifecycle tests for lazy DCLAP model ownership."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import model_provider
import numpy as np
import pytest
import settings
from model_provider import DclapProvider, ModelBundle


class Clock:
    """Controllable monotonic clock."""

    def __init__(self) -> None:
        self.now = 10.0

    def __call__(self) -> float:
        """Return the current test time."""
        return self.now


class TextSession:
    """Return one fixed valid text embedding."""

    def run(self, _outputs: list[str] | None, _feed: dict[str, object]) -> list[object]:
        """Return a single ONNX-shaped vector."""
        return [np.ones((1, 512), dtype=np.float32)]


class AudioSession(TextSession):
    """Unused valid audio session fixture."""


class Tokenizer:
    """Return fixed NumPy token tensors."""

    def __call__(self, _text: str, **_kwargs: object) -> dict[str, object]:
        """Return input IDs and an attention mask."""
        return {
            "input_ids": np.ones((1, 77), dtype=np.int64),
            "attention_mask": np.ones((1, 77), dtype=np.int64),
        }


def test_first_embed_loads_lazily_then_idle_unload_reloads() -> None:
    """Load on demand, release after idle timeout, and reload on new work."""
    clock = Clock()
    load_count = 0

    def load_models() -> ModelBundle:
        nonlocal load_count
        load_count += 1
        return ModelBundle(AudioSession(), TextSession(), Tokenizer())

    provider = DclapProvider(load_models=load_models, idle_timeout=5, clock=clock)

    assert not provider.models_loaded
    assert len(provider.get_text_embedding("mellow jazz")) == 512
    assert load_count == 1
    clock.now += 6
    assert provider.unload_if_idle()
    assert not provider.models_loaded
    assert len(provider.get_text_embedding("bright pop")) == 512
    assert load_count == 2


def test_idle_timeout_zero_disables_unload() -> None:
    """Retain loaded models when idle unloading is explicitly disabled."""
    clock = Clock()
    provider = DclapProvider(
        load_models=lambda: ModelBundle(AudioSession(), TextSession(), Tokenizer()),
        idle_timeout=0,
        clock=clock,
    )
    provider.get_text_embedding("mellow jazz")
    clock.now += 3600

    assert not provider.unload_if_idle()
    assert provider.models_loaded


def test_session_options_apply_default_onnx_thread_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Set ONNX intra-op threads to the service's default cap of one."""

    class Options:
        intra_op_num_threads = 0

    fake_runtime = SimpleNamespace(SessionOptions=Options)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_runtime)

    options = model_provider._session_options()

    assert settings.ONNX_INTRA_OP_THREADS == 1
    assert isinstance(options, Options)
    assert options.intra_op_num_threads == 1
