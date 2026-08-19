import assert from "node:assert/strict";
import { after, beforeEach, mock, test, type TestContext } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { USER_SETTINGS_UPDATED_EVENT } from "../../lib/userSettingsEvents";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let settingsFailures = 0;
let featuresFailures = 0;
let currentMode = "auto";
let currentTarget = -18;
let deferSettings = false;
let settingsResolvers: Array<() => void> = [];

const getSettings = mock.fn(() => {
    if (settingsFailures > 0) {
        settingsFailures -= 1;
        return Promise.reject(new Error("settings down"));
    }
    if (!deferSettings) return Promise.resolve({ loudnessMode: currentMode });
    return new Promise((resolve) => {
        const mode = currentMode;
        settingsResolvers.push(() => resolve({ loudnessMode: mode }));
    });
});
const getFeatures = mock.fn(async () => {
    if (featuresFailures > 0) {
        featuresFailures -= 1;
        throw new Error("features down");
    }
    return { loudnessTargetLufs: currentTarget };
});

mock.module("@/lib/api", {
    namedExports: { api: { getSettings, getFeatures } },
});

interface ProbeTrack {
    id: string;
    loudnessLufs: number | null;
    truePeakDb: number | null;
}

const audioState: {
    currentTrack: ProbeTrack | null;
    playbackType: string;
    queue: unknown[];
    isShuffle: boolean;
} = {
    currentTrack: null,
    playbackType: "track",
    queue: [],
    isShuffle: false,
};

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({ ...audioState }),
    },
});

type UseLoudnessNormalization =
    (typeof import("../../components/player/hooks/useLoudnessNormalization"))["useLoudnessNormalization"];

let useLoudnessNormalizationHook: UseLoudnessNormalization | null = null;

const gainRef = { current: 1 };
const applyCalls: number[] = [];
const applyCurrentOutputState = () => {
    applyCalls.push(gainRef.current);
};

function Probe(): null {
    assert.ok(useLoudnessNormalizationHook, "hook not loaded");
    useLoudnessNormalizationHook({
        loudnessGainFactorRef: gainRef,
        applyCurrentOutputState,
    });
    return null;
}

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    settingsFailures = 0;
    featuresFailures = 0;
    deferSettings = false;
    settingsResolvers = [];
    currentMode = "auto";
    currentTarget = -18;
    gainRef.current = 1;
    applyCalls.length = 0;
    getSettings.mock.resetCalls();
    getFeatures.mock.resetCalls();
    audioState.currentTrack = null;
    audioState.playbackType = "track";
    audioState.queue = [];
    audioState.isShuffle = false;
    document.body.replaceChildren();
});

async function flushAsync() {
    for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
    }
}

async function mountProbe() {
    ({ useLoudnessNormalization: useLoudnessNormalizationHook } =
        await import("../../components/player/hooks/useLoudnessNormalization"));
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(Probe));
        await flushAsync();
    });
    return {
        rerender: async () => {
            await React.act(async () => {
                root.render(React.createElement(Probe));
                await Promise.resolve();
                await Promise.resolve();
            });
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

const LOUD_TRACK: ProbeTrack = {
    id: "track-loud",
    loudnessLufs: -8,
    truePeakDb: -1,
};
// -18 target minus -8 measured = -10 dB of attenuation.
const LOUD_TRACK_FACTOR = 10 ** (-10 / 20);

async function settleRamp(t: TestContext) {
    await React.act(async () => {
        t.mock.timers.tick(25 * 8);
        await flushAsync();
    });
}

test("a failed initial preference load retries and then applies gain", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    settingsFailures = 1;
    featuresFailures = 1;
    audioState.currentTrack = LOUD_TRACK;

    const mounted = await mountProbe();
    assert.equal(gainRef.current, 1);

    await React.act(async () => {
        t.mock.timers.tick(2_000);
        await flushAsync();
    });
    await settleRamp(t);
    assert.equal(getSettings.mock.callCount(), 2);
    assert.ok(Math.abs(gainRef.current - LOUD_TRACK_FACTOR) < 1e-9);

    await mounted.unmount();
});

test("a mid-track mode change ramps the gain instead of stepping", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;

    const mounted = await mountProbe();
    await settleRamp(t);
    assert.ok(Math.abs(gainRef.current - LOUD_TRACK_FACTOR) < 1e-9);
    const applied = applyCalls.length;

    currentMode = "off";
    await React.act(async () => {
        window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        await flushAsync();
    });
    // The transition back to unity runs through interval steps.
    await React.act(async () => {
        t.mock.timers.tick(25 * 8);
        await flushAsync();
    });
    const rampSteps = applyCalls.slice(applied);
    assert.equal(rampSteps.length, 8);
    for (let index = 1; index < rampSteps.length; index += 1) {
        assert.ok(rampSteps[index] > rampSteps[index - 1]);
    }
    assert.equal(gainRef.current, 1);

    await mounted.unmount();
});

