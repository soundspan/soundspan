import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

type EngineListener = () => void;

const engineState = {
    playing: false,
    playCalls: 0,
    pauseCalls: 0,
    listeners: new Map<string, Set<EngineListener>>(),
};

const playbackEngine = {
    play: () => {
        engineState.playCalls += 1;
        engineState.playing = true;
    },
    pause: () => {
        engineState.pauseCalls += 1;
        engineState.playing = false;
    },
    isPlaying: () => engineState.playing,
    on: (event: string, listener: EngineListener) => {
        const listeners = engineState.listeners.get(event) ?? new Set();
        listeners.add(listener);
        engineState.listeners.set(event, listeners);
    },
    off: (event: string, listener: EngineListener) => {
        engineState.listeners.get(event)?.delete(listener);
    },
};

const audioEngineExports = {
    createRuntimeAudioEngine: () => playbackEngine,
};

mock.module("@/lib/audio-engine", { namedExports: audioEngineExports });

const toast = Object.assign(() => undefined, { error: () => undefined });
mock.module("sonner", { namedExports: { toast } });

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTrackPreview: async () => ({ videoId: "v" }),
            getPreviewStreamUrl: () => "url",
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

class FakeAudio {
    static instances: FakeAudio[] = [];

    currentTime = 0;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pauseCalls = 0;
    playCalls = 0;
    src: string;

    constructor(src: string) {
        this.src = src;
        FakeAudio.instances.push(this);
    }

    play(): Promise<void> {
        this.playCalls += 1;
        return Promise.resolve();
    }

    pause(): void {
        this.pauseCalls += 1;
    }
}

Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    writable: true,
    value: FakeAudio,
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    engineState.playing = false;
    engineState.playCalls = 0;
    engineState.pauseCalls = 0;
    engineState.listeners.clear();
    FakeAudio.instances = [];
});

type PreviewPlayerApi = ReturnType<
    typeof import("../../features/discover/hooks/usePreviewPlayer").usePreviewPlayer
>;

type TrackPreviewApi = ReturnType<
    typeof import("../../hooks/useTrackPreview").useTrackPreview<{
        id: string;
        title: string;
    }>
>;

async function mountHook<T>(useHook: () => T) {
    const { createRoot } = await import("react-dom/client");
    const latestRef: { current: T | null } = { current: null };

    function Probe() {
        latestRef.current = useHook();
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
        act: async (fn: () => void | Promise<void>) => {
            await React.act(async () => {
                await fn();
            });
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function mountPreviewPlayer() {
    const { usePreviewPlayer } = await import(
        "../../features/discover/hooks/usePreviewPlayer"
    );
    return mountHook<PreviewPlayerApi>(usePreviewPlayer);
}

async function mountTrackPreview() {
    const { useTrackPreview } = await import("../../hooks/useTrackPreview");
    return mountHook<TrackPreviewApi>(() => useTrackPreview());
}

const clickEvent = {
    stopPropagation: () => undefined,
} as React.MouseEvent;

test("switching preview albums does not resume the paused main player", async () => {
    engineState.playing = true;
    const harness = await mountPreviewPlayer();

    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    assert.equal(engineState.pauseCalls, 1);
    assert.equal(engineState.playCalls, 0);

    await harness.act(() => harness.latest().handleTogglePreview("b", "url-b"));
    assert.equal(engineState.playCalls, 0);
    await harness.unmount();
});

test("switching back to an album reuses its intact cached audio", async () => {
    const harness = await mountPreviewPlayer();

    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    const firstAudio = FakeAudio.instances[0];
    await harness.act(() => harness.latest().handleTogglePreview("b", "url-b"));
    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));

    assert.equal(FakeAudio.instances.length, 2);
    assert.equal(FakeAudio.instances[0], firstAudio);
    assert.equal(firstAudio.src, "url-a");
    assert.equal(firstAudio.playCalls, 2);
    await harness.unmount();
});

test("preview end resumes the main player that it paused", async () => {
    engineState.playing = true;
    const harness = await mountPreviewPlayer();
    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    assert.equal(engineState.playCalls, 0);

    await harness.act(() => FakeAudio.instances[0].onended?.());
    assert.equal(engineState.playCalls, 1);
    await harness.unmount();
});

test("preview-player unmount pauses cached audio and resumes the main player", async () => {
    engineState.playing = true;
    const harness = await mountPreviewPlayer();
    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    await harness.act(() => harness.latest().handleTogglePreview("b", "url-b"));
    const [firstAudio, secondAudio] = FakeAudio.instances;
    const firstPauseCallsBeforeUnmount = firstAudio.pauseCalls;
    assert.equal(engineState.playCalls, 0);

    await harness.unmount();
    assert.equal(firstAudio.pauseCalls, firstPauseCallsBeforeUnmount + 1);
    assert.equal(secondAudio.pauseCalls, 1);
    assert.equal(engineState.playCalls, 1);
});

test("preview error resumes the main player and evicts the failed audio", async () => {
    engineState.playing = true;
    const harness = await mountPreviewPlayer();
    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    assert.equal(engineState.playCalls, 0);

    await harness.act(() => FakeAudio.instances[0].onerror?.());
    assert.equal(engineState.playCalls, 1);
    await harness.act(() => harness.latest().handleTogglePreview("a", "url-a"));
    assert.equal(FakeAudio.instances.length, 2);
    await harness.unmount();
});

test("track preview end resumes the main player that it paused", async () => {
    engineState.playing = true;
    const harness = await mountTrackPreview();
    await harness.act(() =>
        harness.latest().handlePreview(
            { id: "track-a", title: "Track A" },
            "Artist",
            clickEvent,
        )
    );
    assert.equal(engineState.playCalls, 0);

    await harness.act(() => FakeAudio.instances[0].onended?.());
    assert.equal(engineState.playCalls, 1);
    await harness.unmount();
});

test("track-preview unmount resumes the main player that it paused", async () => {
    engineState.playing = true;
    const harness = await mountTrackPreview();
    await harness.act(() =>
        harness.latest().handlePreview(
            { id: "track-a", title: "Track A" },
            "Artist",
            clickEvent,
        )
    );
    assert.equal(engineState.playCalls, 0);

    await harness.unmount();
    assert.equal(FakeAudio.instances[0].pauseCalls, 1);
    assert.equal(engineState.playCalls, 1);
});
