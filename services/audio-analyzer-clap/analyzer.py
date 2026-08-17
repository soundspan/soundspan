#!/usr/bin/env python3
"""
CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity

This service processes audio files and generates 512-dimensional embeddings
using LAION CLAP (Contrastive Language-Audio Pretraining). These embeddings
enable semantic similarity search - finding tracks that "sound similar" based
on learned audio representations.

Features:
- Audio embedding generation from music files
- Text embedding generation for natural language queries
- Redis queue processing for batch embedding generation
- Direct database storage in PostgreSQL with pgvector

Architecture:
- CLAPAnalyzer: Model loading and embedding generation
- Worker: Queue consumer that processes tracks and stores embeddings
- TextEmbedHandler: Real-time text embedding via Redis Streams consumer groups
- Supervised main loop: Detects failed service threads and manages idle unloading
"""

import gc
import json
import os
import signal
import sys
import threading
import time
import traceback
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import librosa
import numpy as np
import requests

_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_POTENTIAL_PROJECT_ROOTS = (
    _CURRENT_DIR,
    os.path.dirname(_CURRENT_DIR),
    os.path.dirname(os.path.dirname(_CURRENT_DIR)),
)
for _root in _POTENTIAL_PROJECT_ROOTS:
    if os.path.isdir(os.path.join(_root, "services", "common")):
        if _root not in sys.path:
            sys.path.insert(0, _root)
        break

from services.common.analyzer_env import (
    configure_thread_env,
    get_blocking_socket_timeout,
    get_int_env,
)
from services.common.database_url import resolve_database_url
from services.common.logging_utils import configure_service_logger

# CPU thread limiting must be set before importing torch
THREADS_PER_WORKER = get_int_env("THREADS_PER_WORKER", 1)
configure_thread_env(THREADS_PER_WORKER)

import torch

torch.set_num_threads(THREADS_PER_WORKER)

# Device detection - use GPU if available
if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
    GPU_NAME = torch.cuda.get_device_name(0)
else:
    DEVICE = torch.device("cpu")
    GPU_NAME = None

import psycopg2
import redis
from pgvector.psycopg2 import register_vector
from psycopg2.extras import RealDictCursor

logger = configure_service_logger("clap-analyzer")

# Configuration from environment
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = resolve_database_url(os.environ)
MUSIC_PATH = os.getenv("MUSIC_PATH", "/music")
SLEEP_INTERVAL = get_int_env("SLEEP_INTERVAL", 5)
REDIS_SOCKET_TIMEOUT = get_blocking_socket_timeout(
    "CLAP_REDIS_SOCKET_TIMEOUT",
    10,
    blocking_timeout=SLEEP_INTERVAL,
)
NUM_WORKERS = get_int_env("NUM_WORKERS", 2)
BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:3006")
MODEL_IDLE_TIMEOUT = get_int_env("MODEL_IDLE_TIMEOUT", 300)
CLAP_HTTP_PORT = get_int_env("CLAP_HTTP_PORT", 8091)
IDLE_POLL_SECONDS = 5
ACTIVE_SPACE_CACHE_TTL_SECONDS = 300

# Queue and channel names
ANALYSIS_QUEUE = "audio:clap:queue"
TEXT_EMBED_REQUEST_STREAM = "audio:text:embed:requests"
TEXT_EMBED_GROUP = os.getenv("TEXT_EMBED_GROUP", "clap:text:embed:group")
TEXT_EMBED_RESPONSE_PREFIX = "audio:text:embed:response:"
TEXT_EMBED_RESPONSE_TTL_SECONDS = get_int_env("TEXT_EMBED_RESPONSE_TTL_SECONDS", 120)
TEXT_EMBED_CLAIM_IDLE_MS = get_int_env("TEXT_EMBED_CLAIM_IDLE_MS", 60000)
TEXT_EMBED_CLAIM_BATCH = get_int_env("TEXT_EMBED_CLAIM_BATCH", 10)
CONTROL_CHANNEL = "audio:clap:control"

# Model version identifier
MODEL_VERSION = "laion-clap-music-v1"
EMBEDDING_SPACE_FAMILY = "clap-music-audioset"
EMBEDDING_CHECKPOINT_HASH = "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
EMBEDDING_DIM = 512
EMBEDDING_PREPROCESSING = {
    "sampleRateHz": 48000,
    "mono": True,
    "maxDurationSeconds": 60,
    "window": "middle",
    "loader": "librosa",
}

# Audio processing: extract middle segment for consistent, efficient embedding
# 60 seconds captures the "vibe" without intros/outros and reduces memory usage
MAX_AUDIO_DURATION = 60  # seconds
CLAP_SAMPLE_RATE = 48000  # 48kHz for CLAP model


