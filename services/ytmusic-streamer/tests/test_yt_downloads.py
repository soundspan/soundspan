"""
Endpoint tests for the downloads-view surface:
  GET    /yt/downloads          (list jobs for the activity panel)
  DELETE /yt/downloads/{job_id} (cancel queued/in-flight jobs)
and the `source` grouping label threaded through POST /yt/download.

yt-dlp / real downloads are never invoked: the list/cancel tests seed the
in-memory job store directly, and the POST test stubs the background worker.
"""

from unittest.mock import patch

import pytest


@pytest.mark.anyio
async def test_downloads_list_returns_jobs_newest_first(client):
    import app as app_module

    app_module._yt_download_jobs.clear()
    older = app_module._new_yt_download_job("vid00000001", source="Chan A")
    newer = app_module._new_yt_download_job(
        "vid00000002", status="completed", source="Chan A"
    )
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
async def test_downloads_list_empty(client):
    import app as app_module

    app_module._yt_download_jobs.clear()
    resp = await client.get("/yt/downloads")
    assert resp.status_code == 200
    assert resp.json() == {"jobs": []}


@pytest.mark.anyio
async def test_cancel_queued_job_marks_cancelled(client):
    import app as app_module

    app_module._yt_download_jobs.clear()
    job = app_module._new_yt_download_job("vid00000003", source="Chan A")

    resp = await client.delete(f"/yt/downloads/{job['job_id']}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"
    assert app_module._yt_download_jobs[job["job_id"]]["cancel_requested"] is True


@pytest.mark.anyio
async def test_cancel_inflight_sets_flag_without_forcing_status(client):
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
async def test_cancel_terminal_job_is_noop(client):
    import app as app_module

    app_module._yt_download_jobs.clear()
    job = app_module._new_yt_download_job("vid00000005", status="completed")

    resp = await client.delete(f"/yt/downloads/{job['job_id']}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"
    assert app_module._yt_download_jobs[job["job_id"]]["cancel_requested"] is False


@pytest.mark.anyio
async def test_cancel_unknown_job_404(client):
    import app as app_module

    app_module._yt_download_jobs.clear()
    resp = await client.delete("/yt/downloads/does-not-exist")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_post_download_records_source(client, tmp_path):
    import app as app_module

    app_module._yt_download_jobs.clear()

    async def _noop(*args, **kwargs):
        return None

    with patch("app._run_yt_download_job", _noop):
        resp = await client.post(
            "/yt/download",
            json={
                "video_id": "vidsourceAB",
                "format": "opus",
                "quality": "HIGH",
                "source": "My Channel",
                "output_dir": str(tmp_path),
            },
        )

    assert resp.status_code == 200
    job_id = resp.json()["job_id"]
    assert app_module._yt_download_jobs[job_id]["source"] == "My Channel"
