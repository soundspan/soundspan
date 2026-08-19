"""Lazy, serialized ownership of the DCLAP ONNX model bundle."""

from __future__ import annotations

import gc
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar, cast

from inference import InferenceSession, TextTokenizer, run_audio_chunks, run_text
from preprocessing import AudioDecodeError, DecodedAudio, load_audio, segmented_log_mels
from settings import (
    MODEL_DIRECTORY,
    MODEL_IDLE_TIMEOUT,
    ONNX_INTRA_OP_THREADS,
    TOKENIZER_DIRECTORY,
)

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("vibe-provider-dclap")

IDLE_POLL_SECONDS = 5.0
MAX_IDLE_MONITOR_POLLS = 2**63 - 1
MAX_QUEUED_INFERENCE_REQUESTS = 4
MAX_CONFIGURED_QUEUED_REQUESTS = 64
MAX_CONCURRENT_AUDIO_DECODES = 2
INFERENCE_LOCK_POLL_SECONDS = 0.1
MAX_INFERENCE_LOCK_POLLS = 1_102
ResultT = TypeVar("ResultT")


class InferenceControlError(RuntimeError):
    """Base class for expected inference admission and cancellation outcomes."""


class InferenceCancelledError(InferenceControlError):
    """Raised after the request owner cancels admitted inference."""


class InferenceDeadlineExceededError(InferenceControlError):
    """Raised after admitted inference exceeds its monotonic deadline."""


class InferenceQueueFullError(InferenceControlError):
    """Raised when active and queued inference already consume capacity."""