class ActiveEmbeddingSpaceNotFoundError(RuntimeError):
    """Raised when a vibe embedding cannot be stamped with an active space."""


def resolve_active_space_id(db: "DatabaseConnection") -> str:
    """Resolve the oldest active embedding-space ID from PostgreSQL."""
    cursor = db.get_cursor()
    try:
        cursor.execute(
            """
            SELECT id, created_at FROM embedding_spaces
            WHERE status = 'active'
            ORDER BY created_at ASC
        """
        )
        rows = cursor.fetchall()
    finally:
        cursor.close()

    if not rows:
        raise ActiveEmbeddingSpaceNotFoundError(
            "No active embedding space is registered; embedding was not stored"
        )

    active_ids = [str(row["id"]) for row in rows]
    if len(active_ids) > 1:
        logger.warning(
            f"Multiple active embedding spaces found; using oldest {active_ids[0]}. "
            f"Active ids: {', '.join(active_ids)}"
        )
    return active_ids[0]


def _is_embedding_space_insert_error(error: Exception) -> bool:
    """Return whether an insert failure can reflect stale space/schema state."""
    message = str(error).lower()
    return "foreign key" in message or "space_id" in message or "embedding_spaces" in message


def _resolve_music_path(file_path: str) -> str | None:
    """Resolve a relative queue path beneath the configured music library."""
    if not isinstance(file_path, str) or "\x00" in file_path:
        return None

    normalized_path = file_path.replace("\\", "/")
    if os.path.isabs(normalized_path):
        return None
    if any(segment in {".", ".."} for segment in normalized_path.split("/")):
        return None

    try:
        music_root = os.path.realpath(MUSIC_PATH)
        resolved_path = os.path.realpath(os.path.join(music_root, normalized_path))
        if os.path.commonpath((music_root, resolved_path)) != music_root:
            return None
    except (OSError, ValueError):
        return None
    return resolved_path


resolve_music_path = _resolve_music_path


