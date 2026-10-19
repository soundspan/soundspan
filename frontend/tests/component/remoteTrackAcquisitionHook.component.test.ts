import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { toast } from "sonner";
import { hasApiErrorStatus } from "../../lib/api/core";

GlobalRegistrator.register({ url: "http://localhost/library" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ToastCall = { kind: string; message: string; description?: string };

const toastCalls: ToastCall[] = [];
const tidalCalls: number[] = [];
let tidalResult: () => Promise<unknown> = async () => ({ status: "queued" });

function recordToast(kind: string) {
    return (message: string, options?: { description?: string }) => {
        toastCalls.push({ kind, message, description: options?.description });
    };
}

function apiError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

// sonner ships separate CJS and ESM builds, so `mock.module("sonner")` can miss
// the copy the hook loads. Patch the shared `toast` object instead.
for (const kind of ["loading", "success", "info", "error"] as const) {
    mock.method(toast, kind, recordToast(kind));
}

mock.module("@/lib/api", {
    namedExports: {
        hasApiErrorStatus,
        api: {
            downloadTidalTrack: async (tidalTrackId: number) => {
                tidalCalls.push(tidalTrackId);
                return tidalResult();
            },
            downloadYouTube: async () => ({ status: "queued" }),
        },
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            downloadsEnabled: true,
            tidalDownloadsEnabled: true,
        }),
    },
});

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useCreateMusicRequest: () => ({ mutateAsync: async () => undefined }),
        useRequestsGate: () => ({ requestsEnabled: false }),
    },
});

mock.module("@/features/album/hooks/useAlbumAcquisition", {
    namedExports: { useStartAlbumDownload: () => async () => undefined },
});

mock.module("@/features/album/hooks/useAlbumRequest", {
    namedExports: { submitAlbumRequest: async () => undefined },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    toastCalls.length = 0;
    tidalCalls.length = 0;
    tidalResult = async () => ({ status: "queued" });
});

type HookApi = ReturnType<
    typeof import("../../features/library/hooks/useRemoteTrackAcquisition").useRemoteTrackAcquisition
>;

async function mountHook(): Promise<{
    latest: () => HookApi;
    unmount: () => Promise<void>;
}> {
    const { useRemoteTrackAcquisition } =
        await import("../../features/library/hooks/useRemoteTrackAcquisition");
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: HookApi | null } = { current: null };

    function Probe() {
        latestRef.current = useRemoteTrackAcquisition();
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

async function acquireTidal(harness: { latest: () => HookApi }) {
    await harness.latest().acquire({
        kind: "download-tidal",
        tidalTrackId: 42,
        title: "Song",
    });
}

test("the policy carries the TIDAL download flag from the download context", async () => {
    const harness = await mountHook();
    assert.deepEqual(harness.latest().policy, {
        downloadsEnabled: true,
        tidalDownloadsEnabled: true,
        requestsEnabled: false,
    });
    await harness.unmount();
});

test("a queued TIDAL song downloads by id and says it joins the library", async () => {
    const harness = await mountHook();
    await acquireTidal(harness);
    assert.deepEqual(tidalCalls, [42]);
    assert.deepEqual(toastCalls, [
        {
            kind: "success",
            message: 'Downloading "Song"',
            description: "It joins your library when it finishes.",
        },
    ]);
    await harness.unmount();
});

test("a TIDAL song that is already queued says so", async () => {
    tidalResult = async () => ({ tidalTrackId: 42, status: "already-queued" });
    const harness = await mountHook();
    await acquireTidal(harness);
    assert.equal(toastCalls[0]?.message, 'Already downloading "Song"');
    await harness.unmount();
});

test("a full queue or unavailable TIDAL shows the server's explanation", async () => {
    for (const status of [429, 503]) {
        toastCalls.length = 0;
        tidalResult = async () => {
            throw apiError(status, `server says ${status}`);
        };
        const harness = await mountHook();
        await acquireTidal(harness);
        assert.deepEqual(toastCalls, [
            {
                kind: "error",
                message: "Failed to start the download",
                description: `server says ${status}`,
            },
        ]);
        await harness.unmount();
    }
});

test("other failures show the song title instead of the server message", async () => {
    tidalResult = async () => {
        throw apiError(500, "Failed to queue TIDAL track download");
    };
    const harness = await mountHook();
    await acquireTidal(harness);
    assert.equal(toastCalls[0]?.kind, "error");
    assert.equal(toastCalls[0]?.description, "Song");
    await harness.unmount();
});
