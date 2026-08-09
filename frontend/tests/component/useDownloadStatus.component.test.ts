import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

type DownloadResponse = Array<{
    id: string;
    type: "artist" | "album";
    subject: string;
    targetMbid: string;
    status: "pending" | "processing" | "completed" | "failed";
    createdAt: string;
}>;

const apiState: {
    calls: number;
    getDownloads: () => Promise<DownloadResponse>;
} = {
    calls: 0,
    getDownloads: async () => [],
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getDownloads: async () => {
                apiState.calls += 1;
                return apiState.getDownloads();
            },
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({ error: () => undefined }),
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
    apiState.calls = 0;
    apiState.getDownloads = async () => [];
});

async function flushMicrotasks(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mountDownloadStatus() {
    const { useDownloadStatus } = await import("../../hooks/useDownloadStatus");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        useDownloadStatus(15_000, true);
        return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Probe)));
    await flushMicrotasks();

    return {
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function activeDownload(): DownloadResponse[number] {
    return {
        id: "job-1",
        type: "album",
        subject: "Album",
        targetMbid: "mbid-1",
        status: "processing",
        createdAt: new Date().toISOString(),
    };
}

test("download status events preserve exactly one polling chain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const harness = await mountDownloadStatus();
    t.after(harness.unmount);
    assert.equal(apiState.calls, 1);

    for (let eventCount = 0; eventCount < 3; eventCount += 1) {
        await React.act(async () => {
            window.dispatchEvent(new Event("download-status-changed"));
            t.mock.timers.tick(0);
            await Promise.resolve();
        });
    }
    assert.equal(apiState.calls, 4);

    await React.act(async () => {
        t.mock.timers.tick(30_000);
        await Promise.resolve();
    });
    assert.equal(apiState.calls, 5);
});

test("active downloads use five-second cadence before returning to idle cadence", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    apiState.getDownloads = async () => apiState.calls === 1 ? [activeDownload()] : [];
    const harness = await mountDownloadStatus();
    t.after(harness.unmount);

    t.mock.timers.tick(4_999);
    assert.equal(apiState.calls, 1);
    await React.act(async () => {
        t.mock.timers.tick(1);
        await Promise.resolve();
    });
    assert.equal(apiState.calls, 2);

    t.mock.timers.tick(29_999);
    assert.equal(apiState.calls, 2);
    await React.act(async () => {
        t.mock.timers.tick(1);
        await Promise.resolve();
    });
    assert.equal(apiState.calls, 3);
});

test("unmount clears download polling and its event listener", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const harness = await mountDownloadStatus();
    assert.equal(apiState.calls, 1);
    await harness.unmount();

    window.dispatchEvent(new Event("download-status-changed"));
    t.mock.timers.tick(10 * 60 * 1_000);
    await flushMicrotasks();
    assert.equal(apiState.calls, 1);
});

test("errors back off and a success resets polling to idle cadence", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    apiState.getDownloads = async () => {
        if (apiState.calls === 1) {
            throw new Error("network failure");
        }
        return [];
    };
    const harness = await mountDownloadStatus();
    t.after(harness.unmount);
    assert.equal(apiState.calls, 1);

    t.mock.timers.tick(29_999);
    assert.equal(apiState.calls, 1);
    await React.act(async () => {
        t.mock.timers.tick(1);
        await Promise.resolve();
    });
    assert.equal(apiState.calls, 2);

    t.mock.timers.tick(29_999);
    assert.equal(apiState.calls, 2);
    await React.act(async () => {
        t.mock.timers.tick(1);
        await Promise.resolve();
    });
    assert.equal(apiState.calls, 3);
});
