import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiState: {
    downloadArtist: (name: string, mbid: string) => Promise<unknown>;
    downloadAlbum: (
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
    ) => Promise<unknown>;
} = {
    downloadArtist: async () => ({ id: "job-1", status: "pending" }),
    downloadAlbum: async () => ({ id: "job-2", status: "pending" }),
};

const contextCalls: {
    added: Array<{ type: string; subject: string; mbid: string }>;
    removedByMbid: string[];
    pendingMbids: Set<string>;
} = { added: [], removedByMbid: [], pendingMbids: new Set() };

mock.module("@/lib/api", {
    namedExports: {
        api: {
            downloadArtist: (name: string, mbid: string) =>
                apiState.downloadArtist(name, mbid),
            downloadAlbum: (
                artistName: string,
                albumTitle: string,
                rgMbid?: string,
            ) => apiState.downloadAlbum(artistName, albumTitle, rgMbid),
        },
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            loading: () => undefined,
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
        },
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            addPendingDownload: (
                type: string,
                subject: string,
                mbid: string,
            ) => {
                contextCalls.added.push({ type, subject, mbid });
                return "pending-id";
            },
            removePendingByMbid: (mbid: string) => {
                contextCalls.removedByMbid.push(mbid);
            },
            isPendingByMbid: (mbid: string) =>
                contextCalls.pendingMbids.has(mbid),
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
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
    apiState.downloadArtist = async () => ({ id: "job-1", status: "pending" });
    apiState.downloadAlbum = async () => ({ id: "job-2", status: "pending" });
    contextCalls.added.length = 0;
    contextCalls.removedByMbid.length = 0;
    contextCalls.pendingMbids.clear();
});

type DownloadArtistFn = (
    artist: { name: string; mbid: string } | null,
) => Promise<void>;
type DownloadAlbumFn = (
    album: { title: string; rgMbid?: string; mbid?: string },
    artistName: string,
    e: { preventDefault: () => void; stopPropagation: () => void },
) => Promise<void>;

interface CapturedActions {
    downloadArtist: DownloadArtistFn;
    downloadAlbum: DownloadAlbumFn;
}

async function renderDownloadActions(): Promise<CapturedActions> {
    const { useDownloadActions } =
        await import("../../features/artist/hooks/useDownloadActions");
    const { createRoot } = await import("react-dom/client");

    let captured: CapturedActions | null = null;
    function Harness() {
        captured = useDownloadActions() as unknown as CapturedActions;
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    await React.act(async () => {
        createRoot(container).render(React.createElement(Harness));
    });
    assert.ok(captured, "download actions were not captured");
    return captured!;
}

const clickEvent = {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
};

test("downloadArtist clears the pending entry when the request fails", async () => {
    apiState.downloadArtist = async () => {
        throw new Error("Request timed out after 15000ms");
    };
    const { downloadArtist } = await renderDownloadActions();

    await React.act(async () => {
        await downloadArtist({ name: "Trace Adkins", mbid: "mbid-1" });
    });

    assert.deepEqual(contextCalls.removedByMbid, ["mbid-1"]);
});

test("downloadArtist keeps the pending entry on success", async () => {
    const { downloadArtist } = await renderDownloadActions();

    await React.act(async () => {
        await downloadArtist({ name: "Trace Adkins", mbid: "mbid-1" });
    });

    assert.deepEqual(contextCalls.removedByMbid, []);
    assert.deepEqual(contextCalls.added, [
        { type: "artist", subject: "Trace Adkins", mbid: "mbid-1" },
    ]);
});

test("downloadArtist short-circuits when the artist is already pending", async () => {
    contextCalls.pendingMbids.add("mbid-1");
    let apiCalled = false;
    apiState.downloadArtist = async () => {
        apiCalled = true;
        return { id: "job-1", status: "pending" };
    };
    const { downloadArtist } = await renderDownloadActions();

    await React.act(async () => {
        await downloadArtist({ name: "Trace Adkins", mbid: "mbid-1" });
    });

    assert.equal(apiCalled, false);
    assert.deepEqual(contextCalls.added, []);
});

test("downloadAlbum clears the pending entry when the request fails", async () => {
    apiState.downloadAlbum = async () => {
        throw new Error("Request timed out after 15000ms");
    };
    const { downloadAlbum } = await renderDownloadActions();

    await React.act(async () => {
        await downloadAlbum(
            { title: "Dreamin' Out Loud", rgMbid: "rg-1" },
            "Trace Adkins",
            clickEvent,
        );
    });

    assert.deepEqual(contextCalls.removedByMbid, ["rg-1"]);
});

test("downloadAlbum keeps the pending entry on success", async () => {
    const { downloadAlbum } = await renderDownloadActions();

    await React.act(async () => {
        await downloadAlbum(
            { title: "Dreamin' Out Loud", rgMbid: "rg-1" },
            "Trace Adkins",
            clickEvent,
        );
    });

    assert.deepEqual(contextCalls.removedByMbid, []);
    assert.deepEqual(contextCalls.added, [
        {
            type: "album",
            subject: "Trace Adkins - Dreamin' Out Loud",
            mbid: "rg-1",
        },
    ]);
});
