"""HTTP and job-state coverage for YouTube Music album downloads."""

import asyncio
from concurrent.futures import Future
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient


class _InlineExecutor:
    """Run submitted test work inline while preserving the Executor contract."""

    def submit(self, function: Any, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(function(*args, **kwargs))
        except Exception as error:
            future.set_exception(error)
        return future


@pytest.mark.anyio
async def test_album_download_requires_internal_secret() -> None:
    from app import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/yt/download/album", json={"browse_id": "MPREtest"})

    assert response.status_code == 403


@pytest.mark.anyio
async def test_album_search_requires_internal_secret() -> None:
    from app import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/yt/album-search?query=Artist%20Album")

    assert response.status_code == 403


@pytest.mark.anyio
async def test_album_search_normalizes_public_results(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    class PublicClient:
        def search(self, query: str, *, filter: str, limit: int) -> list[dict[str, Any]]:
            assert query == "Artist Album"
            assert filter == "albums"
            assert limit == 10
            return [
                {
                    "browseId": "MPREexact",
                    "title": "Album",
                    "artists": [{"name": "Artist"}, {"name": "Guest"}],
                },
                {"title": "Missing browse id", "artists": [{"name": "Artist"}]},
            ]

    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: PublicClient())

    response = await client.get("/yt/album-search?query=Artist%20Album")

    assert response.status_code == 200
    assert response.json() == {
        "albums": [
            {
                "browse_id": "MPREexact",
                "title": "Album",
                "artists": ["Artist", "Guest"],
            }
        ]
    }


@pytest.mark.anyio
async def test_album_search_rejects_empty_query(client: AsyncClient) -> None:
    assert (await client.get("/yt/album-search?query=")).status_code == 422
    assert (await client.get("/yt/album-search?query=%20%20")).status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize(("requested", "expected"), [(0, 1), (100, 25)])
async def test_album_search_clamps_limit(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    requested: int,
    expected: int,
) -> None:
    import app

    class PublicClient:
        def search(self, _query: str, *, filter: str, limit: int) -> list[dict[str, Any]]:
            assert filter == "albums"
            assert limit == expected
            return []

    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: PublicClient())

    response = await client.get(f"/yt/album-search?query=Album&limit={requested}")

    assert response.status_code == 200
    assert response.json() == {"albums": []}


@pytest.mark.anyio
async def test_album_job_create_status_cancel_and_separate_listing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    async def no_download(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "_run_yt_album_download_job", no_download)
    app._yt_album_download_jobs.clear()
    app._yt_download_jobs.clear()

    created = await client.post(
        "/yt/download/album",
        json={"browse_id": "MPREtest", "format": "mp3", "quality": "HIGH"},
    )
    assert created.status_code == 200
    job_id = created.json()["job_id"]

    status = await client.get(f"/yt/download/album/{job_id}")
    cancelled = await client.delete(f"/yt/download/album/{job_id}")
    listed = await client.get("/yt/downloads")

    assert status.json()["browse_id"] == "MPREtest"
    assert cancelled.json()["status"] == "cancelled"
    assert listed.json() == {"jobs": []}


@pytest.mark.anyio
async def test_album_job_unknown_status_and_cancel_return_404(client: AsyncClient) -> None:
    assert (await client.get("/yt/download/album/missing")).status_code == 404
    assert (await client.delete("/yt/download/album/missing")).status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        {"browse_id": "MPREtest", "format": "wav"},
        {"browse_id": "MPREtest", "quality": "ULTRA"},
    ],
)
async def test_album_download_validates_format_and_quality(
    client: AsyncClient, payload: dict[str, str]
) -> None:
    assert (await client.post("/yt/download/album", json=payload)).status_code == 422