class InferenceCancellation:
    """Thread-safe cooperative cancellation and monotonic deadline token."""

    def __init__(
        self,
        *,
        deadline: float | None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._deadline = deadline
        self._clock = clock
        self._cancelled = threading.Event()

    def cancel(self) -> None:
        """Request cancellation from the async transport owner."""
        self._cancelled.set()

    def raise_if_cancelled(self) -> None:
        """Raise the distinct cancellation or deadline outcome at a safe point."""
        if self._cancelled.is_set():
            raise InferenceCancelledError("Inference was cancelled")
        if self._deadline is not None and self._clock() >= self._deadline:
            raise InferenceDeadlineExceededError("Inference deadline exceeded")


@dataclass(frozen=True)
class ModelBundle:
    """Sessions and tokenizer released together after idle timeout."""

    audio_session: InferenceSession
    text_session: InferenceSession
    tokenizer: TextTokenizer


def _session_options() -> object:
    """Create ONNX Runtime options with a bounded intra-op thread pool."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = ONNX_INTRA_OP_THREADS
    return options


def _inference_session(model_path: Path, options: object) -> InferenceSession:
    """Create one CPU ONNX session behind the service's narrow protocol."""
    import onnxruntime as ort

    session = ort.InferenceSession(
        str(model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    # ONNX Runtime's untyped public class conforms to the protocol at runtime.
    return cast(InferenceSession, session)


def load_model_bundle() -> ModelBundle:
    """Load pinned local sessions and the vendored offline tokenizer."""
    from transformers import AutoTokenizer

    model_root = Path(MODEL_DIRECTORY)
    options = _session_options()
    audio_session = _inference_session(model_root / "model_epoch_36.onnx", options)
    text_session = _inference_session(model_root / "clap_text_model.onnx", options)
    tokenizer = AutoTokenizer.from_pretrained(
        TOKENIZER_DIRECTORY,
        local_files_only=True,
        use_fast=True,
    )
    # Transformers' factory return union conforms to the callable tokenizer protocol.
    return ModelBundle(audio_session, text_session, cast(TextTokenizer, tokenizer))


class DclapProvider:
    """Serialize inference and release the lazy model bundle after inactivity."""

    def __init__(
        self,
        *,
        load_models: Callable[[], ModelBundle] = load_model_bundle,
        idle_timeout: int = MODEL_IDLE_TIMEOUT,
        clock: Callable[[], float] = time.monotonic,
        max_queued_requests: int = MAX_QUEUED_INFERENCE_REQUESTS,
    ) -> None:
        if idle_timeout < 0:
            raise ValueError("idle_timeout must not be negative")
        if not 0 <= max_queued_requests <= MAX_CONFIGURED_QUEUED_REQUESTS:
            raise ValueError("max_queued_requests is outside the supported range")
        self._load_models = load_models
        self._idle_timeout = idle_timeout
        self._clock = clock
        self._models: ModelBundle | None = None
        self._last_work_at = clock()
        self._lock = threading.RLock()
        self._admission = threading.BoundedSemaphore(max_queued_requests + 1)
        self._decode_slots = threading.BoundedSemaphore(MAX_CONCURRENT_AUDIO_DECODES)
        self._stop_event = threading.Event()
        self._monitor_thread: threading.Thread | None = None

    def try_reserve_inference(self) -> bool:
        """Reserve bounded HTTP admission before executor submission."""
        return self._admission.acquire(blocking=False)

    def release_inference(self) -> None:
        """Release one HTTP-owned inference admission slot."""
        self._admission.release()

    @property
    def models_loaded(self) -> bool:
        """Return whether the model bundle currently occupies memory."""
        with self._lock:
            return self._models is not None

    def _models_locked(self) -> ModelBundle:
        """Load and return the bundle while the inference lock is held."""
        if self._models is None:
            logger.info("Loading DCLAP ONNX audio and text models")
            self._models = self._load_models()
        return self._models

    def _run_serialized(
        self,
        operation: Callable[[], ResultT],
        cancellation: InferenceCancellation,
    ) -> ResultT:
        """Serialize tokenizer and ONNX state with cancellation safe points."""
        cancellation.raise_if_cancelled()
        for _poll in range(MAX_INFERENCE_LOCK_POLLS):
            cancellation.raise_if_cancelled()
            if self._lock.acquire(timeout=INFERENCE_LOCK_POLL_SECONDS):
                break
        else:
            raise InferenceDeadlineExceededError("Inference lock wait exceeded")
        try:
            cancellation.raise_if_cancelled()
            result = operation()
            cancellation.raise_if_cancelled()
            self._last_work_at = self._clock()
            return result
        finally:
            self._lock.release()

    def _decode_audio(
        self,
        audio_path: str,
        cancellation: InferenceCancellation,
    ) -> DecodedAudio:
        """Decode one bounded waveform under its own concurrency limit."""
        for _poll in range(MAX_INFERENCE_LOCK_POLLS):
            cancellation.raise_if_cancelled()
            if self._decode_slots.acquire(timeout=INFERENCE_LOCK_POLL_SECONDS):
                break
        else:
            raise InferenceDeadlineExceededError("Audio decode wait exceeded")
        try:
            return load_audio(
                audio_path,
                check_cancelled=cancellation.raise_if_cancelled,
            )
        finally:
            self._decode_slots.release()

    def get_text_embedding(
        self,
        text: str,
        cancellation: InferenceCancellation | None = None,
    ) -> object:
        """Return one normalized teacher text-tower embedding."""
        control = cancellation or InferenceCancellation(deadline=None)

        def infer() -> object:
            models = self._models_locked()
            return run_text(models.text_session, models.tokenizer, text)

        return self._run_serialized(infer, control)

    def get_audio_embedding(
        self,
        audio_path: str,
        cancellation: InferenceCancellation | None = None,
    ) -> object:
        """Return one normalized, chunk-aggregated student audio embedding."""
        control = cancellation or InferenceCancellation(deadline=None)
        decoded_audio = self._decode_audio(audio_path, control)
        control.raise_if_cancelled()

        def infer() -> object:
            models = self._models_locked()
            mel_tensors = segmented_log_mels(
                decoded_audio,
                check_cancelled=control.raise_if_cancelled,
            )
            return run_audio_chunks(
                models.audio_session,
                mel_tensors,
                control.raise_if_cancelled,
            )

        return self._run_serialized(infer, control)

    def unload_if_idle(self) -> bool:
        """Release loaded models once the configured idle timeout expires."""
        with self._lock:
            idle_for = self._clock() - self._last_work_at
            if self._models is None or self._idle_timeout <= 0 or idle_for < self._idle_timeout:
                return False
            self._models = None
        collected = gc.collect()
        logger.info("Unloaded idle DCLAP models; garbage collector released %d objects", collected)
        return True

    def _monitor_idle(self) -> None:
        """Poll for idle expiry until app shutdown."""
        for _poll in range(MAX_IDLE_MONITOR_POLLS):
            if self._stop_event.wait(IDLE_POLL_SECONDS):
                return
            self.unload_if_idle()

    def start_idle_monitor(self) -> None:
        """Start the single model-idle lifecycle thread once."""
        if self._monitor_thread is not None and self._monitor_thread.is_alive():
            return
        self._stop_event.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitor_idle,
            name="DclapIdleMonitor",
            daemon=True,
        )
        self._monitor_thread.start()

    def stop_idle_monitor(self) -> None:
        """Stop and join the model-idle lifecycle thread within a fixed budget."""
        self._stop_event.set()
        monitor = self._monitor_thread
        if monitor is None:
            return
        monitor.join(timeout=IDLE_POLL_SECONDS + 1.0)
        if monitor.is_alive():
            logger.warning("DCLAP idle monitor did not stop within the shutdown budget")
        self._monitor_thread = None


__all__ = [
    "MAX_QUEUED_INFERENCE_REQUESTS",
    "AudioDecodeError",
    "DclapProvider",
    "InferenceCancellation",
    "InferenceCancelledError",
    "InferenceControlError",
    "InferenceDeadlineExceededError",
    "InferenceQueueFullError",
    "ModelBundle",
]
