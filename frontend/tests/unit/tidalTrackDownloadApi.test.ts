import assert from "node:assert/strict";
import { test } from "node:test";

import { api } from "../../lib/api";

test("downloadTidalTrack posts the TIDAL id to the single-song download endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    let calledInit: RequestInit | undefined;

    globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        calledUrl = String(input);
        calledInit = init;
        return Response.json(
            { tidalTrackId: 42, status: "queued" },
            { status: 202 },
        );
    }) as typeof fetch;

    try {
        const result = await api.downloadTidalTrack(42);

        assert.equal(calledUrl.endsWith("/api/downloads/tidal-track"), true);
        assert.equal(calledInit?.method, "POST");
        assert.deepEqual(JSON.parse(String(calledInit?.body)), {
            tidalTrackId: 42,
        });
        assert.deepEqual(result, { tidalTrackId: 42, status: "queued" });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
