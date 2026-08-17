"""Red-phase contracts for CLAP analyzer runtime reliability."""

import importlib.util
import json
import logging
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest

ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


class RealDictCursor:
    """Placeholder cursor factory used by the analyzer import."""


class ResponseError(Exception):
    """Placeholder Redis response error used by handler exception clauses."""


class FakeRedisClient:
    """Placeholder client returned by the recording Redis constructor."""


class FakeClock:
    """Controllable monotonic clock for cache-expiry tests."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class RecordingSpaceCursor:
    """Record embedding-space reads and embedding writes."""

    def __init__(self, connection: "RecordingSpaceConnection") -> None:
        self.connection = connection
        self.rows: list[dict[str, Any]] = []
        self.closed = False

    def execute(self, query: str, params: Any = None) -> None:
        self.connection.executions.append((query, params))
        if "FROM embedding_spaces" in query:
            self.connection.resolve_calls += 1
            self.rows = list(self.connection.active_rows)
            return
        if "INSERT INTO track_embeddings" not in query:
            return
        self.connection.insert_attempts.append((query, params))
        if self.connection.insert_errors:
            raise self.connection.insert_errors.pop(0)

    def fetchall(self) -> list[dict[str, Any]]:
        return self.rows

    def close(self) -> None:
        self.closed = True


class RecordingSpaceConnection:
    """Minimal connection that drives resolver and storage behavior."""

    def __init__(self, active_rows: list[dict[str, Any]]) -> None:
        self.active_rows = active_rows
        self.executions: list[tuple[str, Any]] = []
        self.insert_attempts: list[tuple[str, Any]] = []
        self.insert_errors: list[Exception] = []
        self.resolve_calls = 0
        self.commit_calls = 0
        self.rollback_calls = 0

    def cursor(self, cursor_factory: Any = None) -> RecordingSpaceCursor:
        assert cursor_factory is RealDictCursor
        return RecordingSpaceCursor(self)

    def commit(self) -> None:
        self.commit_calls += 1

    def rollback(self) -> None:
        self.rollback_calls += 1


def _database_with_space_rows(
    module: ModuleType,
    active_rows: list[dict[str, Any]],
    clock: FakeClock | None = None,
) -> tuple[Any, RecordingSpaceConnection]:
    """Build the production wrapper around a deterministic fake connection."""
    database = module.DatabaseConnection("postgresql://test", clock=clock or FakeClock())
    connection = RecordingSpaceConnection(active_rows)
    database.conn = connection
    database.is_connected = lambda: True
    return database, connection


def _stub_torch() -> ModuleType:
    """Build the minimal CPU-only torch module used during import."""
    torch_stub = ModuleType("torch")

    class Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    torch_stub.set_num_threads = lambda _count: None  # type: ignore[attr-defined]
    torch_stub.cuda = Cuda()  # type: ignore[attr-defined]
    torch_stub.device = lambda name: name  # type: ignore[attr-defined]
    return torch_stub


def _stub_redis(
    from_url_calls: list[tuple[Any, ...]],
) -> tuple[ModuleType, ModuleType]:
    """Build Redis modules whose constructor calls remain inspectable."""
    redis_stub = ModuleType("redis")
    exceptions_stub = ModuleType("redis.exceptions")

    def from_url(*args: Any, **kwargs: Any) -> FakeRedisClient:
        from_url_calls.append((*args, kwargs))
        return FakeRedisClient()

    redis_stub.from_url = from_url  # type: ignore[attr-defined]
    redis_stub.exceptions = exceptions_stub  # type: ignore[attr-defined]
    exceptions_stub.ResponseError = ResponseError  # type: ignore[attr-defined]
    return redis_stub, exceptions_stub


def _stub_psycopg2(
    connect_calls: list[tuple[Any, ...]],
) -> tuple[ModuleType, ModuleType]:
    """Build psycopg2 modules with a recording, fail-closed connector."""
    psycopg2_stub = ModuleType("psycopg2")
    extras_stub = ModuleType("psycopg2.extras")

    def connect(*args: Any, **kwargs: Any) -> None:
        connect_calls.append((*args, kwargs))
        raise RuntimeError("stubbed PostgreSQL connection")

    psycopg2_stub.connect = connect  # type: ignore[attr-defined]
    psycopg2_stub.Error = Exception  # type: ignore[attr-defined]
    psycopg2_stub.extras = extras_stub  # type: ignore[attr-defined]
    extras_stub.RealDictCursor = RealDictCursor  # type: ignore[attr-defined]
    return psycopg2_stub, extras_stub


def _stub_pgvector() -> tuple[ModuleType, ModuleType]:
    """Build pgvector modules with a no-op registration hook."""
    pgvector_stub = ModuleType("pgvector")
    psycopg2_stub = ModuleType("pgvector.psycopg2")
    psycopg2_stub.register_vector = lambda _conn: None  # type: ignore[attr-defined]
    pgvector_stub.psycopg2 = psycopg2_stub  # type: ignore[attr-defined]
    return pgvector_stub, psycopg2_stub


def _stub_requests(post_calls: list[tuple[Any, ...]]) -> ModuleType:
    """Build requests with a recording post function."""
    requests_stub = ModuleType("requests")

    def post(*args: Any, **kwargs: Any) -> None:
        post_calls.append((*args, kwargs))

    requests_stub.post = post  # type: ignore[attr-defined]
    return requests_stub


@pytest.fixture(scope="module")
def loaded_analyzer() -> Iterator[tuple[ModuleType, list[tuple[Any, ...]]]]:
    """Load analyzer.py once with hand-rolled dependency stubs."""
    monkeypatch = pytest.MonkeyPatch()
    from_url_calls: list[tuple[Any, ...]] = []
    connect_calls: list[tuple[Any, ...]] = []
    post_calls: list[tuple[Any, ...]] = []

    torch_stub = _stub_torch()
    redis_stub, redis_exceptions_stub = _stub_redis(from_url_calls)
    psycopg2_stub, extras_stub = _stub_psycopg2(connect_calls)
    pgvector_stub, pgvector_psycopg2_stub = _stub_pgvector()
    librosa_stub = ModuleType("librosa")
    requests_stub = _stub_requests(post_calls)

    monkeypatch.setitem(sys.modules, "torch", torch_stub)
    monkeypatch.setitem(sys.modules, "redis", redis_stub)
    monkeypatch.setitem(sys.modules, "redis.exceptions", redis_exceptions_stub)
    monkeypatch.setitem(sys.modules, "psycopg2", psycopg2_stub)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", extras_stub)
    monkeypatch.setitem(sys.modules, "pgvector", pgvector_stub)
    monkeypatch.setitem(sys.modules, "pgvector.psycopg2", pgvector_psycopg2_stub)
    monkeypatch.setitem(sys.modules, "librosa", librosa_stub)
    monkeypatch.setitem(sys.modules, "requests", requests_stub)

    spec = importlib.util.spec_from_file_location(
        "clap_analyzer_module",
        ANALYZER_PATH,
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    assert connect_calls == []
    yield module, from_url_calls
    monkeypatch.undo()


def test_get_audio_embedding_survives_unload_between_ensure_and_inference(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module, _ = loaded_analyzer
    analyzer = module.CLAPAnalyzer()
    load_calls: list[bool] = []

    class FakeModel:
        def get_audio_embedding_from_data(
            self,
            audio_list: list[np.ndarray],
            use_tensor: bool = False,
        ) -> np.ndarray:
            assert len(audio_list) == 1
            assert use_tensor is False
            return np.zeros((1, 512), dtype=np.float32)

    def load_model() -> None:
        load_calls.append(True)
        analyzer.model = FakeModel()
        analyzer._model_loaded = True

    def load_audio_chunk(
        _audio_path: str,
        _duration_hint: float | None = None,
    ) -> tuple[np.ndarray, int]:
        analyzer.unload_model()
        return np.zeros(48000, dtype=np.float32), 48000

    monkeypatch.setattr(analyzer, "load_model", load_model)
    monkeypatch.setattr(analyzer, "_load_audio_chunk", load_audio_chunk)
    audio_path = tmp_path / "track.flac"
    audio_path.touch()

    embedding = analyzer.get_audio_embedding(str(audio_path))

    assert isinstance(embedding, np.ndarray)
    assert embedding.shape == (512,)
    assert load_calls == [True, True]


def test_unload_model_blocks_while_inference_holds_the_lock(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    analyzer = module.CLAPAnalyzer()
    inference_started = threading.Event()
    release = threading.Event()
    scheduling_window = threading.Event()
    result: list[np.ndarray | None] = []

    class FakeBlockingModel:
        def get_text_embedding(
            self,
            text_list: list[str],
            use_tensor: bool = False,
        ) -> np.ndarray:
            assert text_list == ["mellow jazz"]
            assert use_tensor is False
            inference_started.set()
            assert release.wait(timeout=5)
            return np.zeros((1, 512), dtype=np.float32)

    analyzer.model = FakeBlockingModel()
    analyzer._model_loaded = True
    inference_thread = threading.Thread(
        target=lambda: result.append(analyzer.get_text_embedding("mellow jazz")),
        name="InferenceThread",
    )
    unload_thread = threading.Thread(
        target=analyzer.unload_model,
        name="UnloadThread",
    )

    inference_thread.start()
    assert inference_started.wait(timeout=5)
    unload_thread.start()
    assert not scheduling_window.wait(timeout=0.05)
    try:
        assert unload_thread.is_alive()
        assert analyzer.model is not None
    finally:
        release.set()
        inference_thread.join(timeout=5)
        unload_thread.join(timeout=5)

    assert not inference_thread.is_alive()
    assert not unload_thread.is_alive()
    assert result and result[0] is not None
    assert analyzer.model is None
    assert isinstance(analyzer._lock, type(threading.RLock()))


def test_find_dead_threads_reports_only_finished_threads(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    find_dead_threads = module.find_dead_threads
    release = threading.Event()
    finished_thread = threading.Thread(target=lambda: None, name="FinishedThread")

    def wait_until_released() -> None:
        assert release.wait(timeout=5)

    alive_thread = threading.Thread(target=wait_until_released, name="AliveThread")

    finished_thread.start()
    finished_thread.join(timeout=5)
    assert not finished_thread.is_alive()
    alive_thread.start()
    try:
        assert find_dead_threads([finished_thread, alive_thread]) == ["FinishedThread"]
    finally:
        release.set()
        alive_thread.join(timeout=5)
    assert not alive_thread.is_alive()


def test_start_threads_registers_http_server_for_supervision(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Start the HTTP server as a daemon in the supervised thread list."""
    module, _ = loaded_analyzer
    release = threading.Event()
    http_started = threading.Event()
    received_analyzers: list[Any] = []
    received_stop_events: list[threading.Event] = []

    class BlockingHandler:
        def __init__(self, *_args: Any) -> None:
            pass

        def start(self) -> None:
            assert release.wait(timeout=5)

    http_server_stub = ModuleType("http_server")

    def run_http_server(analyzer: Any, stop_event: threading.Event) -> None:
        received_analyzers.append(analyzer)
        received_stop_events.append(stop_event)
        http_started.set()
        assert release.wait(timeout=5)

    http_server_stub.run_http_server = run_http_server  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "http_server", http_server_stub)
    monkeypatch.setattr(module, "Worker", BlockingHandler)
    monkeypatch.setattr(module, "TextEmbedHandler", BlockingHandler)
    monkeypatch.setattr(module, "ControlHandler", BlockingHandler)
    monkeypatch.setattr(module, "NUM_WORKERS", 1)
    analyzer = object()
    stop_event = threading.Event()

    threads = module._start_threads(analyzer, stop_event)
    try:
        assert http_started.wait(timeout=5)
        assert [thread.name for thread in threads] == [
            "Worker-0",
            "TextEmbedHandler",
            "ControlHandler",
            "ClapHttpServer",
        ]
        assert all(thread.daemon for thread in threads)
        assert received_analyzers == [analyzer]
        assert received_stop_events == [stop_event]
    finally:
        release.set()
        for thread in threads:
            thread.join(timeout=5)

    assert all(not thread.is_alive() for thread in threads)


