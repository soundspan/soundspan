"""Internal HTTP wire-contract v1 for the DCLAP embedding provider."""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Never, Protocol, cast

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from inference import normalize_vector
from model_provider import (
    AudioDecodeError,
    InferenceCancellation,
    InferenceCancelledError,
    InferenceControlError,
    InferenceDeadlineExceededError,
    InferenceQueueFullError,
)
from music_path import resolve_music_path
from pydantic import BaseModel, ConfigDict, Field, field_validator
from settings import (
    EMBEDDING_CHECKPOINT_HASH,
    EMBEDDING_DIM,
    EMBEDDING_PREPROCESSING,
    EMBEDDING_SPACE_FAMILY,
    MODEL_VERSION,
    SAMPLE_RATE_HZ,
)
from starlette.exceptions import HTTPException as StarletteHTTPException

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("vibe-provider-dclap-http")
TEXT_INFERENCE_BUDGET_SECONDS = 25.0
AUDIO_INFERENCE_BUDGET_SECONDS = 100.0
DISCONNECT_POLL_SECONDS = 0.1
MAX_INFERENCE_POLLS = 1_002


class Provider(Protocol):
    """Model and lifecycle methods required by the HTTP transport."""

    def get_text_embedding(
        self,
        text: str,
        cancellation: InferenceCancellation,
    ) -> object:
        """Generate one text embedding."""

    def get_audio_embedding(
        self,
        audio_path: str,
        cancellation: InferenceCancellation,
    ) -> object:
        """Generate one audio embedding."""

    def try_reserve_inference(self) -> bool:
        """Reserve admission before work reaches the executor."""

    def release_inference(self) -> None:
        """Release one reserved inference slot."""

    def start_idle_monitor(self) -> None:
        """Start idle model unloading."""

    def stop_idle_monitor(self) -> None:
        """Stop idle model unloading."""


class TextEmbeddingRequest(BaseModel):
    """Validated text embedding request body."""

    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=2048, strict=True)

    @field_validator("text")
    @classmethod
    def reject_whitespace_only_text(cls, value: str) -> str:
        """Require text to contain at least one non-whitespace character."""
        if not value.strip():
            raise ValueError("text must not be blank")
        return value


class AudioEmbeddingRequest(BaseModel):
    """Validated audio embedding request body."""

    model_config = ConfigDict(extra="forbid")
    track_ref: str = Field(alias="trackRef", min_length=1, strict=True)