class CLAPAnalyzer:
    """
    LAION CLAP model wrapper for generating audio and text embeddings.

    Uses HTSAT-base architecture with the music_audioset checkpoint,
    optimized for music similarity tasks. Supports idle model unloading
    to free memory when no work is pending. Inference and unloading serialize
    on one re-entrant lock; embedding calls reload under that lock if an idle
    unload wins the race after the optimistic preload.
    """

    def __init__(self):
        """Initialize analyzer state and lazy model-loading controls."""
        self.model = None
        self._lock = threading.RLock()
        self.last_work_time: float = time.time()
        self._model_loaded = False

    def load_model(self):
        """Load the CLAP model (thread-safe, idempotent)"""
        with self._lock:
            if self.model is not None:
                return

            logger.info("Loading LAION CLAP model...")
            try:
                import laion_clap

                self.model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base")
                self.model.load_ckpt("/app/models/music_audioset_epoch_15_esc_90.14.pt")

                # Move to detected device (GPU if available, else CPU)
                self.model = self.model.to(DEVICE).eval()
                self._model_loaded = True
                self.last_work_time = time.time()

                if GPU_NAME:
                    logger.info(f"CLAP model loaded successfully on GPU: {GPU_NAME}")
                else:
                    logger.info("CLAP model loaded successfully on CPU")
            except Exception as e:
                logger.error(f"Failed to load CLAP model: {e}")
                traceback.print_exc()
                raise

    def unload_model(self):
        """Unload the CLAP model to free memory"""
        with self._lock:
            if self.model is None:
                return
            logger.info("Unloading CLAP model to free memory...")
            self.model = None
            self._model_loaded = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()
            # Force glibc to return freed pages to OS (Python/PyTorch hold RSS otherwise)
            try:
                import ctypes

                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except Exception:  # noqa: S110 -- releasing libc pages is optional best-effort cleanup
                pass
            logger.info("CLAP model unloaded")

    def ensure_model(self):
        """Ensure model is loaded, reloading if it was unloaded for idle"""
        if self.model is None:
            logger.info("Reloading CLAP model (new work arrived)...")
            self.load_model()

    def _load_audio_chunk(
        self, audio_path: str, duration_hint: float | None = None
    ) -> tuple[np.ndarray | None, int]:
        """
        Load audio from the middle of a file for efficient embedding.

        Always extracts MAX_AUDIO_DURATION seconds from the middle of the track.
        This captures the "vibe" while avoiding intros/outros and reducing memory.

        Args:
            audio_path: Path to the audio file
            duration_hint: Pre-computed duration in seconds (avoids file read)

        Returns:
            Tuple of (audio_array, sample_rate) or (None, 0) on error
        """
        try:
            # Use provided duration or fall back to computing it
            duration = duration_hint if duration_hint else librosa.get_duration(path=audio_path)

            if duration > MAX_AUDIO_DURATION:
                # Extract middle segment
                offset = (duration - MAX_AUDIO_DURATION) / 2
                audio, sr = librosa.load(
                    audio_path,
                    sr=CLAP_SAMPLE_RATE,
                    offset=offset,
                    duration=MAX_AUDIO_DURATION,
                    mono=True,
                )
            else:
                # Short track, load entirely
                audio, sr = librosa.load(audio_path, sr=CLAP_SAMPLE_RATE, mono=True)

            return audio, sr

        except Exception as e:
            logger.error(f"Failed to load audio from {audio_path}: {e}")
            traceback.print_exc()
            return None, 0

    def get_audio_embedding(
        self, audio_path: str, duration: float | None = None
    ) -> np.ndarray | None:
        """
        Generate a 512-dimensional embedding from an audio file.

        Extracts the middle 60 seconds of the track for embedding, which
        captures the vibe while avoiding intros/outros and reducing memory.

        Args:
            audio_path: Path to the audio file
            duration: Pre-computed duration in seconds (avoids file read)

        Returns:
            numpy array of shape (512,) or None on error
        """
        self.ensure_model()
        self.last_work_time = time.time()

        if not os.path.exists(audio_path):
            logger.error(f"Audio file not found: {audio_path}")
            return None

        try:
            # Load audio (with chunking), use provided duration to skip file probe
            audio, sr = self._load_audio_chunk(audio_path, duration)

            if audio is None:
                return None

            logger.debug(f"Loaded audio: {len(audio) / sr:.1f}s at {sr}Hz")

            with self._lock:
                if self.model is None:
                    self.load_model()
                # Use get_audio_embedding_from_data for pre-loaded audio
                # This gives us control over memory usage
                embeddings = self.model.get_audio_embedding_from_data([audio], use_tensor=False)

                # Result is shape (1, 512) for HTSAT-base model, normalized
                embedding = embeddings[0]

                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected embedding dimension: {embedding.shape}")

                return embedding.astype(np.float32)

        except Exception as e:
            logger.error(f"Failed to generate audio embedding for {audio_path}: {e}")
            traceback.print_exc()
            return None

    def get_text_embedding(self, text: str) -> np.ndarray | None:
        """
        Generate a 512-dimensional embedding from a text query.

        Args:
            text: Natural language description (e.g., "upbeat electronic dance music")

        Returns:
            numpy array of shape (512,) or None on error
        """
        self.ensure_model()
        self.last_work_time = time.time()

        if not text or not text.strip():
            logger.error("Empty text provided for embedding")
            return None

        try:
            with self._lock:
                if self.model is None:
                    self.load_model()
                # CLAP expects a list of text prompts
                embeddings = self.model.get_text_embedding([text], use_tensor=False)

                embedding = embeddings[0]

                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected text embedding dimension: {embedding.shape}")

                return embedding.astype(np.float32)

        except Exception as e:
            logger.error(f"Failed to generate text embedding: {e}")
            traceback.print_exc()
            return None


class DatabaseConnection:
    """PostgreSQL connection manager with pgvector support and auto-reconnect"""

    def __init__(self, url: str, clock: Callable[[], float] | None = None):
        """Store connection URL and initialize disconnected state."""
        self.url = url
        self.conn = None
        self._clock = clock or time.monotonic
        self._active_space_id: str | None = None
        self._active_space_resolved_at: float | None = None

    def connect(self):
        """Establish database connection with pgvector extension"""
        if not self.url:
            raise ValueError("DATABASE_URL not set")

        self.conn = psycopg2.connect(self.url, options="-c client_encoding=UTF8")
        self.conn.set_client_encoding("UTF8")
        # Read/poll queries must not hold relation locks while idle and block migrations (#224).
        self.conn.autocommit = True

        # Register pgvector type
        register_vector(self.conn)

        logger.info("Connected to PostgreSQL with pgvector support")

    def is_connected(self) -> bool:
        """Check if the database connection is alive"""
        if not self.conn:
            return False
        try:
            cursor = self.conn.cursor()
            cursor.execute("SELECT 1")
            cursor.close()
            return True
        except Exception:
            return False

    def reconnect(self):
        """Close existing connection and establish a new one"""
        logger.info("Reconnecting to database...")
        self.close()
        self.connect()

    def get_cursor(self) -> RealDictCursor:
        """Reconnect if needed and return a RealDictCursor-factory cursor."""
        if not self.is_connected():
            self.reconnect()
        return self.conn.cursor(cursor_factory=RealDictCursor)

    def get_active_space_id(self) -> str:
        """Return the cached active embedding-space ID within its TTL."""
        now = self._clock()
        if self._active_space_id is not None and self._active_space_resolved_at is not None:
            cache_age = now - self._active_space_resolved_at
            if cache_age <= ACTIVE_SPACE_CACHE_TTL_SECONDS:
                return self._active_space_id

        space_id = resolve_active_space_id(self)
        self._active_space_id = space_id
        self._active_space_resolved_at = now
        return space_id

    def invalidate_active_space_id(self) -> None:
        """Clear the active embedding-space cache before a forced refresh."""
        self._active_space_id = None
        self._active_space_resolved_at = None

    def commit(self):
        if self.conn:
            self.conn.commit()

    def rollback(self):
        if self.conn:
            self.conn.rollback()

    def close(self):
        if self.conn:
            try:  # noqa: SIM105 -- connection cleanup must remain best effort
                self.conn.close()
            except Exception:  # noqa: S110 -- connection cleanup must remain best effort
                pass
            self.conn = None