def test_run_idle_monitor_stops_and_reports_when_a_thread_dies(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, from_url_calls = loaded_analyzer

    class FakeAnalyzer:
        _model_loaded = False
        last_work_time = time.time()

        def unload_model(self) -> None:
            pass

    class FakeIdleDatabase:
        def get_cursor(self) -> None:
            raise AssertionError("idle database must not be queried")

    class FakeQueueClient:
        def __init__(self) -> None:
            self.llen_calls: list[str] = []

        def llen(self, name: str) -> int:
            self.llen_calls.append(name)
            return 0

    finished_thread = threading.Thread(target=lambda: None, name="DeadWorker")
    finished_thread.start()
    finished_thread.join(timeout=5)
    assert not finished_thread.is_alive()
    stop_event = threading.Event()
    queue_client = FakeQueueClient()
    initial_from_url_calls = len(from_url_calls)

    clean_stop = module.run_idle_monitor(
        FakeAnalyzer(),
        stop_event,
        FakeIdleDatabase(),
        queue_client,
        [finished_thread],
    )

    assert clean_stop is False
    assert stop_event.is_set()
    assert len(from_url_calls) == initial_from_url_calls


def test_run_idle_monitor_uses_injected_queue_client_for_early_unload(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, from_url_calls = loaded_analyzer
    assert module.IDLE_POLL_SECONDS == 5
    run_idle_monitor = module.run_idle_monitor
    stop_event = threading.Event()
    unload_calls: list[bool] = []
    release = threading.Event()

    class FakeAnalyzer:
        _model_loaded = True
        last_work_time = time.time() - (module.SLEEP_INTERVAL * 2 + 1)

        def unload_model(self) -> None:
            unload_calls.append(True)
            self._model_loaded = False
            stop_event.set()

    class FakeCursor:
        def execute(self, _query: str) -> None:
            pass

        def fetchone(self) -> dict[str, int]:
            return {"cnt": 0}

        def close(self) -> None:
            pass

    class FakeIdleDatabase:
        def get_cursor(self) -> FakeCursor:
            return FakeCursor()

    class FakeQueueClient:
        def __init__(self) -> None:
            self.llen_calls: list[str] = []

        def llen(self, name: str) -> int:
            self.llen_calls.append(name)
            return 0

    def wait_until_released() -> None:
        assert release.wait(timeout=5)

    healthy_thread = threading.Thread(target=wait_until_released, name="HealthyWorker")
    queue_client = FakeQueueClient()
    initial_from_url_calls = len(from_url_calls)
    healthy_thread.start()
    try:
        clean_stop = run_idle_monitor(
            FakeAnalyzer(),
            stop_event,
            FakeIdleDatabase(),
            queue_client,
            [healthy_thread],
        )
    finally:
        release.set()
        healthy_thread.join(timeout=5)

    assert not healthy_thread.is_alive()
    assert clean_stop is True
    assert unload_calls == [True]
    assert queue_client.llen_calls == [module.ANALYSIS_QUEUE]
    assert len(from_url_calls) == initial_from_url_calls


def test_clap_analyzer_source_does_not_use_deprecated_datetime_utcnow() -> None:
    source = ANALYZER_PATH.read_text(encoding="utf-8")

    assert "datetime.utcnow" not in source
    assert "utcnow()" not in source


def test_resolve_active_space_id_returns_single_active_id(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    database, connection = _database_with_space_rows(
        module,
        [{"id": "space-current", "created_at": "2026-08-16T12:00:00Z"}],
    )

    resolved = module.resolve_active_space_id(database)

    assert resolved == "space-current"
    query = connection.executions[0][0]
    assert "SELECT id, created_at FROM embedding_spaces" in query
    assert "WHERE status = 'active'" in query
    assert "ORDER BY created_at ASC" in query


def test_resolve_active_space_id_uses_oldest_and_warns_for_multiple_actives(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    module, _ = loaded_analyzer
    database, _ = _database_with_space_rows(
        module,
        [
            {"id": "space-oldest", "created_at": "2026-08-16T12:00:00Z"},
            {"id": "space-newest", "created_at": "2026-08-16T13:00:00Z"},
        ],
    )

    with caplog.at_level(logging.WARNING, logger=module.logger.name):
        resolved = module.resolve_active_space_id(database)

    assert resolved == "space-oldest"
    assert "space-oldest" in caplog.text
    assert "space-newest" in caplog.text


def test_missing_active_space_marks_job_failed_without_insert(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module, _ = loaded_analyzer
    database, connection = _database_with_space_rows(module, [])
    failures: list[tuple[str, str]] = []
    audio_path = tmp_path / "track.flac"
    audio_path.touch()

    class FakeJobRedis:
        def blpop(self, _queue: str, timeout: int) -> tuple[str, bytes]:
            assert timeout == module.SLEEP_INTERVAL
            job = {"trackId": "track-1", "filePath": audio_path.name}
            return module.ANALYSIS_QUEUE, json.dumps(job).encode()

    class FakeAnalyzer:
        def get_audio_embedding(
            self,
            _audio_path: str,
            _duration: float | None,
        ) -> np.ndarray:
            return np.zeros(512, dtype=np.float32)

    worker = module.Worker(1, FakeAnalyzer(), threading.Event())
    worker.redis_client = FakeJobRedis()
    worker.db = database
    monkeypatch.setattr(module, "MUSIC_PATH", str(tmp_path))
    monkeypatch.setattr(worker, "_claim_track", lambda _track_id: True)
    monkeypatch.setattr(worker, "_release_queue_reservation", lambda _track_id: None)
    monkeypatch.setattr(
        worker,
        "_mark_failed",
        lambda track_id, error: failures.append((track_id, error)),
    )

    worker._process_job()

    assert failures == [
        ("track-1", "No active embedding space is registered; embedding was not stored")
    ]
    assert connection.insert_attempts == []


def test_store_embedding_writes_space_id_without_model_version(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    database, connection = _database_with_space_rows(
        module,
        [{"id": "space-current", "created_at": "2026-08-16T12:00:00Z"}],
    )
    worker = module.Worker(1, None, threading.Event())
    worker.db = database

    stored = worker._store_embedding("track-1", np.zeros(512, dtype=np.float32))

    assert stored is True
    query, params = connection.insert_attempts[0]
    assert "space_id" in query
    assert "model_version" not in query
    assert params[2] == "space-current"


def test_active_space_cache_is_honored_then_refreshed_after_ttl(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    clock = FakeClock()
    database, connection = _database_with_space_rows(
        module,
        [{"id": "space-old", "created_at": "2026-08-16T12:00:00Z"}],
        clock,
    )

    assert database.get_active_space_id() == "space-old"
    connection.active_rows = [{"id": "space-new", "created_at": "2026-08-16T13:00:00Z"}]
    clock.now = module.ACTIVE_SPACE_CACHE_TTL_SECONDS
    assert database.get_active_space_id() == "space-old"
    clock.now = module.ACTIVE_SPACE_CACHE_TTL_SECONDS + 1
    assert database.get_active_space_id() == "space-new"
    assert connection.resolve_calls == 2


def test_store_embedding_does_not_retry_unrelated_insert_failures(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    database, connection = _database_with_space_rows(
        module,
        [{"id": "space-old", "created_at": "2026-08-16T12:00:00Z"}],
    )
    assert database.get_active_space_id() == "space-old"
    connection.insert_errors.append(
        RuntimeError('null value in column "analyzed_at" violates not-null constraint')
    )
    worker = module.Worker(1, None, threading.Event())
    worker.db = database

    stored = worker._store_embedding("track-1", np.zeros(512, dtype=np.float32))

    assert stored is False
    assert len(connection.insert_attempts) == 1
    assert connection.resolve_calls == 1


def test_store_embedding_reresolves_once_after_foreign_key_failure(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    database, connection = _database_with_space_rows(
        module,
        [{"id": "space-old", "created_at": "2026-08-16T12:00:00Z"}],
    )
    assert database.get_active_space_id() == "space-old"
    connection.active_rows = [{"id": "space-new", "created_at": "2026-08-16T13:00:00Z"}]
    connection.insert_errors.append(
        RuntimeError('violates foreign key constraint "track_embeddings_space_id_fkey"')
    )
    worker = module.Worker(1, None, threading.Event())
    worker.db = database

    stored = worker._store_embedding("track-1", np.zeros(512, dtype=np.float32))

    assert stored is True
    assert [params[2] for _, params in connection.insert_attempts] == [
        "space-old",
        "space-new",
    ]
    assert connection.resolve_calls == 2
    assert connection.rollback_calls == 1