async def require_internal_secret(request: Request) -> None:
    """Require the configured internal secret on every HTTP request."""
    expected = os.getenv("INTERNAL_API_SECRET")
    if not expected:
        return
    provided = request.headers.get("x-internal-secret")
    if not isinstance(provided, str) or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _register_error_handlers(app: FastAPI) -> None:
    """Install the provider's stable non-200 JSON response shape."""

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(
        _request: Request,
        error: StarletteHTTPException,
    ) -> JSONResponse:
        return JSONResponse(
            {"error": str(error.detail)},
            status_code=error.status_code,
            headers=error.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse({"error": "Invalid request body"}, status_code=400)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.error(
            "Unhandled HTTP provider error on %s %s: %s",
            request.method,
            request.url.path,
            error,
            exc_info=True,  # noqa: LOG014 -- registered handler runs with an active exception
        )
        return JSONResponse({"error": "Internal Server Error"}, status_code=500)


def _provider(request: Request) -> Provider:
    """Return the provider bound to this app."""
    return cast(Provider, request.app.state.provider)


async def health() -> dict[str, str]:
    """Report that the HTTP layer is serving without loading models."""
    return {"status": "ok"}


async def space() -> dict[str, object]:
    """Return the distinct DCLAP student embedding-space identity."""
    return {
        "family": EMBEDDING_SPACE_FAMILY,
        "checkpointHash": EMBEDDING_CHECKPOINT_HASH,
        "dim": EMBEDDING_DIM,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "preprocessing": EMBEDDING_PREPROCESSING,
        "revision": MODEL_VERSION,
        "textTower": True,
    }


def _model_vector(value: object) -> list[float]:
    """Map an invalid model result to provider unavailability."""
    try:
        return normalize_vector(value)
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error


def _raise_inference_control_error(error: InferenceControlError) -> Never:
    """Map expected model-control outcomes to stable retryable HTTP responses."""
    if isinstance(error, InferenceDeadlineExceededError):
        raise HTTPException(status_code=408, detail="Inference deadline exceeded") from error
    if isinstance(error, InferenceQueueFullError):
        raise HTTPException(
            status_code=429,
            detail="Inference queue is full",
            headers={"Retry-After": "1"},
        ) from error
    if isinstance(error, InferenceCancelledError):
        raise HTTPException(status_code=503, detail="Inference cancelled") from error
    raise HTTPException(status_code=503, detail="Model unavailable") from error


async def _run_provider_call(
    request: Request,
    operation: object,
    argument: str,
    budget_seconds: float,
) -> object:
    """Reserve and await blocking inference within the HTTP-owned budget."""
    provider = _provider(request)
    if not provider.try_reserve_inference():
        raise InferenceQueueFullError("Inference queue is full")
    provider_call = cast(ProtocolProviderCall, operation)
    cancellation = InferenceCancellation(
        deadline=time.monotonic() + budget_seconds,
    )
    try:
        task = asyncio.create_task(
            _run_reserved_provider_call(
                provider,
                provider_call,
                argument,
                cancellation,
            )
        )
    except BaseException:
        provider.release_inference()
        raise
    _track_provider_task(request, task)
    try:
        return await asyncio.wait_for(
            _poll_provider_task(request, task, cancellation),
            timeout=budget_seconds,
        )
    except TimeoutError as error:
        cancellation.cancel()
        raise InferenceCancelledError("Inference budget expired") from error
    except asyncio.CancelledError:
        cancellation.cancel()
        raise


async def _run_reserved_provider_call(
    provider: Provider,
    provider_call: ProtocolProviderCall,
    argument: str,
    cancellation: InferenceCancellation,
) -> object:
    """Run one admitted thread task and release its slot when the task settles."""
    try:
        return await asyncio.to_thread(provider_call, argument, cancellation)
    finally:
        provider.release_inference()


async def _poll_provider_task(
    request: Request,
    task: asyncio.Task[object],
    cancellation: InferenceCancellation,
) -> object:
    """Observe completion and disconnects at fixed bounded intervals."""
    for _poll in range(MAX_INFERENCE_POLLS):
        done, _pending = await asyncio.wait(
            {task},
            timeout=DISCONNECT_POLL_SECONDS,
        )
        if done:
            return await task
        if await request.is_disconnected():
            cancellation.cancel()
            raise InferenceCancelledError("Inference client disconnected")
    raise InferenceDeadlineExceededError("Inference polling bound exceeded")


def _track_provider_task(request: Request, task: asyncio.Task[object]) -> None:
    """Keep timed-out provider tasks owned and observe their final result."""
    tasks = cast(set[asyncio.Task[object]], request.app.state.provider_tasks)
    tasks.add(task)

    def observe(completed: asyncio.Task[object]) -> None:
        tasks.discard(completed)
        if completed.cancelled():
            return
        with suppress(Exception):
            completed.result()

    task.add_done_callback(observe)


class ProtocolProviderCall(Protocol):
    """One synchronous provider inference call accepted by the thread runner."""

    def __call__(
        self,
        argument: str,
        cancellation: InferenceCancellation,
    ) -> object:
        """Run one controlled inference operation."""


async def embed_text(
    payload: TextEmbeddingRequest,
    request: Request,
) -> dict[str, list[float]]:
    """Generate one normalized teacher text-tower embedding."""
    try:
        embedding = await _run_provider_call(
            request,
            _provider(request).get_text_embedding,
            payload.text,
            TEXT_INFERENCE_BUDGET_SECONDS,
        )
    except InferenceControlError as error:
        _raise_inference_control_error(error)
    except Exception as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error
    return {"vector": _model_vector(embedding)}


def _audio_path(track_ref: str) -> str:
    """Resolve a contained track and preserve the 400-versus-404 split."""
    audio_path = resolve_music_path(track_ref)
    if audio_path is None:
        raise HTTPException(status_code=400, detail="Invalid trackRef")
    if not os.path.isfile(audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return audio_path


async def embed_audio(
    payload: AudioEmbeddingRequest,
    request: Request,
) -> dict[str, list[float]]:
    """Resolve a library track and generate one student audio embedding."""
    audio_path = _audio_path(payload.track_ref)
    try:
        embedding = await _run_provider_call(
            request,
            _provider(request).get_audio_embedding,
            audio_path,
            AUDIO_INFERENCE_BUDGET_SECONDS,
        )
    except AudioDecodeError as error:
        raise HTTPException(status_code=422, detail="Audio could not be decoded") from error
    except InferenceControlError as error:
        _raise_inference_control_error(error)
    except Exception as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error
    return {"vector": _model_vector(embedding)}


def create_app(provider: Provider) -> FastAPI:
    """Create the provider app with model lifecycle ownership."""

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        provider.start_idle_monitor()
        try:
            yield
        finally:
            provider.stop_idle_monitor()

    app = FastAPI(
        title="soundspan DCLAP Embedding Provider",
        version=MODEL_VERSION,
        dependencies=[Depends(require_internal_secret)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.provider = provider
    app.state.provider_tasks = set()
    _register_error_handlers(app)
    app.add_api_route("/health", health, methods=["GET"])
    app.add_api_route("/v1/space", space, methods=["GET"])
    app.add_api_route("/v1/embed/text", embed_text, methods=["POST"])
    app.add_api_route("/v1/embed/audio", embed_audio, methods=["POST"])
    return app