class Worker:
    """
    Queue worker that processes audio files and stores embeddings.

    Polls the Redis queue for jobs, generates CLAP embeddings,
    and stores results in PostgreSQL.
    """

    def __init__(self, worker_id: int, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        """Initialize worker identity, shared analyzer, and shutdown signal."""
        self.worker_id = worker_id
        self.analyzer = analyzer
        self.stop_event = stop_event
        self.redis_client = None
        self.db = None

    def start(self):
        """Start the worker loop"""
        logger.info(f"Worker {self.worker_id} starting...")

        try:
            self.redis_client = redis.from_url(
                REDIS_URL,
                socket_timeout=REDIS_SOCKET_TIMEOUT,
            )
            self.db = DatabaseConnection(DATABASE_URL)
            self.db.connect()

            while not self.stop_event.is_set():
                # Publish heartbeat for feature detection
                try:  # noqa: SIM105 -- heartbeat failure must not stop analysis
                    self.redis_client.set("clap:worker:heartbeat", str(int(time.time() * 1000)))
                except Exception:  # noqa: S110 -- heartbeat failure must not stop analysis
                    pass  # Heartbeat is informational, don't crash on Redis failure

                try:
                    self._process_job()
                except psycopg2.Error as e:
                    logger.error(f"Worker {self.worker_id} database error: {e}")
                    traceback.print_exc()
                    self.db.reconnect()
                    time.sleep(SLEEP_INTERVAL)
                except Exception as e:
                    logger.error(f"Worker {self.worker_id} error: {e}")
                    traceback.print_exc()
                    time.sleep(SLEEP_INTERVAL)

        finally:
            if self.db:
                self.db.close()
            logger.info(f"Worker {self.worker_id} stopped")

    def _process_job(self):
        """Process a single job from the queue"""
        # Try to get a job from the queue (blocking with timeout)
        job_data = self.redis_client.blpop(ANALYSIS_QUEUE, timeout=SLEEP_INTERVAL)

        if not job_data:
            return

        _, raw_job = job_data
        job = json.loads(raw_job)

        track_id = job.get("trackId")
        file_path = job.get("filePath", "")
        duration = job.get("duration")  # Pre-computed duration in seconds

        if not track_id:
            logger.warning(f"Invalid job (no trackId): {job}")
            return

        logger.info(f"Worker {self.worker_id} processing track: {track_id}")

        full_path = _resolve_music_path(file_path)
        if full_path is None:
            logger.warning("Rejected queued CLAP path outside the configured music library")
            return

        if not self._claim_track(track_id):
            self._release_queue_reservation(track_id)
            logger.info(f"Worker {self.worker_id} skipped stale queue job: {track_id}")
            return
        self._release_queue_reservation(track_id)

        # Generate embedding (pass duration to avoid file probe)
        embedding = self.analyzer.get_audio_embedding(full_path, duration)

        if embedding is None:
            self._mark_failed(track_id, "Failed to generate embedding")
            return

        # Store embedding in database
        try:
            success = self._store_embedding(track_id, embedding)
        except ActiveEmbeddingSpaceNotFoundError as error:
            self._mark_failed(track_id, str(error))
            return

        if success:
            self._update_track_status(track_id, "completed")
            logger.info(f"Worker {self.worker_id} completed track: {track_id}")
        else:
            self._mark_failed(track_id, "Failed to store embedding")

    def _claim_track(self, track_id: str) -> bool:
        """Atomically claim one pending track for this worker."""
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                """
                UPDATE "Track"
                SET
                    "vibeAnalysisStatus" = 'processing',
                    "vibeAnalysisStartedAt" = NOW(),
                    "vibeAnalysisStatusUpdatedAt" = NOW()
                WHERE id = %s
                AND ("vibeAnalysisStatus" IS NULL OR "vibeAnalysisStatus" = 'pending')
                RETURNING id
            """,
                (track_id,),
            )
            claimed = cursor.fetchone() is not None
            self.db.commit()
            return claimed
        except Exception as error:
            logger.error(f"Failed to claim track for vibe analysis: {error}")
            self.db.rollback()
            return False
        finally:
            cursor.close()

    def _release_queue_reservation(self, track_id: str) -> None:
        """Release the producer reservation after the database claim."""
        try:
            self.redis_client.delete(f"{ANALYSIS_QUEUE}:reserved:{track_id}")
        except Exception as error:
            logger.warning(f"Failed to release vibe queue reservation: {error}")

    def _update_track_status(self, track_id: str, status: str):
        """Update the track's vibe analysis status (CLAP embeddings)"""
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                """
                UPDATE "Track"
                SET
                    "vibeAnalysisStatus" = %s,
                    "vibeAnalysisStatusUpdatedAt" = %s
                WHERE id = %s
            """,
                (status, datetime.now(UTC), track_id),
            )
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to update track vibe status: {e}")
            self.db.rollback()
        finally:
            cursor.close()

    def _mark_failed(self, track_id: str, error: str):
        """Mark track as failed and record in enrichment failures"""
        cursor = self.db.get_cursor()
        try:
            # Get track name for better failure visibility
            cursor.execute('SELECT title FROM "Track" WHERE id = %s', (track_id,))
            row = cursor.fetchone()
            track_name = row["title"] if row else None

            cursor.execute(
                """
                UPDATE "Track"
                SET
                    "vibeAnalysisStatus" = 'failed',
                    "vibeAnalysisError" = %s,
                    "vibeAnalysisRetryCount" = COALESCE("vibeAnalysisRetryCount", 0) + 1,
                    "vibeAnalysisStatusUpdatedAt" = %s
                WHERE id = %s
            """,
                (error[:500], datetime.now(UTC), track_id),
            )
            self.db.commit()
            logger.error(f"Track {track_id} failed: {error}")

            # Report failure to backend enrichment failure service
            try:
                headers = {
                    "Content-Type": "application/json",
                    "X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", ""),
                }
                requests.post(
                    f"{BACKEND_URL}/api/analysis/vibe/failure",
                    json={
                        "trackId": track_id,
                        "trackName": track_name,
                        "errorMessage": error[:500],
                        "errorCode": "VIBE_EMBEDDING_FAILED",
                    },
                    headers=headers,
                    timeout=5,
                )
            except Exception as report_err:
                logger.warning(f"Failed to report failure to backend: {report_err}")

        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
            self.db.rollback()
        finally:
            cursor.close()

    def _store_embedding(self, track_id: str, embedding: np.ndarray) -> bool:
        """Store the embedding in the track_embeddings table"""
        try:
            space_id = self.db.get_active_space_id()
        except ActiveEmbeddingSpaceNotFoundError:
            raise
        except Exception as error:
            self._log_embedding_store_failure(track_id, error)
            return False

        embedding_list = embedding.tolist()
        try:
            self._insert_embedding(track_id, embedding_list, space_id)
            return True
        except Exception as error:
            self.db.rollback()
            if not _is_embedding_space_insert_error(error):
                self._log_embedding_store_failure(track_id, error)
                return False

        logger.warning(
            f"Embedding insert for {track_id} failed on embedding-space "
            "schema state; refreshing the active embedding space once"
        )
        return self._retry_embedding_store(track_id, embedding_list)

    def _retry_embedding_store(self, track_id: str, embedding_list: list[float]) -> bool:
        """Retry one embedding insert after forcing an active-space refresh."""
        self.db.invalidate_active_space_id()
        try:
            space_id = self.db.get_active_space_id()
        except ActiveEmbeddingSpaceNotFoundError:
            raise
        except Exception as error:
            self._log_embedding_store_failure(track_id, error)
            return False

        try:
            self._insert_embedding(track_id, embedding_list, space_id)
            return True
        except Exception as error:
            self.db.rollback()
            self._log_embedding_store_failure(track_id, error)
            return False

    def _insert_embedding(
        self,
        track_id: str,
        embedding_list: list[float],
        space_id: str,
    ) -> None:
        """Execute one space-stamped embedding upsert."""
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                """
                INSERT INTO track_embeddings (track_id, embedding, space_id, analyzed_at)
                VALUES (%s, %s::vector, %s, %s)
                ON CONFLICT (track_id)
                DO UPDATE SET
                    embedding = EXCLUDED.embedding,
                    space_id = EXCLUDED.space_id,
                    analyzed_at = EXCLUDED.analyzed_at
            """,
                (track_id, embedding_list, space_id, datetime.now(UTC)),
            )
            self.db.commit()
        finally:
            cursor.close()

    @staticmethod
    def _log_embedding_store_failure(track_id: str, error: Exception) -> None:
        """Log a terminal embedding-store failure with its active traceback."""
        logger.error(f"Failed to store embedding for {track_id}: {error}")
        traceback.print_exc()


