"""Tests for TIDAL DASH stream handling (HI_RES_LOSSLESS).

Verifies that:
- The initialization segment URL is extracted and prepended to the segment list
- The codec is correctly detected from the DASH manifest (e.g. FLAC, not AAC)
- Adaptation-level SegmentTemplate fallback works
- Oversized or invalid manifests are handled gracefully
"""

from __future__ import annotations

from base64 import b64encode

import pytest


# ── Minimal DASH MPD fixtures ──────────────────────────────────────


def _build_mpd(
    codecs: str = "flac",
    init_url: str = "https://cdn.tidal.com/init.mp4",
    media_template: str = "https://cdn.tidal.com/$Number$.mp4",
    segment_count: int = 3,
    segment_duration: int = 96256,
    *,
    segment_template_at_adaptation: bool = False,
) -> str:
    """Build a minimal DASH MPD XML string.

    When *segment_template_at_adaptation* is True the SegmentTemplate is placed
    at the AdaptationSet level rather than Representation, exercising the
    fallback search path.
    """
    timeline_entries = (
        f'<S d="{segment_duration}"/>'
        if segment_count == 1
        else f'<S d="{segment_duration}" r="{segment_count - 1}"/>'
    )
    seg_tpl = (
        f'<SegmentTemplate initialization="{init_url}" media="{media_template}" startNumber="0">'
        f"<SegmentTimeline>{timeline_entries}</SegmentTimeline>"
        f"</SegmentTemplate>"
    )
    if segment_template_at_adaptation:
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet>
      {seg_tpl}
      <Representation codecs="{codecs}" bandwidth="1411200"/>
    </AdaptationSet>
  </Period>
