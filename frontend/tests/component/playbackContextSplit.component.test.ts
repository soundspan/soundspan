/**
 * Guards the playback-context split so high-frequency clock updates re-render
 * progress and composite consumers without re-rendering status consumers.
 */

import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

// Any api method resolves to null so mount-time playback-state hydration is a
// no-op and cannot change the render counts under test.
const apiStub = new Proxy(
    {},
    { get: () => async () => null },
) as Record<string, unknown>;
mock.module("@/lib/api", { namedExports: { api: apiStub } });

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

type EngineTickFn = (time: number, invocationTrackId?: string | null) => void;

test("playback status consumers do not re-render on clock ticks after the context split", async () => {
    localStorage.clear();
    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } = await import("../../lib/audio-state-context");
    const {
        AudioPlaybackProvider,
        usePlaybackStatus,
        usePlaybackProgress,
        useAudioPlayback,
    } = await import("../../lib/audio-playback-context");

    const statusRendersRef = { current: 0 };
    const progressRendersRef = { current: 0 };
    const compositeRendersRef = { current: 0 };
    const capturedEngineTickRef = { current: null as EngineTickFn | null };

    const StatusProbe = () => {
        const status = usePlaybackStatus();
        void status.isPlaying;
        capturedEngineTickRef.current = status.setCurrentTimeFromEngine;
        statusRendersRef.current += 1;
        return null;
    };

    const ProgressProbe = () => {
        const progress = usePlaybackProgress();
        void progress.currentTime;
        progressRendersRef.current += 1;
        return null;
    };

    const CompositeProbe = () => {
        const composite = useAudioPlayback();
        void composite.currentTime;
        void composite.isPlaying;
        compositeRendersRef.current += 1;
        return null;
    };

    const tree = React.createElement(
        AudioStateProvider,
        null,
        React.createElement(
            AudioPlaybackProvider,
            null,
            React.createElement(StatusProbe),
            React.createElement(ProgressProbe),
            React.createElement(CompositeProbe),
        ),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(tree);
    });
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    const mountStatusRenders = statusRendersRef.current;
    const mountProgressRenders = progressRendersRef.current;
    const mountCompositeRenders = compositeRendersRef.current;
    assert.ok(
        capturedEngineTickRef.current,
        "expected the playback provider's engine-tick setter to be captured",
    );

    const ticks = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    for (const time of ticks) {
        await React.act(async () => {
            capturedEngineTickRef.current!(time, null);
        });
    }

    const tickStatusRenders = statusRendersRef.current - mountStatusRenders;
    const tickProgressRenders = progressRendersRef.current - mountProgressRenders;
    const tickCompositeRenders =
        compositeRendersRef.current - mountCompositeRenders;

    assert.equal(
        tickStatusRenders,
        0,
        `status consumers must render 0 times across 8 clock ticks (got ${tickStatusRenders})`,
    );
    assert.equal(
        tickProgressRenders,
        2,
        `progress consumers must render exactly at the 2 display-second boundaries (got ${tickProgressRenders})`,
    );
    assert.equal(
        tickCompositeRenders,
        2,
        `backward-compatible composite consumers must track the 2 clock publishes (got ${tickCompositeRenders})`,
    );

    await React.act(async () => {
        root.unmount();
    });
});
