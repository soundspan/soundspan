"""Lifecycle tests for lazy DCLAP model ownership."""

from __future__ import annotations

import sys
import threading
from types import SimpleNamespace

import model_provider
import numpy as np
import pytest
import settings
from model_provider import (
    MAX_QUEUED_INFERENCE_REQUESTS,
    DclapProvider,
    InferenceCancellation,
    InferenceCancelledError,
    InferenceQueueFullError,
    ModelBundle,
)


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


def test_cancelled_audio_stops_between_segments_and_releases_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop before the next ONNX batch and leave serialized inference usable."""
    first_segment_started = threading.Event()
    release_first_segment = threading.Event()

    class BlockingAudioSession(AudioSession):
        def run(
            self,
            _outputs: list[str] | None,
            _feed: dict[str, object],
        ) -> list[object]:
            first_segment_started.set()
            assert release_first_segment.wait(timeout=1)
            return [np.ones((1, 512), dtype=np.float32)]

    monkeypatch.setattr(
        model_provider,
        "load_segmented_log_mels",
        lambda _path: iter([object(), object()]),
    )
    provider = DclapProvider(
        load_models=lambda: ModelBundle(
            BlockingAudioSession(),
            TextSession(),
            Tokenizer(),
        ),
        idle_timeout=0,
    )
    cancellation = InferenceCancellation(deadline=None)
    errors: list[BaseException] = []

    def embed_audio() -> None:
        try:
            provider.get_audio_embedding("track.flac", cancellation)
        except BaseException as error:
            errors.append(error)

    worker = threading.Thread(target=embed_audio)
    worker.start()
    assert first_segment_started.wait(timeout=1)
    cancellation.cancel()
    release_first_segment.set()
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], InferenceCancelledError)
    assert (
        len(
            provider.get_text_embedding(
                "lock remains usable",
                InferenceCancellation(deadline=None),
            )
        )
        == 512
    )


def test_queue_full_rejects_without_waiting_for_inference_lock() -> None:
    """Reject above the configured queued-request bound before a thread stacks."""
    active_started = threading.Event()
    release_active = threading.Event()

    class BlockingTextSession(TextSession):
        def run(
            self,
            _outputs: list[str] | None,
            _feed: dict[str, object],
        ) -> list[object]:
            active_started.set()
            assert release_active.wait(timeout=1)
            return [np.ones((1, 512), dtype=np.float32)]

    provider = DclapProvider(
        load_models=lambda: ModelBundle(
            AudioSession(),
            BlockingTextSession(),
            Tokenizer(),
        ),
        idle_timeout=0,
        max_queued_requests=0,
    )
    active = threading.Thread(
        target=provider.get_text_embedding,
        args=("active", InferenceCancellation(deadline=None)),
    )
    active.start()
    assert active_started.wait(timeout=1)

    with pytest.raises(InferenceQueueFullError):
        provider.get_text_embedding(
            "rejected",
            InferenceCancellation(deadline=None),
        )

    release_active.set()
    active.join(timeout=1)
    assert not active.is_alive()
    assert MAX_QUEUED_INFERENCE_REQUESTS == 4
