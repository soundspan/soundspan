"""Internal HTTP provider contract for the torch CLAP analyzer."""

from __future__ import annotations

import hmac
import os
import threading
from typing import Any, Protocol

import analyzer as clap
import numpy as np
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException


class Analyzer(Protocol):
    """Embedding methods required by the HTTP transport."""

    def get_text_embedding(self, text: str) -> object | None:
        """Generate one text embedding (numpy array; Any-typed boundary)."""

    def get_audio_embedding(self, audio_path: str) -> object | None:
        """Generate one audio embedding (numpy array; Any-typed boundary)."""


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


def require_internal_secret(request: Request) -> None:
    """Require the configured internal secret on every HTTP request."""
    expected = os.getenv("INTERNAL_API_SECRET")
    if not expected:
        return
    provided = request.headers.get("x-internal-secret")
    if not isinstance(provided, str) or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _normalize_vector(value: object) -> list[float]:
    """Validate and L2-normalize one 512-dimensional embedding."""
    vector = np.asarray(value, dtype=np.float32)
    if vector.shape != (clap.EMBEDDING_DIM,):
        raise ValueError("Embedding has an invalid dimension")
    if not np.isfinite(vector).all():
        raise ValueError("Embedding contains a non-finite value")
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("Embedding has an invalid norm")
    normalized = (vector / norm).astype(np.float32)
    return [float(component) for component in normalized]


def _model_vector(value: object) -> list[float]:
    """Map an invalid model result to provider unavailability."""
    try:
        return _normalize_vector(value)
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error


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
        clap.logger.error(
            "Unhandled HTTP provider error on %s %s: %s",
            request.method,
            request.url.path,
            error,
            exc_info=True,
        )
        return JSONResponse({"error": "Internal Server Error"}, status_code=500)


def _analyzer(request: Request) -> Analyzer:
    """Return the analyzer instance bound to this app."""
    analyzer: Analyzer = request.app.state.analyzer
    return analyzer


def health() -> dict[str, str]:
    """Report that the HTTP layer is serving requests."""
    return {"status": "ok"}


def space() -> dict[str, Any]:
    """Return the canonical CLAP embedding-space identity."""
    return {
        "family": clap.EMBEDDING_SPACE_FAMILY,
        "checkpointHash": clap.EMBEDDING_CHECKPOINT_HASH,
        "dim": clap.EMBEDDING_DIM,
        "sampleRateHz": clap.CLAP_SAMPLE_RATE,
        "preprocessing": clap.EMBEDDING_PREPROCESSING,
        "revision": clap.MODEL_VERSION,
        "textTower": True,
    }


def embed_text(payload: TextEmbeddingRequest, request: Request) -> dict[str, list[float]]:
    """Generate one normalized text embedding."""
    try:
        embedding = _analyzer(request).get_text_embedding(payload.text)
    except Exception as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error
    if embedding is None:
        raise HTTPException(status_code=503, detail="Model unavailable")
    return {"vector": _model_vector(embedding)}


def embed_audio(payload: AudioEmbeddingRequest, request: Request) -> dict[str, list[float]]:
    """Resolve a library track and generate one normalized audio embedding."""
    audio_path = clap.resolve_music_path(payload.track_ref)
    if audio_path is None:
        raise HTTPException(status_code=400, detail="Invalid trackRef")
    if not os.path.isfile(audio_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    try:
        embedding = _analyzer(request).get_audio_embedding(audio_path)
    except Exception as error:
        raise HTTPException(status_code=503, detail="Model unavailable") from error
    if embedding is None:
        if not os.path.isfile(audio_path):
            raise HTTPException(status_code=404, detail="Audio file not found")
        # Accepted conflation: a transient model reload failure still maps to decode failure.
        raise HTTPException(status_code=422, detail="Audio could not be decoded")
    return {"vector": _model_vector(embedding)}


def create_app(analyzer: Analyzer) -> FastAPI:
    """Create the internal provider app bound to one shared analyzer."""
    app = FastAPI(
        title="soundspan CLAP Embedding Provider",
        version=clap.MODEL_VERSION,
        dependencies=[Depends(require_internal_secret)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.analyzer = analyzer
    _register_error_handlers(app)
    app.add_api_route("/health", health, methods=["GET"])
    app.add_api_route("/v1/space", space, methods=["GET"])
    app.add_api_route("/v1/embed/text", embed_text, methods=["POST"])
    app.add_api_route("/v1/embed/audio", embed_audio, methods=["POST"])
    return app


def _watch_for_shutdown(server: uvicorn.Server, stop_event: threading.Event) -> None:
    """Request Uvicorn shutdown when the service supervisor stops."""
    stop_event.wait()
    server.should_exit = True


def run_http_server(analyzer: Analyzer, stop_event: threading.Event) -> None:
    """Run the provider app until the service supervisor stops."""
    config = uvicorn.Config(
        create_app(analyzer),
        host="0.0.0.0",  # noqa: S104 -- internal container service accepts network traffic
        port=clap.CLAP_HTTP_PORT,
    )
    server = uvicorn.Server(config)
    shutdown_watcher = threading.Thread(
        target=_watch_for_shutdown,
        args=(server, stop_event),
        name="ClapHttpShutdownWatcher",
        daemon=True,
    )
    shutdown_watcher.start()
    try:
        server.run()
    finally:
        # Defensive flag only: the watcher waits on stop_event (released by
        # supervision within its poll), not on should_exit.
        server.should_exit = True
