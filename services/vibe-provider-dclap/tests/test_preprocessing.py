"""Unit tests for the upstream-faithful DCLAP audio recipe."""

from __future__ import annotations

import math
from collections.abc import Iterator

import numpy as np
import pytest
from inference import run_audio_chunks, run_text
from preprocessing import (
    SEGMENT_SAMPLES,
    create_log_mel,
    int16_round_trip,
    segment_audio,
)


class StubFeature:
    """Return a deterministic mel matrix and record recipe arguments."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def melspectrogram(self, **kwargs: object) -> object:
        """Record the call and return the expected raw mel shape."""
        self.calls.append(kwargs)
        return np.ones((128, 1001), dtype=np.float32)


class StubLibrosa:
    """Minimal librosa-compatible mel backend."""

    def __init__(self) -> None:
        self.feature = StubFeature()
        self.power_calls: list[dict[str, object]] = []

    def power_to_db(self, mel: object, **kwargs: object) -> object:
        """Record power-to-dB arguments without changing the fixture."""
        self.power_calls.append(kwargs)
        return mel


class StubSession:
    """Return a fixed sequence of ONNX output tensors."""

    def __init__(self, embeddings: list[object]) -> None:
        self._embeddings: Iterator[object] = iter(embeddings)
        self.feeds: list[dict[str, object]] = []

    def run(self, _outputs: list[str] | None, feed: dict[str, object]) -> list[object]:
        """Record one feed and return the next embedding."""
        self.feeds.append(feed)
        return [next(self._embeddings)]


class StubTokenizer:
    """Record text tokenization arguments and return length-77 tensors."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def __call__(self, text: str, **kwargs: object) -> dict[str, object]:
        """Return deterministic teacher-tower inputs."""
        self.calls.append((text, kwargs))
        return {
            "input_ids": np.ones((1, 77), dtype=np.int64),
            "attention_mask": np.ones((1, 77), dtype=np.int64),
        }


def test_short_audio_is_one_padded_segment() -> None:
    """Pad audio shorter than ten seconds into one model segment."""
    segments = segment_audio(np.ones(SEGMENT_SAMPLES - 1, dtype=np.float32))

    assert len(segments) == 1
    assert np.asarray(segments[0]).shape == (SEGMENT_SAMPLES,)
    assert float(np.asarray(segments[0])[-1]) == 0.0


def test_exact_boundary_is_one_segment() -> None:
    """Keep exactly ten seconds as one segment without an extra tail."""
    segments = segment_audio(np.ones(SEGMENT_SAMPLES, dtype=np.float32))

    assert len(segments) == 1
    np.testing.assert_array_equal(segments[0], np.ones(SEGMENT_SAMPLES, dtype=np.float32))


def test_long_audio_uses_windows_plus_tail_capture() -> None:
    """Apply 50% overlap and append the final slice per the upstream recipe."""
    audio = np.arange(SEGMENT_SAMPLES * 2 + 1, dtype=np.float32)

    segments = segment_audio(audio)

    assert len(segments) == 4
    np.testing.assert_array_equal(segments[-1], audio[-SEGMENT_SAMPLES:])


def test_int16_round_trip_is_idempotent_for_quantized_input() -> None:
    """Keep already-quantized sample values stable across another round trip."""
    source = np.array([-32767, -123, 0, 123, 32767], dtype=np.float32) / 32767.0

    first = int16_round_trip(source)
    second = int16_round_trip(first)

    np.testing.assert_array_equal(first, second)


def test_int16_round_trip_clips_overshoot_before_quantization() -> None:
    """Clamp resampling overshoot so positive full scale cannot wrap negative."""
    quantized = np.asarray(int16_round_trip(np.array([1.0, 1.01], dtype=np.float32)))

    assert quantized[1] >= 0.0
    assert quantized[1] == quantized[0]


def test_create_log_mel_uses_pinned_recipe_and_shape() -> None:
    """Produce the model's float32 NCHW mel tensor with exact parameters."""
    backend = StubLibrosa()

    result = create_log_mel(np.ones(SEGMENT_SAMPLES, dtype=np.float32), backend)

    assert np.asarray(result).shape == (1, 1, 128, 1001)
    assert np.asarray(result).dtype == np.float32
    assert len(backend.feature.calls) == 1
    mel_call = backend.feature.calls[0]
    np.testing.assert_array_equal(mel_call.pop("y"), np.ones(SEGMENT_SAMPLES))
    assert mel_call == {
        "sr": 48000,
        "n_fft": 2048,
        "hop_length": 480,
        "win_length": 2048,
        "window": "hann",
        "center": True,
        "pad_mode": "reflect",
        "power": 2.0,
        "n_mels": 128,
        "fmin": 0,
        "fmax": 14000,
    }
    assert backend.power_calls == [{"ref": 1.0, "amin": 1e-10, "top_db": None}]


def test_audio_chunk_embeddings_are_meaned_and_l2_normalized() -> None:
    """Aggregate two known ONNX chunk vectors as mean plus L2 normalization."""
    first = np.zeros((1, 512), dtype=np.float32)
    second = np.zeros((1, 512), dtype=np.float32)
    first[0, 0] = 1.0
    second[0, 1] = 1.0
    session = StubSession([first, second])
    mel_tensors = [
        np.zeros((1, 1, 128, 1001), dtype=np.float32),
        np.ones((1, 1, 128, 1001), dtype=np.float32),
    ]

    vector = run_audio_chunks(session, mel_tensors)

    assert len(vector) == 512
    assert math.isclose(vector[0], 1 / math.sqrt(2), rel_tol=1e-6)
    assert math.isclose(vector[1], 1 / math.sqrt(2), rel_tol=1e-6)
    assert all(value == 0.0 for value in vector[2:])
    assert [set(feed) for feed in session.feeds] == [
        {"mel_spectrogram"},
        {"mel_spectrogram"},
    ]


def test_text_inference_uses_length_77_inputs_and_normalizes() -> None:
    """Feed the teacher tower its two int64 inputs at the pinned token length."""
    output = np.zeros((1, 512), dtype=np.float32)
    output[0, 0] = 3.0
    output[0, 1] = 4.0
    session = StubSession([output])
    tokenizer = StubTokenizer()

    vector = run_text(session, tokenizer, "mellow jazz")

    assert tokenizer.calls == [
        (
            "mellow jazz",
            {
                "padding": "max_length",
                "truncation": True,
                "max_length": 77,
                "return_tensors": "np",
            },
        )
    ]
    assert np.asarray(session.feeds[0]["input_ids"]).dtype == np.int64
    assert np.asarray(session.feeds[0]["attention_mask"]).shape == (1, 77)
    assert vector[:2] == [pytest.approx(0.6), pytest.approx(0.8)]


def test_text_inference_uses_pinned_normalization_epsilon() -> None:
    """Apply the same 1e-9 normalization epsilon as the audio tower."""
    output = np.zeros((1, 512), dtype=np.float32)
    output[0, 0] = 1e-9
    session = StubSession([output])

    vector = run_text(session, StubTokenizer(), "quiet ambience")

    assert vector[0] == pytest.approx(0.5)
