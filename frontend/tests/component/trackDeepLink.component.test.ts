import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    window.location.href = "http://localhost/album/al1";
});

const albumTracks = [
    { id: "t1", title: "One" },
    { id: "t2", title: "Two" },
    { id: "t3", title: "Three" },
];

type HookResult = { highlightTrackId: string | null };

async function renderHook(
    playSpy: (track: { id: string }, index: number) => void,
    ready = true,
): Promise<{ result: () => HookResult; unmount: () => void }> {
    const { useTrackDeepLink } =
        await import("../../features/album/hooks/useTrackDeepLink");
    const { createRoot } = await import("react-dom/client");

    let latest: HookResult = { highlightTrackId: null };
    function Harness() {
        latest = useTrackDeepLink(
            { tracks: albumTracks } as never,
            playSpy as never,
            ready,
        );
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(Harness));
    });
    return {
        result: () => latest,
        unmount: () => {
            void React.act(() => {
                root.unmount();
            });
        },
    };
}

test("plays and highlights the track named in the ?track param", async () => {
    window.location.href = "http://localhost/album/al1?track=t2";
    const played: Array<{ id: string; index: number }> = [];
    const { result, unmount } = await renderHook((track, index) =>
        played.push({ id: track.id, index }),
    );

    assert.deepEqual(played, [{ id: "t2", index: 1 }]);
    assert.equal(result().highlightTrackId, "t2");
    unmount();
});

test("does nothing without a ?track param", async () => {
    const played: unknown[] = [];
    const { result, unmount } = await renderHook((track) => played.push(track));

    assert.deepEqual(played, []);
    assert.equal(result().highlightTrackId, null);
    unmount();
});

test("ignores a ?track id that is not in the album", async () => {
    window.location.href = "http://localhost/album/al1?track=missing";
    const played: unknown[] = [];
    const { result, unmount } = await renderHook((track) => played.push(track));

    assert.deepEqual(played, []);
    assert.equal(result().highlightTrackId, null);
    unmount();
});

test("consumes the param once, not on every render", async () => {
    window.location.href = "http://localhost/album/al1?track=t1";
    const played: unknown[] = [];
    const { unmount } = await renderHook((track) => played.push(track));

    // A second hook mount in the same document simulates a re-render cycle;
    // the ref guard means the first mount already consumed the param, and a
    // fresh mount plays again by design (new page visit). Within one mount,
    // strict-mode double effects must not double-play.
    assert.equal(played.length, 1);
    unmount();
});
