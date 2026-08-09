import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const apiStub = new Proxy(
    {},
    { get: () => async () => null },
) as Record<string, unknown>;
if (typeof mock.module === "function") {
    mock.module("@/lib/api", { namedExports: { api: apiStub } });
}

type EngineTickFn = (time: number, invocationTrackId?: string | null) => void;

let cleanup: (() => Promise<void>) | null = null;

after(async () => {
    if (cleanup) await cleanup();
    GlobalRegistrator.unregister();
});

test("progress ticks update snapshots without re-rendering status consumers", async () => {
    localStorage.clear();
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } = await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, usePlaybackStatus } =
        await import("../../lib/audio-playback-context");
    const { PlaybackProgressSnapshot } =
        await import("../../components/player/PlaybackProgressSnapshot");
    const snapshotRef = { current: -1 };
    const snapshotTrackIdRef = { current: null as string | null };
    const currentTrackRef = {
        current: { id: "track-1" } as { id: string } | null,
    };
    const engineTickRef = { current: null as EngineTickFn | null };
    let statusRenders = 0;
    const StatusProbe = () => {
        engineTickRef.current = usePlaybackStatus().setCurrentTimeFromEngine;
        statusRenders += 1;
        return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = async () => {
        await React.act(async () => root.unmount());
        container.remove();
    };
    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement(
                    AudioPlaybackProvider,
                    null,
                    React.createElement(StatusProbe),
                    React.createElement(PlaybackProgressSnapshot, {
                        snapshotRef,
                        snapshotTrackIdRef,
                        currentTrackRef: currentTrackRef as never,
                        playbackType: "track",
                    }),
                ),
            ),
        );
    });
    assert.equal(statusRenders, 1);
    assert.equal(container.childElementCount, 0);
    assert.ok(engineTickRef.current);
    await React.act(async () => engineTickRef.current!(5, "track-1"));
    assert.equal(snapshotRef.current, 5);
    assert.equal(snapshotTrackIdRef.current, "track-1");
    await React.act(async () => engineTickRef.current!(9, "track-1"));
    assert.equal(snapshotRef.current, 9);
    assert.equal(statusRenders, 1);
});