test("a track change applies the new gain immediately with no ramp", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;

    const mounted = await mountProbe();
    await settleRamp(t);
    const applied = applyCalls.length;

    audioState.currentTrack = {
        id: "track-quiet",
        loudnessLufs: -18,
        truePeakDb: -6,
    };
    await mounted.rerender();
    assert.equal(applyCalls.length, applied + 1);
    assert.equal(gainRef.current, 1);

    await React.act(async () => {
        t.mock.timers.tick(1_000);
        await flushAsync();
    });
    assert.equal(applyCalls.length, applied + 1);

    await mounted.unmount();
});

test("a settings-event reload ignores the superseded in-flight response", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;
    deferSettings = true;

    const mounted = await mountProbe();
    assert.equal(settingsResolvers.length, 1);
    assert.equal(gainRef.current, 1);

    // The user saves mode=off before the initial (auto) response arrives.
    currentMode = "off";
    await React.act(async () => {
        window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        await flushAsync();
    });
    // Serialization: the reload's fetch must not start while the stale
    // request is still pending (GET coalescing would reuse its response).
    assert.equal(getSettings.mock.callCount(), 1);

    // The stale auto response settles first and must be IGNORED before the
    // fresh response arrives (a last-writer-wins loader fails here).
    await React.act(async () => {
        settingsResolvers[0]?.();
        await flushAsync();
    });
    await settleRamp(t);
    assert.equal(gainRef.current, 1);
    assert.equal(getSettings.mock.callCount(), 2);
    await React.act(async () => {
        settingsResolvers[1]?.();
        await flushAsync();
    });
    await settleRamp(t);
    assert.equal(gainRef.current, 1);

    await mounted.unmount();
});

test("a reload cancels the previous generation's pending retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;
    settingsFailures = 1;

    const mounted = await mountProbe();
    assert.equal(getSettings.mock.callCount(), 1);

    // Reload succeeds before the failed generation's 2s retry fires.
    await React.act(async () => {
        window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        await flushAsync();
    });
    assert.equal(getSettings.mock.callCount(), 2);

    await React.act(async () => {
        t.mock.timers.tick(20_000);
        await flushAsync();
    });
    // No zombie retry from the superseded generation.
    assert.equal(getSettings.mock.callCount(), 2);

    await mounted.unmount();
});

test("unmount cancels pending retries entirely", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;
    settingsFailures = 4;

    const mounted = await mountProbe();
    assert.equal(getSettings.mock.callCount(), 1);
    await mounted.unmount();

    await React.act(async () => {
        t.mock.timers.tick(60_000);
        await flushAsync();
    });
    assert.equal(getSettings.mock.callCount(), 1);
});

test("queued obsolete generations never fetch after disposal", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;
    deferSettings = true;

    const mounted = await mountProbe();
    assert.equal(getSettings.mock.callCount(), 1);

    // Two reloads queue behind the pending initial request, then the hook
    // unmounts. Releasing the initial response must not trigger the queued
    // generations' fetches.
    await React.act(async () => {
        window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        await flushAsync();
    });
    await mounted.unmount();
    await React.act(async () => {
        settingsResolvers[0]?.();
        await flushAsync();
        await flushAsync();
    });
    assert.equal(getSettings.mock.callCount(), 1);
});

test("a reload burst coalesces into a single queued fetch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    audioState.currentTrack = LOUD_TRACK;
    deferSettings = true;

    const mounted = await mountProbe();
    assert.equal(getSettings.mock.callCount(), 1);

    currentMode = "off";
    await React.act(async () => {
        for (let index = 0; index < 50; index += 1) {
            window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
        }
        await flushAsync();
    });
    assert.equal(getSettings.mock.callCount(), 1);

    await React.act(async () => {
        settingsResolvers[0]?.();
        await flushAsync();
    });
    // Fifty reloads produced exactly one follow-up fetch.
    assert.equal(getSettings.mock.callCount(), 2);
    await React.act(async () => {
        settingsResolvers[1]?.();
        await flushAsync();
    });
    await settleRamp(t);
    assert.equal(gainRef.current, 1);

    await mounted.unmount();
});
