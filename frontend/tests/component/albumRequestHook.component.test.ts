import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toast } from "sonner";
import type { Album } from "../../features/album/types";
import type { CreateMusicRequestInput } from "../../lib/api/requests";

GlobalRegistrator.register({ url: "http://localhost/album/album-1" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MATCHED = "8e8a6f1c-0000-4000-8000-000000000002";
const createdRequests: CreateMusicRequestInput[] = [];
let openRequestIds: string[] = [];

// sonner ships separate CJS and ESM builds, so `mock.module("sonner")` can miss
// the copy the hook loads. Patch the shared `toast` object instead.
for (const kind of ["loading", "success", "error"] as const) {
    mock.method(toast, kind, () => undefined);
}

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useRequestsGate: () => ({ requestsEnabled: true }),
        useMyOpenMusicRequests: () => ({
            data: openRequestIds.map((rgMbid) => ({
                rgMbid,
                status: "pending",
                downloadStatus: null,
            })),
        }),
        openRequestRgMbids: (rows: Array<{ rgMbid: string }> | undefined) =>
            new Set((rows ?? []).map((row) => row.rgMbid.toLowerCase())),
        useCreateMusicRequest: () => ({
            isPending: false,
            mutateAsync: async (input: CreateMusicRequestInput) => {
                createdRequests.push(input);
            },
        }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    createdRequests.length = 0;
    openRequestIds = [];
});

type HookApi = ReturnType<
    typeof import("../../features/album/hooks/useAlbumRequest").useAlbumRequest
>;

async function mountHook(album: Album): Promise<{
    latest: () => HookApi;
    unmount: () => Promise<void>;
}> {
    const { useAlbumRequest } =
        await import("../../features/album/hooks/useAlbumRequest");
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: HookApi | null } = { current: null };

    function Probe() {
        latestRef.current = useAlbumRequest(album);
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Probe)));
    return {
        latest: () => {
            assert.ok(latestRef.current, "hook did not render");
            return latestRef.current;
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

const matchedPlaceholder: Album = {
    id: "album-1",
    title: "Album",
    artist: { id: "artist-1", name: "Artist" },
    rgMbid: "remote:generated-hash",
    matchedRgMbid: MATCHED,
    source: "remote",
};

test("a streaming-only album is requested by its MusicBrainz match", async () => {
    const harness = await mountHook(matchedPlaceholder);
    await harness.latest().requestAlbum();
    assert.deepEqual(createdRequests, [
        { artistName: "Artist", albumTitle: "Album", rgMbid: MATCHED },
    ]);
    await harness.unmount();
});

test("an open request for the match marks the album as requested", async () => {
    openRequestIds = [MATCHED.toUpperCase()];
    const harness = await mountHook(matchedPlaceholder);
    assert.equal(harness.latest().isRequestedAlbum, true);
    assert.equal(harness.latest().requestState, "requested");
    await harness.unmount();
});

test("a match the library already holds is never requested", async () => {
    openRequestIds = [MATCHED];
    const harness = await mountHook({
        ...matchedPlaceholder,
        matchedInLibrary: true,
    });
    assert.equal(harness.latest().isRequestedAlbum, false);
    await harness.latest().requestAlbum();
    assert.deepEqual(createdRequests, []);
    await harness.unmount();
});

test("a streaming-only artist's placeholder id is never sent as the artist MBID", async () => {
    const harness = await mountHook({
        ...matchedPlaceholder,
        artist: { id: "artist-1", name: "Artist", mbid: "temp-remote-1" },
    });
    await harness.latest().requestAlbum();
    assert.deepEqual(createdRequests, [
        { artistName: "Artist", albumTitle: "Album", rgMbid: MATCHED },
    ]);
    await harness.unmount();
});

test("a real artist MBID is sent with the request", async () => {
    const artistMbid = "8e8a6f1c-0000-4000-8000-000000000009";
    const harness = await mountHook({
        ...matchedPlaceholder,
        artist: { id: "artist-1", name: "Artist", mbid: artistMbid },
    });
    await harness.latest().requestAlbum();
    assert.deepEqual(createdRequests, [
        {
            artistName: "Artist",
            albumTitle: "Album",
            rgMbid: MATCHED,
            artistMbid,
        },
    ]);
    await harness.unmount();
});
