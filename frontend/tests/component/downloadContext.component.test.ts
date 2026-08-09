import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const emptyDownloadStatus = {
    activeDownloads: [],
    recentDownloads: [],
    hasActiveDownloads: false,
    failedDownloads: [],
};

mock.module("@/hooks/useDownloadStatus", {
    namedExports: {
        useDownloadStatus: () => emptyDownloadStatus,
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            user: { role: "admin" },
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getDownloadAvailability: async () => ({ enabled: false }),
        },
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

type DownloadContextApi = ReturnType<
    typeof import("../../lib/download-context").useDownloadContext
>;

async function mountDownloadProvider(strictMode = false) {
    const { DownloadProvider, useDownloadContext } = await import(
        "../../lib/download-context"
    );
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: DownloadContextApi | null } = { current: null };

    function Probe() {
        latestRef.current = useDownloadContext();
        return null;
    }

    const provider = React.createElement(
        DownloadProvider,
        null,
        React.createElement(Probe)
    );
    const tree = strictMode
        ? React.createElement(React.StrictMode, null, provider)
        : provider;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => root.render(tree));

    return {
        latest: () => {
            assert.ok(latestRef.current, "context did not render");
            return latestRef.current;
        },
        act: async (fn: () => void) => {
            await React.act(async () => fn());
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("adding a pending download returns its id and synchronously rejects duplicates", async () => {
    const harness = await mountDownloadProvider();
    let firstId: string | null = null;
    await harness.act(() => {
        firstId = harness.latest().addPendingDownload("album", "Album", "mbid-1");
    });

    assert.equal(typeof firstId, "string");
    assert.equal(harness.latest().isPendingByMbid("mbid-1"), true);
    let duplicateId: string | null = "unexpected";
    await harness.act(() => {
        duplicateId = harness.latest().addPendingDownload(
            "album",
            "Album",
            "mbid-1"
        );
    });
    assert.equal(duplicateId, null);
    assert.equal(harness.latest().pendingDownloads.length, 1);
    await harness.unmount();
});

test("pending additions remain singular and usable under StrictMode", async () => {
    const harness = await mountDownloadProvider(true);
    await harness.act(() => {
        harness.latest().addPendingDownload("artist", "Artist One", "mbid-1");
    });
    assert.equal(harness.latest().pendingDownloads.length, 1);
    assert.equal(harness.latest().isPendingByMbid("mbid-1"), true);

    await harness.act(() => {
        harness.latest().addPendingDownload("artist", "Artist Two", "mbid-2");
    });
    assert.equal(harness.latest().pendingDownloads.length, 2);
    assert.equal(harness.latest().isPendingByMbid("mbid-2"), true);
    await harness.unmount();
});