@pytest.mark.anyio
async def test_album_download_ignores_client_output_path(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    received_paths: list[Path] = []
    captured = asyncio.Event()

    async def capture_path(
        _job: dict[str, Any], _format: str, _quality: str, music_path: Path
    ) -> None:
        received_paths.append(music_path)
        captured.set()

    configured_path = tmp_path / "configured"
    monkeypatch.setattr(app, "MUSIC_PATH", configured_path)
    monkeypatch.setattr(app, "_run_yt_album_download_job", capture_path)

    response = await client.post(
        "/yt/download/album",
        json={"browse_id": "MPREtest", "output_dir": str(tmp_path / "outside")},
    )
    await asyncio.wait_for(captured.wait(), timeout=1)

    assert response.status_code == 200
    assert received_paths == [configured_path]


def test_album_download_request_has_no_client_output_path() -> None:
    import app

    assert "output_dir" not in app.YtAlbumDownloadRequest.model_fields
    assert "output_template" not in app.YtAlbumDownloadRequest.model_fields


def test_album_track_download_skips_existing_deterministic_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    class FailPacer:
        def wait(self) -> float:
            raise AssertionError("existing tracks must not reach yt-dlp pacing")

    final_path = tmp_path / "Artist" / "Album" / "01. Title.mp3"
    final_path.parent.mkdir(parents=True)
    final_path.write_bytes(b"existing")
    monkeypatch.setattr(app, "_extract_pacer", FailPacer())

    result = app._download_album_track_sync(
        job={"cancel_requested": False},
        track={
            "videoId": "video000001",
            "title": "Title",
            "trackNumber": 1,
            "artists": ["Artist"],
        },
        index=1,
        album_title="Album",
        album_artist="Artist",
        year="2024",
        audio_format="mp3",
        quality="HIGH",
        music_path=tmp_path,
    )

    assert result == str(final_path)
    assert final_path.read_bytes() == b"existing"


def _album() -> dict[str, Any]:
    return {
        "title": "Album",
        "artist": "Artist",
        "year": "2024",
        "tracks": [
            {
                "videoId": "video000001",
                "title": "One",
                "trackNumber": 1,
                "artists": ["Artist"],
            },
            {
                "videoId": "video000002",
                "title": "Two",
                "trackNumber": 2,
                "artists": ["Guest"],
            },
        ],
    }


@pytest.mark.anyio
async def test_album_job_completes_with_partial_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    async def album_metadata(_browse_id: str) -> dict[str, Any]:
        return _album()

    def download_track(*_args: Any, **kwargs: Any) -> str:
        if kwargs["track"]["videoId"] == "video000002":
            raise RuntimeError("secret URL token=leak")
        return str(tmp_path / "one.mp3")

    monkeypatch.setattr(app, "get_public_album_metadata", album_metadata)
    monkeypatch.setattr(app, "_download_album_track_sync", download_track)
    monkeypatch.setattr(app, "_yt_album_download_executor", _InlineExecutor())
    job = app._new_yt_album_download_job("MPREtest")

    await app._run_yt_album_download_job(job, "mp3", "HIGH", tmp_path)

    assert job["status"] == "completed"
    assert job["progress_pct"] == 100.0
    assert job["downloaded"] == 1
    assert job["failed"] == 1
    assert job["errors"] == [
        {"video_id": "video000002", "title": "Two", "error": "Track download failed"}
    ]
    assert "token=leak" not in str(job)


@pytest.mark.anyio
async def test_album_job_fails_when_zero_tracks_succeed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    async def album_metadata(_browse_id: str) -> dict[str, Any]:
        return _album()

    def fail_track(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("private URL")

    monkeypatch.setattr(app, "get_public_album_metadata", album_metadata)
    monkeypatch.setattr(app, "_download_album_track_sync", fail_track)
    monkeypatch.setattr(app, "_yt_album_download_executor", _InlineExecutor())
    job = app._new_yt_album_download_job("MPREtest")

    await app._run_yt_album_download_job(job, "mp3", "HIGH", tmp_path)

    assert job["status"] == "failed"
    assert job["downloaded"] == 0
    assert job["failed"] == 2
    assert job["error"] == "Album download failed"
    assert "private URL" not in str(job)
