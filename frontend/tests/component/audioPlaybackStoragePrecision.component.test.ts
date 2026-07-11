import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behavioural pin for the F12 localStorage persistence path.
 *
 * The playback provider's throttled "save currentTime to localStorage" effect
 * must write the FULL-PRECISION engine clock (currentTimeRef), not the quantized
 * published state: AudioPlaybackOrchestrator reads that key
 * (`<brand>_current_time`) on initial track load to compute the engine's resume
 * startTime, so a quantized write regresses resume-after-reload precision from
 * ~250ms to ~1s.
 *
 * Mechanism exercised end-to-end with the REAL State+Playback providers under
 * happy-dom: two accepted engine ticks land in one act() batch — 1.02 crosses a
 * display-second boundary (published to state), 1.27 does not (ref-only). The
 * save effect then fires (triggered by the 1.02 publish) while the ref already
 * holds 1.27, so the stored value distinguishes ref (1.27, correct) from
 * published state (1.02, the regression).
 *
 * The effect's 5s wall-clock throttle is controlled with node:test's mocked
 * Date: at mount Date.now() is 0 so the mount-time run is throttled (writes
 * nothing), then the clock is advanced past the throttle before the ticks.
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

// Any api method resolves to null so mount-time playback-state hydration is a
// no-op. The audio contexts and the storage-migration module stay REAL.
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

test("localStorage resume snapshot stores the full-precision engine clock, not the quantized published value", async (t) => {
    // Date.now() = 0 at mount -> the save effect's mount run is throttled
    // (0 - 0 < 5000) and writes nothing.
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    localStorage.clear();

    const { createRoot } = await import("react-dom/client");
    const { AudioStateProvider } = await import("../../lib/audio-state-context");
    const { AudioPlaybackProvider, useAudioPlayback } = await import(
        "../../lib/audio-playback-context"
    );
    const { createMigratingStorageKey, readMigratingStorageItem } = await import(
        "../../lib/storage-migration"
    );
    const currentTimeKey = createMigratingStorageKey("current_time");

    type EngineTickFn = (time: number, invocationTrackId?: string | null) => void;
    // Ref-shaped mutation container: the react-hooks lint rule forbids
    // reassigning outer variables inside a component, but allows writes to the
    // `.current` field of *Ref-named values (house pattern, see
    // audioContextHookGuards.component.test.ts).
    const capturedEngineTickRef = { current: null as EngineTickFn | null };

    const Probe = () => {
        const playback = useAudioPlayback();
        capturedEngineTickRef.current = playback.setCurrentTimeFromEngine;
        return null;
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                AudioStateProvider,
                null,
                React.createElement(
                    AudioPlaybackProvider,
                    null,
                    React.createElement(Probe),
                ),
            ),
        );
    });
    // Flush mount effects + the mocked (immediately-resolving) api promises.
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.ok(
        capturedEngineTickRef.current,
        "expected the playback provider's engine-tick setter to be captured",
    );
    assert.equal(
        readMigratingStorageItem(currentTimeKey),
        null,
        "precondition: the throttled mount run must not have written the key",
    );

    // Open the 5s throttle, then land two accepted ticks in ONE batch:
    // 1.02 crosses the 0->1 display-second boundary (published), 1.27 stays in
    // the same displayed second (full-precision ref only). The save effect runs
    // after the batch with published state 1.02 but ref 1.27.
    t.mock.timers.tick(6000);
    await React.act(async () => {
        capturedEngineTickRef.current!(1.02, null);
        capturedEngineTickRef.current!(1.27, null);
    });

    assert.equal(
        readMigratingStorageItem(currentTimeKey),
        "1.27",
        "the resume snapshot must carry the full-precision engine clock (1.27), " +
            "not the quantized published state (1.02)",
    );

    await React.act(async () => {
        root.unmount();
    });
});