class TextEmbedHandler:
    """
    Real-time text embedding handler via Redis Streams consumer groups.

    Consumes request messages from a stream, generates embeddings, writes to a
    request-scoped Redis list response key, then acknowledges the stream entry.
    """

    def __init__(self, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        """Initialize stream-consumer identity and handler dependencies."""
        self.analyzer = analyzer
        self.stop_event = stop_event
        self.redis_client = None
        consumer_prefix = os.getenv("TEXT_EMBED_CONSUMER_PREFIX", os.getenv("HOSTNAME", "clap"))
        self.consumer_name = f"{consumer_prefix}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._last_claim_check = 0.0

    def start(self):
        """Start the text embed handler"""
        logger.info("TextEmbedHandler starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL, decode_responses=True)
            self._ensure_consumer_group()

            logger.info(
                f"Text embed consumer ready: stream={TEXT_EMBED_REQUEST_STREAM}, "
                f"group={TEXT_EMBED_GROUP}, consumer={self.consumer_name}"
            )

            while not self.stop_event.is_set():
                try:
                    now = time.time()
                    if now - self._last_claim_check >= 5:
                        self._claim_stale_messages()
                        self._last_claim_check = now

                    messages = self.redis_client.xreadgroup(
                        groupname=TEXT_EMBED_GROUP,
                        consumername=self.consumer_name,
                        streams={TEXT_EMBED_REQUEST_STREAM: ">"},
                        count=1,
                        block=1000,
                    )

                    if not messages:
                        continue

                    for _stream_name, entries in messages:
                        for message_id, fields in entries:
                            self._handle_message(message_id, fields)
                except redis.exceptions.ResponseError as e:
                    if self._is_no_group_error(e):
                        logger.warning(
                            "Text embed stream/group missing (likely Redis reset); recreating consumer group"
                        )
                        self._ensure_consumer_group()
                        time.sleep(0.5)
                        continue
                    raise

                except Exception as e:
                    logger.error(f"TextEmbedHandler error: {e}")
                    traceback.print_exc()
                    time.sleep(1)

        finally:
            logger.info("TextEmbedHandler stopped")

    def _ensure_consumer_group(self):
        """Create the text embed stream consumer group if it doesn't exist."""
        try:
            self.redis_client.xgroup_create(
                name=TEXT_EMBED_REQUEST_STREAM,
                groupname=TEXT_EMBED_GROUP,
                id="0",
                mkstream=True,
            )
            logger.info(
                f"Created text embed consumer group {TEXT_EMBED_GROUP} on {TEXT_EMBED_REQUEST_STREAM}"
            )
        except redis.exceptions.ResponseError as e:
            if "BUSYGROUP" in str(e):
                logger.info(f"Using existing text embed consumer group {TEXT_EMBED_GROUP}")
                return
            raise

    @staticmethod
    def _is_no_group_error(error: Exception) -> bool:
        """Detect Redis stream/group missing errors after cache resets."""
        message = str(error).upper()
        return "NOGROUP" in message

    def _claim_stale_messages(self):
        """Claim stale pending messages left behind by crashed consumers."""
        try:
            result = self.redis_client.xautoclaim(
                name=TEXT_EMBED_REQUEST_STREAM,
                groupname=TEXT_EMBED_GROUP,
                consumername=self.consumer_name,
                min_idle_time=TEXT_EMBED_CLAIM_IDLE_MS,
                start_id="0-0",
                count=TEXT_EMBED_CLAIM_BATCH,
            )
        except redis.exceptions.ResponseError as e:
            # Older Redis versions may not support XAUTOCLAIM.
            if "unknown command" in str(e).lower():
                return
            if self._is_no_group_error(e):
                self._ensure_consumer_group()
                return
            raise

        if not result or len(result) < 2:
            return

        claimed_entries = result[1] or []
        if not claimed_entries:
            return

        logger.info(f"Claimed {len(claimed_entries)} stale text embed request(s)")
        for message_id, fields in claimed_entries:
            self._handle_message(message_id, fields)

    def _publish_response_and_ack(self, message_id: str, response_key: str, payload: dict):
        """Publish response payload and acknowledge the stream message atomically."""
        pipeline = self.redis_client.pipeline()
        pipeline.lpush(response_key, json.dumps(payload))
        pipeline.expire(response_key, TEXT_EMBED_RESPONSE_TTL_SECONDS)
        pipeline.xack(TEXT_EMBED_REQUEST_STREAM, TEXT_EMBED_GROUP, message_id)
        try:
            pipeline.execute()
        except redis.exceptions.ResponseError as e:
            if not self._is_no_group_error(e):
                raise
            # Redis was reset between read and ack; preserve client response and
            # recreate stream/group so future requests keep flowing.
            logger.warning(
                "Text embed ack failed due to missing group; publishing response without ack and recreating group"
            )
            self._ensure_consumer_group()
            fallback = self.redis_client.pipeline()
            fallback.lpush(response_key, json.dumps(payload))
            fallback.expire(response_key, TEXT_EMBED_RESPONSE_TTL_SECONDS)
            fallback.execute()

    def _handle_message(self, message_id: str, fields: dict[str, str]):
        """Handle a single text embedding stream message."""
        request_id = None
        response_key = None

        try:
            request_id = fields.get("requestId")
            text = fields.get("text", "")
            response_key = fields.get("responseKey")

            if not request_id:
                logger.warning(f"Text embed request missing requestId (message: {message_id})")
                self.redis_client.xack(TEXT_EMBED_REQUEST_STREAM, TEXT_EMBED_GROUP, message_id)
                return

            if not response_key:
                response_key = f"{TEXT_EMBED_RESPONSE_PREFIX}{request_id}"

            logger.info(f"Processing text embed request: {request_id}")

            # Generate embedding
            embedding = self.analyzer.get_text_embedding(text)

            # Prepare response
            response = {
                "requestId": request_id,
                "success": embedding is not None,
                "embedding": embedding.tolist() if embedding is not None else None,
                "modelVersion": MODEL_VERSION,
            }

            if embedding is None:
                response["error"] = "Failed to generate text embedding"

            self._publish_response_and_ack(message_id, response_key, response)

            logger.info(f"Text embed response sent: {request_id}")

        except Exception as e:
            logger.error(f"Failed to handle text embed request: {e}")
            traceback.print_exc()
            if request_id and response_key:
                try:
                    self._publish_response_and_ack(
                        message_id,
                        response_key,
                        {
                            "requestId": request_id,
                            "success": False,
                            "embedding": None,
                            "modelVersion": MODEL_VERSION,
                            "error": str(e),
                        },
                    )
                except Exception as ack_error:
                    logger.error(f"Failed to publish text embed error response: {ack_error}")


class ControlHandler:
    """
    Handles control messages from Redis pub/sub.

    Listens for worker count changes and other control commands.
    Note: Worker count changes require a container restart to take effect.
    """

    def __init__(self, stop_event: threading.Event):
        """Initialize control-channel listener state."""
        self.stop_event = stop_event
        self.redis_client = None
        self.pubsub = None

    def start(self):
        """Start listening for control messages"""
        logger.info("ControlHandler starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.pubsub = self.redis_client.pubsub()
            self.pubsub.subscribe(CONTROL_CHANNEL)
            logger.info(f"Subscribed to control channel: {CONTROL_CHANNEL}")

            while not self.stop_event.is_set():
                try:
                    message = self.pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)

                    if message and message["type"] == "message":
                        self._handle_message(message)

                except Exception as e:
                    logger.error(f"ControlHandler error: {e}")
                    traceback.print_exc()
                    time.sleep(1)

        finally:
            if self.pubsub:
                self.pubsub.close()
            logger.info("ControlHandler stopped")

    def _handle_message(self, message: dict[str, Any]):
        """Handle a control message"""
        try:
            data = message["data"]
            if isinstance(data, bytes):
                data = data.decode("utf-8")

            control = json.loads(data)
            command = control.get("command")

            if command == "set_workers":
                new_count = control.get("count", NUM_WORKERS)
                logger.info(f"Received worker count change request: {NUM_WORKERS} -> {new_count}")
                logger.info(
                    "Note: Restart the CLAP analyzer container to apply the new worker count"
                )
            else:
                logger.warning(f"Unknown control command: {command}")

        except Exception as e:
            logger.error(f"Failed to handle control message: {e}")
            traceback.print_exc()


def find_dead_threads(threads: list[threading.Thread]) -> list[str]:
    """Return the names of supervised threads that are no longer alive."""
    return [thread.name for thread in threads if not thread.is_alive()]


def _check_for_completed_work(analyzer, idle_db, queue_client):
    """Unload the model when the database and analysis queue have no work."""
    try:
        cursor = idle_db.get_cursor()
        try:
            cursor.execute("""
                SELECT COUNT(*) as cnt FROM "Track" t
                LEFT JOIN track_embeddings te ON t.id = te.track_id
                WHERE te.track_id IS NULL AND t."filePath" IS NOT NULL
            """)
            remaining = cursor.fetchone()["cnt"]
        finally:
            cursor.close()

        queue_len = queue_client.llen(ANALYSIS_QUEUE)
        if remaining == 0 and queue_len == 0:
            analyzer.unload_model()
            logger.info(
                "All tracks have embeddings, model unloaded (will reload when work arrives)"
            )
    except Exception as e:
        logger.debug(f"Idle check failed: {e}")
        idle_db.reconnect()


def run_idle_monitor(analyzer, stop_event, idle_db, queue_client, threads):
    """Supervise service threads and unload the model during idle periods."""
    while not stop_event.is_set():
        dead = find_dead_threads(threads)
        if dead:
            logger.critical(f"Service thread(s) stopped unexpectedly: {', '.join(dead)}")
            stop_event.set()
            return False

        if analyzer._model_loaded:
            idle_seconds = time.time() - analyzer.last_work_time
            if idle_seconds >= MODEL_IDLE_TIMEOUT > 0:
                analyzer.unload_model()
                logger.info(
                    f"Model idle for {idle_seconds:.0f}s, unloaded to free memory "
                    "(will reload when work arrives)"
                )
            elif idle_seconds >= SLEEP_INTERVAL * 2:
                _check_for_completed_work(analyzer, idle_db, queue_client)

        stop_event.wait(IDLE_POLL_SECONDS)
    return True


def _start_threads(
    analyzer: CLAPAnalyzer,
    stop_event: threading.Event,
) -> list[threading.Thread]:
    """Construct and start the worker, text-embedding, and control threads."""
    threads = []
    for i in range(NUM_WORKERS):
        worker = Worker(i, analyzer, stop_event)
        thread = threading.Thread(target=worker.start, name=f"Worker-{i}")
        thread.daemon = True
        thread.start()
        threads.append(thread)
        logger.info(f"Started worker thread {i}")

    text_handler = TextEmbedHandler(analyzer, stop_event)
    text_thread = threading.Thread(target=text_handler.start, name="TextEmbedHandler")
    text_thread.daemon = True
    text_thread.start()
    threads.append(text_thread)
    logger.info("Started text embed handler thread")

    control_handler = ControlHandler(stop_event)
    control_thread = threading.Thread(target=control_handler.start, name="ControlHandler")
    control_thread.daemon = True
    control_thread.start()
    threads.append(control_thread)
    logger.info("Started control handler thread")

    from http_server import run_http_server

    http_thread = threading.Thread(
        target=run_http_server,
        args=(analyzer, stop_event),
        name="ClapHttpServer",
        daemon=True,
    )
    http_thread.start()
    threads.append(http_thread)
    logger.info(f"Started CLAP HTTP provider thread on port {CLAP_HTTP_PORT}")
    return threads


def _log_startup_configuration():
    """Log the effective CLAP analyzer runtime configuration."""
    logger.info("=" * 60)
    logger.info("CLAP Audio Analyzer Service")
    logger.info("=" * 60)
    logger.info(f"  Model version: {MODEL_VERSION}")
    logger.info(f"  Music path: {MUSIC_PATH}")
    logger.info(f"  Num workers: {NUM_WORKERS}")
    logger.info(f"  Threads per worker: {THREADS_PER_WORKER}")
    logger.info(f"  Sleep interval: {SLEEP_INTERVAL}s")
    logger.info(f"  Redis socket timeout: {REDIS_SOCKET_TIMEOUT}s")
    logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
    logger.info(f"  HTTP port: {CLAP_HTTP_PORT}")
    logger.info("=" * 60)


def main():
    """Start and supervise the CLAP analyzer service until shutdown."""
    # Keep the script entrypoint and the HTTP module on one analyzer module
    # instance when this file is launched as ``python analyzer.py``.
    sys.modules["analyzer"] = sys.modules[__name__]
    _log_startup_configuration()
    analyzer = CLAPAnalyzer()
    analyzer.load_model()
    stop_event = threading.Event()

    def signal_handler(signum, frame):
        """Request graceful shutdown after an operating-system signal."""
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        stop_event.set()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    threads = _start_threads(analyzer, stop_event)
    idle_db = DatabaseConnection(DATABASE_URL)
    queue_client = None
    healthy = False
    try:
        idle_db.connect()
        queue_client = redis.from_url(
            REDIS_URL,
            socket_timeout=REDIS_SOCKET_TIMEOUT,
        )
        healthy = run_idle_monitor(analyzer, stop_event, idle_db, queue_client, threads)
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        stop_event.set()
        healthy = True
    except Exception as e:
        logger.critical(f"CLAP Analyzer service failed: {e}")
        stop_event.set()
    finally:
        try:
            idle_db.close()
        except Exception as e:
            logger.warning(f"Failed to close idle database: {e}")
        if queue_client is not None:
            try:
                queue_client.close()
            except Exception as e:
                logger.warning(f"Failed to close idle Redis client: {e}")

    logger.info("Waiting for threads to finish...")
    for thread in threads:
        thread.join(timeout=10)

    if not healthy:
        logger.critical("CLAP Analyzer service unhealthy; exiting for container restart")
        sys.exit(1)
    logger.info("CLAP Analyzer service stopped cleanly")


if __name__ == "__main__":
    main()