</MPD>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet>
      <Representation codecs="{codecs}" bandwidth="1411200">
        {seg_tpl}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"""


def _encode_manifest(xml_str: str) -> str:
    """Base64-encode a manifest string (matching TIDAL's format)."""
    return b64encode(xml_str.encode()).decode()


# ── _extract_dash_init_url ─────────────────────────────────────────


class TestExtractDashInitUrl:
    """Tests for _extract_dash_init_url."""

    def test_extracts_init_url_from_valid_mpd(self):
        from app import _extract_dash_init_url

        mpd = _build_mpd(init_url="https://cdn.tidal.com/tracks/123/init.mp4")
        result = _extract_dash_init_url(_encode_manifest(mpd))
        assert result == "https://cdn.tidal.com/tracks/123/init.mp4"

    def test_extracts_init_url_from_adaptation_level_template(self):
        from app import _extract_dash_init_url

        mpd = _build_mpd(
            init_url="https://cdn.tidal.com/adapt/init.mp4",
            segment_template_at_adaptation=True,
        )
        result = _extract_dash_init_url(_encode_manifest(mpd))
        assert result == "https://cdn.tidal.com/adapt/init.mp4"

    def test_returns_none_when_no_segment_template(self):
        from app import _extract_dash_init_url

        mpd = """<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period><AdaptationSet><Representation codecs="flac"/></AdaptationSet></Period>
</MPD>"""
        result = _extract_dash_init_url(_encode_manifest(mpd))
        assert result is None

    def test_returns_none_when_no_initialization_attribute(self):
        from app import _extract_dash_init_url

        mpd = """<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period><AdaptationSet><Representation codecs="flac">
    <SegmentTemplate media="$Number$.mp4">
      <SegmentTimeline><S d="96256"/></SegmentTimeline>
    </SegmentTemplate>
  </Representation></AdaptationSet></Period>
</MPD>"""
        result = _extract_dash_init_url(_encode_manifest(mpd))
        assert result is None

    def test_returns_none_on_invalid_base64(self):
        from app import _extract_dash_init_url

        result = _extract_dash_init_url("not-valid-base64!!!")
        assert result is None

    def test_returns_none_on_invalid_xml(self):
        from app import _extract_dash_init_url

        result = _extract_dash_init_url(_encode_manifest("<not-xml"))
        assert result is None

    def test_returns_none_on_oversized_manifest(self):
        from app import _extract_dash_init_url, _MAX_MANIFEST_BYTES

        # Manifest that exceeds the size cap when decoded
        big_xml = "<MPD>" + "x" * (_MAX_MANIFEST_BYTES + 1) + "</MPD>"
        result = _extract_dash_init_url(_encode_manifest(big_xml))
        assert result is None


# ── _resolve_dash_codec ────────────────────────────────────────────


class TestResolveDashCodec:
    """Tests for _resolve_dash_codec."""

    def test_returns_flac_codec(self):
        from app import _resolve_dash_codec

        mpd = _build_mpd(codecs="flac")
        result = _resolve_dash_codec(_encode_manifest(mpd))
        assert result == "flac"

    def test_returns_aac_codec(self):
        from app import _resolve_dash_codec

        mpd = _build_mpd(codecs="mp4a.40.2")
        result = _resolve_dash_codec(_encode_manifest(mpd))
        assert result == "mp4a.40.2"

    def test_returns_alac_codec(self):
        from app import _resolve_dash_codec

        mpd = _build_mpd(codecs="alac")
        result = _resolve_dash_codec(_encode_manifest(mpd))
        assert result == "alac"

    def test_returns_none_on_invalid_manifest(self):
        from app import _resolve_dash_codec

        result = _resolve_dash_codec("bad-input")
        assert result is None

    def test_returns_none_when_no_representation(self):
        from app import _resolve_dash_codec

        mpd = """<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period><AdaptationSet/></Period>
</MPD>"""
        result = _resolve_dash_codec(_encode_manifest(mpd))
        assert result is None

    def test_returns_none_on_oversized_manifest(self):
        from app import _resolve_dash_codec, _MAX_MANIFEST_BYTES

        big_xml = "<MPD>" + "x" * (_MAX_MANIFEST_BYTES + 1) + "</MPD>"
        result = _resolve_dash_codec(_encode_manifest(big_xml))
        assert result is None


# ── _parse_dash_mpd ────────────────────────────────────────────────


class TestParseDashMpd:
    """Tests for the shared MPD parser."""

    def test_parses_valid_manifest(self):
        from app import _parse_dash_mpd

        mpd = _build_mpd()
        result = _parse_dash_mpd(_encode_manifest(mpd))
        assert result is not None

    def test_returns_none_for_empty_string(self):
        from app import _parse_dash_mpd

        result = _parse_dash_mpd("")
        assert result is None

    def test_returns_none_for_non_base64(self):
        from app import _parse_dash_mpd

        result = _parse_dash_mpd("not-valid-base64!!!")
        assert result is None

    def test_returns_none_for_oversized_manifest(self):
        from app import _parse_dash_mpd, _MAX_MANIFEST_BYTES

        big_xml = "<MPD>" + "x" * (_MAX_MANIFEST_BYTES + 1) + "</MPD>"
        result = _parse_dash_mpd(_encode_manifest(big_xml))
        assert result is None


class _FakeDashSegmentResponse:
    def __init__(self, status_code: int, chunks: list[bytes] | None = None):
        self.status_code = status_code
        self.headers = {}
        self._chunks = chunks or []

    async def aiter_bytes(self, chunk_size: int = 65536):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        return None


class _FakeDashClient:
    def __init__(self, responses: list[_FakeDashSegmentResponse]):
        self._responses = list(responses)
        self.sent_urls: list[str] = []

    def build_request(self, method: str, url: str, headers=None):
        return {"method": method, "url": url, "headers": headers or {}}

    async def send(self, request, stream: bool = False):
        self.sent_urls.append(request["url"])
        if not self._responses:
            raise AssertionError("Unexpected extra segment request in test")
        return self._responses.pop(0)

    async def aclose(self):
        return None


@pytest.mark.anyio
async def test_dash_proxy_returns_502_when_first_segment_is_rejected(client, monkeypatch):
    import app as app_module

    cleared_cache_calls = {"count": 0}

    async def _fake_run_user_api_call(user_id, callback, operation):  # noqa: ARG001
        return {
            "is_dash": True,
            "urls": ["https://segment.example/seg-1.m4s"],
            "content_type": "audio/mp4",
        }

    monkeypatch.setattr(app_module, "_run_user_api_call", _fake_run_user_api_call)
    monkeypatch.setattr(app_module, "_normalize_stream_quality", lambda q: q)
    monkeypatch.setattr(
        app_module,
        "_clear_stream_cache",
        lambda *args, **kwargs: cleared_cache_calls.__setitem__(
            "count",
            cleared_cache_calls["count"] + 1,
        ),
    )
    monkeypatch.setattr(
        app_module,
        "build_stream_proxy_client",
        lambda: _FakeDashClient([_FakeDashSegmentResponse(403)]),
    )

    response = await client.get(
        "/user/stream/12345",
        params={"user_id": "user-1", "quality": "HI_RES_LOSSLESS"},
    )

    assert response.status_code == 502
    assert cleared_cache_calls["count"] == 1


@pytest.mark.anyio
async def test_dash_proxy_refreshes_url_once_after_403_then_streams(client, monkeypatch):
    import app as app_module

    call_count = {"count": 0}

    async def _fake_run_user_api_call(user_id, callback, operation):  # noqa: ARG001
        call_count["count"] += 1
        if call_count["count"] == 1:
            return {
                "is_dash": True,
                "urls": ["https://segment.example/stale-seg-1.m4s"],
                "content_type": "audio/mp4",
            }
        return {
            "is_dash": True,
            "urls": ["https://segment.example/fresh-seg-1.m4s"],
            "content_type": "audio/mp4",
        }

    stale_client = _FakeDashClient([_FakeDashSegmentResponse(403)])
    fresh_client = _FakeDashClient([_FakeDashSegmentResponse(200, [b"fresh-bytes"])])
    fake_clients = [stale_client, fresh_client]

    monkeypatch.setattr(app_module, "_run_user_api_call", _fake_run_user_api_call)
    monkeypatch.setattr(app_module, "_normalize_stream_quality", lambda q: q)
    monkeypatch.setattr(app_module, "_clear_stream_cache", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        app_module,
        "build_stream_proxy_client",
        lambda: fake_clients.pop(0),
    )

    response = await client.get(
        "/user/stream/12345",
        params={"user_id": "user-1", "quality": "HI_RES_LOSSLESS"},
    )

    assert response.status_code == 200
    assert response.content == b"fresh-bytes"
    assert call_count["count"] == 2
    assert stale_client.sent_urls == ["https://segment.example/stale-seg-1.m4s"]
    assert fresh_client.sent_urls == ["https://segment.example/fresh-seg-1.m4s"]


@pytest.mark.anyio
async def test_dash_proxy_refreshes_url_once_after_401_then_streams(client, monkeypatch):
    import app as app_module

    call_count = {"count": 0}
    cleared_cache_calls = {"count": 0}

    async def _fake_run_user_api_call(user_id, callback, operation):  # noqa: ARG001
        call_count["count"] += 1
        if call_count["count"] == 1:
            return {
                "is_dash": True,
                "urls": ["https://segment.example/stale-seg-401.m4s"],
                "content_type": "audio/mp4",
            }
        return {
            "is_dash": True,
            "urls": ["https://segment.example/fresh-seg-401.m4s"],
            "content_type": "audio/mp4",
        }

    stale_client = _FakeDashClient([_FakeDashSegmentResponse(401)])
    fresh_client = _FakeDashClient([_FakeDashSegmentResponse(200, [b"fresh-401-bytes"])])
    fake_clients = [stale_client, fresh_client]

    monkeypatch.setattr(app_module, "_run_user_api_call", _fake_run_user_api_call)
    monkeypatch.setattr(app_module, "_normalize_stream_quality", lambda q: q)
    monkeypatch.setattr(
        app_module,
        "_clear_stream_cache",
        lambda *args, **kwargs: cleared_cache_calls.__setitem__(
            "count",
            cleared_cache_calls["count"] + 1,
        ),
    )
    monkeypatch.setattr(
        app_module,
        "build_stream_proxy_client",
        lambda: fake_clients.pop(0),
    )

    response = await client.get(
        "/user/stream/12345",
        params={"user_id": "user-1", "quality": "HI_RES_LOSSLESS"},
    )

    assert response.status_code == 200
    assert response.content == b"fresh-401-bytes"
    assert call_count["count"] == 2
    assert cleared_cache_calls["count"] == 1
    assert stale_client.sent_urls == ["https://segment.example/stale-seg-401.m4s"]
    assert fresh_client.sent_urls == ["https://segment.example/fresh-seg-401.m4s"]
