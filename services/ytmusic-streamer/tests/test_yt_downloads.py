"""
Endpoint tests for the downloads-view surface:
  GET    /yt/downloads          (list jobs for the activity panel)
  DELETE /yt/downloads/{job_id} (cancel queued/in-flight jobs)
and the `source` grouping label threaded through POST /yt/download.

yt-dlp / real downloads are never invoked: the list/cancel tests seed the
in-memory job store directly, and the POST test stubs the background worker.
"""

from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient


@pytest.mark.anyio
async def test_downloads_list_returns_jobs_newest_first(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    older = app_module._new_yt_download_job("vid00000001", source="Chan A")
    newer = app_module._new_yt_download_job("vid00000002", status="completed", source="Chan A")
    # Keep both recent (so the 6h TTL prune does not drop the terminal one),
    # but guarantee a strict ordering for the newest-first assertion.
    newer["created_at"] = older["created_at"] + 5

    resp = await client.get("/yt/downloads")

    assert resp.status_code == 200
    jobs = resp.json()["jobs"]
    assert [j["video_id"] for j in jobs] == ["vid00000002", "vid00000001"]
    assert all(j["source"] == "Chan A" for j in jobs)
    assert all("created_at" in j for j in jobs)


@pytest.mark.anyio
async def test_downloads_list_empty(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    resp = await client.get("/yt/downloads")
    assert resp.status_code == 200
    assert resp.json() == {"jobs": []}


@pytest.mark.anyio
async def test_cancel_queued_job_marks_cancelled(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    job = app_module._new_yt_download_job("vid00000003", source="Chan A")

    resp = await client.delete(f"/yt/downloads/{job['job_id']}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"
    assert app_module._yt_download_jobs[job["job_id"]]["cancel_requested"] is True


@pytest.mark.anyio
async def test_cancel_inflight_sets_flag_without_forcing_status(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    job = app_module._new_yt_download_job("vid00000004")
    job["status"] = "downloading"

    resp = await client.delete(f"/yt/downloads/{job['job_id']}")

    assert resp.status_code == 200
    # In-flight: flag set so the worker aborts at the next tick; status is
    # not force-cancelled here (the worker settles it).
    assert app_module._yt_download_jobs[job["job_id"]]["cancel_requested"] is True
    assert resp.json()["status"] == "downloading"


@pytest.mark.anyio
async def test_cancel_terminal_job_is_noop(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    job = app_module._new_yt_download_job("vid00000005", status="completed")

    resp = await client.delete(f"/yt/downloads/{job['job_id']}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"
    assert app_module._yt_download_jobs[job["job_id"]]["cancel_requested"] is False


@pytest.mark.anyio
async def test_cancel_unknown_job_404(client: AsyncClient) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    resp = await client.delete("/yt/downloads/does-not-exist")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_post_download_records_source(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app as app_module

    app_module._yt_download_jobs.clear()
    monkeypatch.setattr(app_module, "YT_DOWNLOAD_DIR", str(tmp_path))

    async def _noop(*args: Any, **kwargs: Any) -> Any:
        return None

    with patch("app._run_yt_download_job", _noop):
        resp = await client.post(
            "/yt/download",
            json={
                "video_id": "vidsourceAB",
                "format": "opus",
                "quality": "HIGH",
                "source": "My Channel",
            },
        )

    assert resp.status_code == 200
    job_id = resp.json()["job_id"]
    assert app_module._yt_download_jobs[job_id]["source"] == "My Channel"


def test_download_request_model_has_no_output_dir() -> None:
    """The write path is server config (YT_DOWNLOAD_DIR); callers must not
    be able to point downloads at an arbitrary directory."""
    import app as app_module

    assert "output_dir" not in app_module.YtDownloadRequest.model_fields


@pytest.mark.anyio
async def test_post_download_ignores_client_output_dir(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client-supplied output_dir is ignored: the idempotency check (and
    the download itself) always target the server-configured
    YT_DOWNLOAD_DIR, never a caller-chosen path."""
    import app as app_module

    app_module._yt_download_jobs.clear()
    download_dir = tmp_path / "downloads"
    download_dir.mkdir()
    evil_dir = tmp_path / "evil"
    evil_dir.mkdir()
    monkeypatch.setattr(app_module, "YT_DOWNLOAD_DIR", str(download_dir))

    # Seed a completed download in the configured dir. If the endpoint
    # honored the caller's (empty) output_dir it would miss this file and
    # queue a fresh download instead of reporting completed.
    existing = download_dir / "Song [vidoutdirAA].mp3"
    existing.write_bytes(b"x")

    async def _noop(*args: Any, **kwargs: Any) -> Any:
        return None

    with patch("app._run_yt_download_job", _noop):
        resp = await client.post(
            "/yt/download",
            json={
                "video_id": "vidoutdirAA",
                "format": "mp3",
                "quality": "HIGH",
                "output_dir": str(evil_dir),
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    job = app_module._yt_download_jobs[body["job_id"]]
    assert job["file_path"] == str(existing)
