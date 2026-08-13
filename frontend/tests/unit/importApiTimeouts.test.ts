import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClientCore, IMPORT_PREVIEW_TIMEOUT_MS } from "@/lib/api/core";
import { WithImports } from "@/lib/api/imports";

// Import previews resolve every playlist entry against the library before
// responding, so they can legitimately outlive the default request timeout.
// These tests pin the extended-timeout contract for both preview endpoints.

interface RecordedCall {
    endpoint: string;
    timeoutMs: number | undefined;
}

class RecordingCore extends ApiClientCore {
    public readonly calls: RecordedCall[] = [];

    override async request<T>(
        endpoint: string,
        options: RequestInit & { timeoutMs?: number } = {},
    ): Promise<T> {
        this.calls.push({ endpoint, timeoutMs: options.timeoutMs });
        return {} as T;
    }
}

class ImportsClient extends WithImports(RecordingCore) {}

test("previewM3UImport uses the extended import-preview timeout", async () => {
    const client = new ImportsClient();
    await client.previewM3UImport("#EXTM3U\n/music/song.mp3", "My Mix");

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].endpoint, "/import/m3u/preview");
    assert.equal(client.calls[0].timeoutMs, IMPORT_PREVIEW_TIMEOUT_MS);
});

test("previewPlaylistImport uses the extended import-preview timeout", async () => {
    const client = new ImportsClient();
    await client.previewPlaylistImport("https://example.com/playlist/123");

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].endpoint, "/import/preview");
    assert.equal(client.calls[0].timeoutMs, IMPORT_PREVIEW_TIMEOUT_MS);
});
