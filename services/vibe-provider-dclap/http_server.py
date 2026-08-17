"""Internal HTTP wire-contract v1 for the DCLAP embedding provider."""

from __future__ import annotations

import asyncio
import hmac
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Protocol, cast

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from inference import normalize_vector
from model_provider import AudioDecodeError
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


class Provider(Protocol):
    """Model and lifecycle methods required by the HTTP transport."""

    def get_text_embedding(self, text: str) -> object:
        """Generate one text embedding."""

    def get_audio_embedding(self, audio_path: str) -> object:
        """Generate one audio embedding."""

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
        return JSONResponse({"error": str(error.detail)}, status_code=error.status_code)

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


async def embed_text(
    payload: TextEmbeddingRequest,
    request: Request,
) -> dict[str, list[float]]:
    """Generate one normalized teacher text-tower embedding."""
    try:
        embedding = await asyncio.to_thread(
            _provider(request).get_text_embedding,
            payload.text,
        )
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
        embedding = await asyncio.to_thread(
            _provider(request).get_audio_embedding,
            audio_path,
        )
    except AudioDecodeError as error:
        raise HTTPException(status_code=422, detail="Audio could not be decoded") from error
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
    _register_error_handlers(app)
    app.add_api_route("/health", health, methods=["GET"])
    app.add_api_route("/v1/space", space, methods=["GET"])
    app.add_api_route("/v1/embed/text", embed_text, methods=["POST"])
    app.add_api_route("/v1/embed/audio", embed_audio, methods=["POST"])
    return app
