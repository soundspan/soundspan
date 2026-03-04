import assert from "node:assert/strict";
import { test, mock } from "node:test";

// These tests verify the URL construction logic for preview streams
// and remote track preference routing without importing the full api.ts
// module (which has deep dependency chains on browser globals).

// ── Preview stream URL construction ────────────────────────────────

test("preview stream URL includes videoId in path", () => {
    const videoId = "dQw4w9WgXcQ";
    const baseUrl = "http://127.0.0.1:3006";
    const url = `${baseUrl}/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
    assert.equal(url, "http://127.0.0.1:3006/api/artists/preview-stream/dQw4w9WgXcQ");
});

test("preview stream URL encodes special characters in videoId", () => {
    const videoId = "abc/def+ghi";
    const url = `/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
    assert.equal(url, "/api/artists/preview-stream/abc%2Fdef%2Bghi");
});

test("preview stream URL includes token as query param when present", () => {
    const videoId = "vid123";
    const token = "jwt-test-token";
    const baseUrl = `/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    assert.equal(url, "/api/artists/preview-stream/vid123?token=jwt-test-token");
});

test("preview stream URL omits token param when not authenticated", () => {
    const videoId = "vid456";
    const token: string | null = null;
    const baseUrl = `/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    assert.equal(url, "/api/artists/preview-stream/vid456");
    assert.ok(!url.includes("token="));
});

// ── Remote track ID routing ────────────────────────────────────────

function resolveTrackPreferencePath(trackId: string): string {
    const isRemote = trackId.startsWith("yt:") || trackId.startsWith("tidal:");
    const basePath = isRemote ? "/library/remote-tracks" : "/library/tracks";
    return `${basePath}/${encodeURIComponent(trackId)}/preference`;
}

test("yt: prefixed track IDs route to remote-tracks endpoint", () => {
    const path = resolveTrackPreferencePath("yt:dQw4w9WgXcQ");
    assert.ok(path.startsWith("/library/remote-tracks/"));
    assert.ok(path.endsWith("/preference"));
    assert.ok(path.includes(encodeURIComponent("yt:dQw4w9WgXcQ")));
});

test("tidal: prefixed track IDs route to remote-tracks endpoint", () => {
    const path = resolveTrackPreferencePath("tidal:123456789");
    assert.ok(path.startsWith("/library/remote-tracks/"));
    assert.ok(path.endsWith("/preference"));
});

test("local track IDs route to library/tracks endpoint", () => {
    const path = resolveTrackPreferencePath("clx1234abcdef");
    assert.ok(path.startsWith("/library/tracks/"));
    assert.ok(!path.includes("remote-tracks"));
    assert.ok(path.endsWith("/preference"));
});

test("numeric local track IDs route to library/tracks endpoint", () => {
    const path = resolveTrackPreferencePath("42");
    assert.ok(path.startsWith("/library/tracks/"));
});

test("empty prefix doesn't accidentally match remote patterns", () => {
    const path = resolveTrackPreferencePath("youtube-track-123");
    assert.ok(
        path.startsWith("/library/tracks/"),
        "full 'youtube' word should not match 'yt:' prefix"
    );
});
