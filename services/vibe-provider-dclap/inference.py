"""Typed adapters for DCLAP ONNX audio and text inference."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

import numpy as np
from settings import EMBEDDING_DIM


class InferenceSession(Protocol):
    """Subset of an ONNX Runtime session used by this provider."""

    def run(self, outputs: list[str] | None, feed: dict[str, object]) -> list[object]:
        """Run one ONNX inference call."""


class TextTokenizer(Protocol):
    """Tokenizer call required by the teacher text tower."""

    def __call__(
        self,
        text: str,
        *,
        padding: str,
        truncation: bool,
        max_length: int,
        return_tensors: str,
    ) -> Mapping[str, object]:
        """Tokenize one string into model inputs."""


def _output_value(outputs: list[object]) -> object:
    """Return the first ONNX output or reject an empty response."""
    if not outputs:
        raise ValueError("ONNX session returned no outputs")
    return outputs[0]


def _embedding_row(value: object) -> object:
    """Convert an ONNX result into one 512-dimensional float32 row."""
    array = np.asarray(value, dtype=np.float32)
    if array.shape == (1, EMBEDDING_DIM):
        return array[0]
    if array.shape == (EMBEDDING_DIM,):
        return array
    raise ValueError("Embedding has an invalid dimension")


def normalize_vector(value: object, *, epsilon: float = 0.0) -> list[float]:
    """Validate and L2-normalize a finite 512-dimensional vector."""
    vector = np.asarray(_embedding_row(value), dtype=np.float32)
    if not np.isfinite(vector).all():
        raise ValueError("Embedding contains a non-finite value")
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("Embedding has an invalid norm")
    normalized = vector / (norm + epsilon)
    return [float(component) for component in normalized]


def run_audio_chunks(session: InferenceSession, mel_tensors: list[object]) -> list[float]:
    """Infer each chunk, then apply the pinned mean-plus-L2 aggregation."""
    if not mel_tensors:
        raise ValueError("Audio preprocessing returned no chunks")
    embeddings: list[object] = []
    for mel_tensor in mel_tensors:
        outputs = session.run(None, {"mel_spectrogram": mel_tensor})
        embeddings.append(_embedding_row(_output_value(outputs)))
    average = np.mean(np.stack(embeddings, axis=0), axis=0)
    return normalize_vector(average, epsilon=1e-9)


def run_text(session: InferenceSession, tokenizer: TextTokenizer, text: str) -> list[float]:
    """Tokenize at length 77, infer the teacher tower, and L2-normalize."""
    tokens = tokenizer(
        text,
        padding="max_length",
        truncation=True,
        max_length=77,
        return_tensors="np",
    )
    input_ids = tokens.get("input_ids")
    attention_mask = tokens.get("attention_mask")
    if input_ids is None or attention_mask is None:
        raise ValueError("Tokenizer omitted required model inputs")
    outputs = session.run(
        None,
        {
            "input_ids": np.asarray(input_ids, dtype=np.int64),
            "attention_mask": np.asarray(attention_mask, dtype=np.int64),
        },
    )
    return normalize_vector(_output_value(outputs), epsilon=1e-9)
