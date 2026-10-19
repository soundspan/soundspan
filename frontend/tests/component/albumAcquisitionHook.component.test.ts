import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toast } from "sonner";
import type { Album } from "../../features/album/types";

GlobalRegistrator.register({ url: "http://localhost/album/album-1" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MATCHED = "8e8a6f1c-0000-4000-8000-000000000002";
const downloadCalls: string[][] = [];
const pendingCalls: string[][] = [];
const toastErrors: string[] = [];

// sonner ships separate CJS and ESM builds, so `mock.module("sonner")` can miss
// the copy the hook loads. Patch the shared `toast` object instead.
for (const kind of ["loading", "success", "info"] as const) {
    mock.method(toast, kind, () => undefined);
}
mock.method(toast, "error", (message: string) => {
    toastErrors.push(message);
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            downloadAlbum: async (
                artistName: string,
                albumTitle: string,
                mbid: string,
            ) => {
                downloadCalls.push([artistName, albumTitle, mbid]);
            },
        },
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            addPendingDownload: (kind: string, title: string, mbid: string) => {
                pendingCalls.push([kind, title, mbid]);
            },
            isPendingByMbid: () => false,
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
    downloadCalls.length = 0;
    pendingCalls.length = 0;
    toastErrors.length = 0;
});

type AcquireAlbum = ReturnType<
    typeof import("../../features/album/hooks/useAlbumAcquisition").useAlbumAcquisition
>;

async function mountHook(): Promise<{
    acquire: AcquireAlbum;
    unmount: () => Promise<void>;
}> {
    const { useAlbumAcquisition } =
        await import("../../features/album/hooks/useAlbumAcquisition");
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: AcquireAlbum | null } = { current: null };

    function Probe() {
        latestRef.current = useAlbumAcquisition();
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Probe)));
    assert.ok(latestRef.current, "hook did not render");
    return {
        acquire: latestRef.current,
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

test("a streaming-only album downloads its MusicBrainz match", async () => {
    const harness = await mountHook();
    await harness.acquire(matchedPlaceholder);
    assert.deepEqual(downloadCalls, [["Artist", "Album", MATCHED]]);
    assert.deepEqual(pendingCalls, [["album", "Album", MATCHED]]);
    await harness.unmount();
});

test("a match the library already holds is not downloaded again", async () => {
    const harness = await mountHook();
    await harness.acquire({ ...matchedPlaceholder, matchedInLibrary: true });
    assert.deepEqual(downloadCalls, []);
    assert.deepEqual(pendingCalls, []);
    assert.deepEqual(toastErrors, ["Album MBID not available"]);
    await harness.unmount();
});
