"""Reliability regression tests for YouTube proxy streaming."""

from __future__ import annotations

import pytest


VIDEO_ID = "dQw4w9WgXcQ"
STREAM_INFO = {
    "url": "http://cdn/x",
    "acodec": "mp4a.40.2",
    "content_type": "m4a",
    "duration": 1,
    "expires_at": 9e9,
    "abr": 128,
}


class FakeUpstream:
    """Minimal async streaming response used by the proxy tests."""

    def __init__(self, headers, chunks, status_code=206):
        self.headers = headers
        self._chunks = chunks
        self.status_code = status_code
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        await self.aclose()
        return False

    async def aiter_bytes(self, chunk_size=65536):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        self.closed = True


class FakeClient:
    """Minimal async httpx-like client used by the proxy tests."""

    def __init__(self, upstream=None, raise_on_send=False):
        self._up = upstream
        self.raise_on_send = raise_on_send
        self.closed = False

    def build_request(self, method, url, headers=None):
        return (method, url, headers)

    async def send(self, request, stream=False):
        if self.raise_on_send:
            raise RuntimeError("send boom")
        return self._up

    def stream(self, method, url, headers=None):
        return self._up

    async def aclose(self):
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        await self.aclose()
        return False


def _patch_stream_info(monkeypatch, app):
    monkeypatch.setattr(app, "_get_stream_url_sync", lambda *_args: STREAM_INFO)
    monkeypatch.setattr(app, "_get_yt_stream_url_sync", lambda *_args: STREAM_INFO)


def _patch_client_factory(monkeypatch, app, fake_client):
    factory = lambda user_agent=None: fake_client
    monkeypatch.setattr(
        "common.sidecar_runtime_utils.build_stream_proxy_client", factory
    )
    # The legacy routes imported the factory directly. This patch keeps the
    # pre-refactor regression run bounded; shared-helper routes ignore it.
    monkeypatch.setattr(app, "build_stream_proxy_client", factory, raising=False)


@pytest.mark.anyio
async def test_range_response_omits_content_length(client, monkeypatch):
    import app

    chunks = [b"range ", b"body"]
    upstream = FakeUpstream(
        {"content-length": "10", "content-range": "bytes 0-9/999"},
        chunks,
    )
    fake_client = FakeClient(upstream)
    _patch_stream_info(monkeypatch, app)
    _patch_client_factory(monkeypatch, app, fake_client)

    response = await client.get(
        f"/yt/proxy/{VIDEO_ID}", headers={"Range": "bytes=0-"}
    )

    assert response.status_code == 206
    assert response.content == b"".join(chunks)
    assert "content-length" not in response.headers
    assert response.headers["content-range"] == "bytes 0-9/999"


@pytest.mark.anyio
async def test_range_send_failure_closes_client_no_leak(client, monkeypatch):
    import app

    fake_client = FakeClient(raise_on_send=True)
    _patch_stream_info(monkeypatch, app)
    _patch_client_factory(monkeypatch, app, fake_client)
    client._transport.raise_app_exceptions = False

    response = await client.get(
        f"/proxy/{VIDEO_ID}?user_id=__public__",
        headers={"Range": "bytes=0-"},
    )

    assert fake_client.closed is True
    assert response.status_code == 500


@pytest.mark.anyio
async def test_full_response_streams_and_closes(client, monkeypatch):
    import app

    chunks = [b"full ", b"body"]
    upstream = FakeUpstream({}, chunks, status_code=200)
    fake_client = FakeClient(upstream)
    _patch_stream_info(monkeypatch, app)
    _patch_client_factory(monkeypatch, app, fake_client)

    response = await client.get(f"/yt/proxy/{VIDEO_ID}")

    assert response.status_code == 200
    assert response.content == b"".join(chunks)
    assert upstream.closed is True
    assert fake_client.closed is True
