"""Red-phase contracts for CLAP analyzer runtime reliability."""

import importlib.util
from pathlib import Path
import sys
import threading
import time
from types import ModuleType
from typing import Any, Iterator

import numpy as np
import pytest


ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


class RealDictCursor:
    """Placeholder cursor factory used by the analyzer import."""


class ResponseError(Exception):
    """Placeholder Redis response error used by handler exception clauses."""


class FakeRedisClient:
    """Placeholder client returned by the recording Redis constructor."""


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
