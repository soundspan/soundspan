"""Upstream-faithful DCLAP audio preprocessing."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Protocol, cast

import numpy as np
import settings

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("vibe-provider-dclap")

SEGMENT_SAMPLES = 480000
SEGMENT_HOP_SAMPLES = 240000
N_FFT = 2048
MEL_HOP_SAMPLES = 480
N_MELS = 128
FMIN_HZ = 0
FMAX_HZ = 14000


class AudioDecodeError(RuntimeError):
    """Raised when librosa cannot decode a requested audio file."""


class MelFeature(Protocol):
    """Subset of ``librosa.feature`` required by the recipe."""

    def melspectrogram(self, **kwargs: object) -> object:
        """Create a power mel spectrogram."""


class LibrosaBackend(Protocol):
    """Narrow librosa seam used by preprocessing and tests."""

    feature: MelFeature

    def load(
        self,
        path: str,
        *,
        sr: int,
        mono: bool,
        duration: int,
    ) -> tuple[object, int]:
        """Load one mono waveform at the requested rate."""

    def power_to_db(self, mel: object, **kwargs: object) -> object:
        """Convert a power spectrogram to decibels."""


def _load_librosa() -> LibrosaBackend:
    """Import librosa only when an audio embedding is requested."""
    import librosa

    # librosa does not publish usable strict typing for this dynamic API surface.
    return cast(LibrosaBackend, librosa)


def int16_round_trip(audio: object) -> object:
    """Apply the teacher-compatible int16 quantization round trip exactly."""
    waveform = np.asarray(audio, dtype=np.float32)
    waveform = np.clip(waveform, -1.0, 1.0)
    return (waveform * 32767.0).astype(np.int16).astype(np.float32) / 32767.0


def segment_audio(audio: object) -> Iterator[object]:
    """Yield ten-second, 50%-overlap windows plus legacy tail capture."""
    waveform = np.asarray(audio, dtype=np.float32)
    total = int(waveform.size)
    if total <= SEGMENT_SAMPLES:
        yield np.pad(waveform, (0, SEGMENT_SAMPLES - total))
        return

    segment_count = 0
    for start in range(0, total - SEGMENT_SAMPLES + 1, SEGMENT_HOP_SAMPLES):
        yield waveform[start : start + SEGMENT_SAMPLES]
        segment_count += 1
    last_start = segment_count * SEGMENT_HOP_SAMPLES
    if last_start < total:
        yield waveform[-SEGMENT_SAMPLES:]


def create_log_mel(segment: object, backend: LibrosaBackend) -> object:
    """Create one float32 ``(1, 1, 128, time)`` log-mel tensor."""
    mel = backend.feature.melspectrogram(
        y=np.asarray(segment, dtype=np.float32),
        sr=settings.SAMPLE_RATE_HZ,
        n_fft=N_FFT,
        hop_length=MEL_HOP_SAMPLES,
        win_length=N_FFT,
        window="hann",
        center=True,
        pad_mode="reflect",
        power=2.0,
        n_mels=N_MELS,
        fmin=FMIN_HZ,
        fmax=FMAX_HZ,
    )
    log_mel = backend.power_to_db(mel, ref=1.0, amin=1e-10, top_db=None)
    return np.asarray(log_mel, dtype=np.float32)[np.newaxis, np.newaxis, :, :]


def load_segmented_log_mels(
    audio_path: str,
    backend: LibrosaBackend | None = None,
) -> Iterator[object]:
    """Load a bounded prefix and yield one quantized segment's log mel at a time."""
    librosa_backend = backend or _load_librosa()
    max_audio_seconds = settings.MAX_AUDIO_SECONDS
    try:
        audio, _sample_rate = librosa_backend.load(
            audio_path,
            sr=settings.SAMPLE_RATE_HZ,
            mono=True,
            duration=max_audio_seconds,
        )
    except Exception as error:
        raise AudioDecodeError("Audio could not be decoded") from error
    decoded_samples = int(np.asarray(audio).size)
    quantized = int16_round_trip(audio)
    del audio
    if decoded_samples >= max_audio_seconds * settings.SAMPLE_RATE_HZ:
        logger.warning(
            "Audio reached the %d-second decode cap; embedding the capped prefix: %s",
            max_audio_seconds,
            Path(audio_path).name,
        )
    for segment in segment_audio(quantized):
        yield create_log_mel(segment, librosa_backend)
