import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";
const SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC_KEY =
    "SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC";
const SEGMENTED_VHS_GOAL_BUFFER_SEC_KEY = "SEGMENTED_VHS_GOAL_BUFFER_SEC";
const SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC_KEY =
    "SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC";
const SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC_KEY =
    "SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC";
const SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC_KEY =
    "SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC";

type PlayerEventHandler = () => void;

type PlayerSourceConfig = {
    src?: string;
    type?: string;
};

type DashLiveDelaySettings = {
    streaming?: {
        delay?: {
            liveDelay?: number;
        };
    };
};

type XhrRequestConfig = Record<string, unknown>;

type XhrResponseHookRequest = {
    uri?: string;
    requestType?: string;
    statusCode?: number;
    requestTime?: number;
    roundTripTime?: number;
    bytesReceived?: number;
    bandwidth?: number;
};

type XhrResponseHookResponse = {
    statusCode?: number;
    headers?: Record<string, string>;
};

type TestState = {
    isLive: boolean;
    playlistMode: "auto" | "live" | "vod" | "unknown";
    hasDashJsRuntime: boolean;
    durationSec: number;
    sourceCalls: PlayerSourceConfig[];
    updateSettingsCalls: DashLiveDelaySettings[];
    initOptions: Record<string, unknown> | null;
    clientMetricPayloads: Array<Record<string, unknown>>;
    srcRequestHookCounts: number[];
};

const state: TestState = {
    isLive: false,
    playlistMode: "auto",
    hasDashJsRuntime: false,
    durationSec: 245,
    sourceCalls: [],
    updateSettingsCalls: [],
    initOptions: null,
    clientMetricPayloads: [],
    srcRequestHookCounts: [],
};

const createMockQualityLevelList = (
    levels: Array<{ id: string; enabled: boolean }>,
): Record<number | string, unknown> => {
    const handlers = new Map<string, Set<() => void>>();
    const list: Record<number | string, unknown> = {
        length: levels.length,
        selectedIndex: levels.length > 0 ? 0 : -1,
        on: (event: string, callback: () => void) => {
            let listeners = handlers.get(event);
            if (!listeners) {
                listeners = new Set();
                handlers.set(event, listeners);
            }
            listeners.add(callback);
        },
        off: (event: string, callback: () => void) => {
            handlers.get(event)?.delete(callback);
        },
    };

    levels.forEach((level, index) => {
        list[index] = level;
    });

    return list;
};

let activeQualityLevelList: Record<number | string, unknown> | null = null;

const vhsGlobal = {
    GOAL_BUFFER_LENGTH: 30,
    MAX_GOAL_BUFFER_LENGTH: 60,
    BUFFER_LOW_WATER_LINE: 0,
    MAX_BUFFER_LOW_WATER_LINE: 30,
};

class MockVideoJsPlayer {
    private readonly handlers = new Map<string, Set<PlayerEventHandler>>();
    private currentTimeSec = 0;
    private volumeLevel = 1;
    private mutedState = false;
    private pausedState = true;
    private readonly techEventHandlers = new Map<string, Set<PlayerEventHandler>>();
    private readonly xhrRequestHooks = new Set<
        (config: XhrRequestConfig) => XhrRequestConfig
    >();
    private readonly xhrResponseHooks = new Set<
        (
            request: XhrResponseHookRequest,
            error: unknown,
            response: XhrResponseHookResponse,
        ) => void
    >();
    private readonly vhsXhr = {
        onRequest: (callback: (config: XhrRequestConfig) => XhrRequestConfig) => {
            this.xhrRequestHooks.add(callback);
        },
        onResponse: (
            callback: (
                request: XhrResponseHookRequest,
                error: unknown,
                response: XhrResponseHookResponse,
            ) => void,
        ) => {
            this.xhrResponseHooks.add(callback);
        },
        offRequest: (callback: (config: XhrRequestConfig) => XhrRequestConfig) => {
            this.xhrRequestHooks.delete(callback);
        },
        offResponse: (
            callback: (
                request: XhrResponseHookRequest,
                error: unknown,
                response: XhrResponseHookResponse,
            ) => void,
        ) => {
            this.xhrResponseHooks.delete(callback);
        },
    };
    private readonly dashMediaPlayer = {
        updateSettings: (settings: DashLiveDelaySettings) => {
            state.updateSettingsCalls.push(settings);
        },
    };

    ready(callback: () => void) {
        callback();
    }

    on(event: string, callback: PlayerEventHandler) {
        let listeners = this.handlers.get(event);
        if (!listeners) {
            listeners = new Set();
            this.handlers.set(event, listeners);
        }
        listeners.add(callback);
    }

    off(event: string, callback: PlayerEventHandler) {
        this.handlers.get(event)?.delete(callback);
    }

    trigger(event: string) {
        const listeners = this.handlers.get(event);
        if (!listeners) {
            return;
        }
        listeners.forEach((listener) => {
            listener();
        });
    }

    emitVhsResponse(
        request: XhrResponseHookRequest,
        error: unknown = null,
        response: XhrResponseHookResponse = {},
    ) {
        this.xhrResponseHooks.forEach((handler) => {
            handler(request, error, response);
        });
    }

    getRequestHookCount(): number {
        return this.xhrRequestHooks.size;
    }

    src(config: PlayerSourceConfig) {
        state.srcRequestHookCounts.push(this.xhrRequestHooks.size);
        state.sourceCalls.push(config);
    }

    load() {}

    play() {
        this.pausedState = false;
        return Promise.resolve();
    }

    pause() {
        this.pausedState = true;
    }

    currentTime(value?: number): number {
        if (typeof value === "number") {
            this.currentTimeSec = value;
        }
        return this.currentTimeSec;
    }

    duration(): number {
        return state.durationSec;
    }

    paused(): boolean {
        return this.pausedState;
    }

    ended(): boolean {
        return false;
    }

    volume(value?: number): number {
        if (typeof value === "number") {
            this.volumeLevel = value;
        }
        return this.volumeLevel;
    }

    muted(value?: boolean): boolean {
        if (typeof value === "boolean") {
            this.mutedState = value;
        }
        return this.mutedState;
    }

    audioOnlyMode() {
        return false;
    }

    audioPosterMode() {
        return false;
    }

    tech(_unsafe?: boolean) {
        return {
            on: (event: string, callback: PlayerEventHandler) => {
                let listeners = this.techEventHandlers.get(event);
                if (!listeners) {
                    listeners = new Set();
                    this.techEventHandlers.set(event, listeners);
                }
                listeners.add(callback);
            },
            off: (event: string, callback: PlayerEventHandler) => {
                this.techEventHandlers.get(event)?.delete(callback);
            },
            vhs: {
                xhr: this.vhsXhr,
                playlists: {
                    media: () => {
                        if (state.playlistMode === "unknown") {
                            return {};
                        }
                        if (state.playlistMode === "live") {
                            return { endList: false };
                        }
                        if (state.playlistMode === "vod") {
                            return { endList: true };
                        }
                        return {
                            endList: !state.isLive,
                        };
                    },
                },
            },
            dash: state.hasDashJsRuntime
                ? {
                    mediaPlayer: this.dashMediaPlayer,
                }
                : undefined,
        };
    }

    qualityLevels() {
        return activeQualityLevelList as
            | {
                  length: number;
                  selectedIndex?: number;
                  on: (event: string, callback: () => void) => void;
                  off?: (event: string, callback: () => void) => void;
              }
            | null;
    }

    error() {
        return null;
    }

    dispose() {}
}

const mockVideoJs = Object.assign(
    (_mediaElement: unknown, options?: Record<string, unknown>) => {
        state.initOptions = options ?? null;
        const player = new MockVideoJsPlayer();
        lastPlayer = player;
        return player;
    },
    {
        Vhs: vhsGlobal,
    }
);

mock.module("video.js", {
    defaultExport: mockVideoJs,
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            info: (_message: string, payload?: unknown) => {
                if (payload && typeof payload === "object") {
                    state.clientMetricPayloads.push(
                        payload as Record<string, unknown>,
                    );
                }
            },
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
        },
    },
});

let lastPlayer: MockVideoJsPlayer | null = null;
const globalScope = globalThis as typeof globalThis & {
    window?: unknown;
    document?: unknown;
};
let previousWindow: unknown;
let previousDocument: unknown;

beforeEach(() => {
    previousWindow = globalScope.window;
    previousDocument = globalScope.document;

    state.isLive = false;
    state.playlistMode = "auto";
    state.hasDashJsRuntime = false;
    state.durationSec = 245;
    state.sourceCalls = [];
    state.updateSettingsCalls = [];
    state.initOptions = null;
    state.clientMetricPayloads = [];
    state.srcRequestHookCounts = [];
    activeQualityLevelList = null;
    vhsGlobal.GOAL_BUFFER_LENGTH = 30;
    vhsGlobal.MAX_GOAL_BUFFER_LENGTH = 60;
    vhsGlobal.BUFFER_LOW_WATER_LINE = 0;
    vhsGlobal.MAX_BUFFER_LOW_WATER_LINE = 30;
    lastPlayer = null;

    const mediaElement = {
        preload: "",
        playsInline: false,
        controls: false,
        style: {} as Record<string, string>,
        crossOrigin: "",
        buffered: {
            length: 0,
            start: () => 0,
            end: () => 0,
        },
        parentElement: null as { removeChild: (node: unknown) => void } | null,
    };

    const body = {
        appendChild: (node: { parentElement?: unknown }) => {
            node.parentElement = body;
        },
        removeChild: (node: { parentElement?: unknown }) => {
            node.parentElement = null;
        },
    };

    globalScope.window = {
        location: {
            origin: "https://example.test",
        },
    };

    globalScope.document = {
        createElement: () => mediaElement,
        body,
    };
});

afterEach(() => {
    try {
        mock.timers.reset();
    } catch {
        // Ignore when timers are not mocked in a test.
    }

    if (typeof previousWindow === "undefined") {
        delete globalScope.window;
    } else {
        globalScope.window = previousWindow;
    }

    if (typeof previousDocument === "undefined") {
        delete globalScope.document;
    } else {
        globalScope.document = previousDocument;
    }
});

test("applies steady-state buffer controls immediately for DASH VOD", async () => {
    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/segment.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);

    lastPlayer?.trigger("loadedmetadata");

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 260);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 260);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 120);
    assert.equal(state.sourceCalls.length, 1);
    assert.equal(
        (
            state.initOptions?.html5 as {
                vhs?: unknown;
            }
        )?.vhs !== undefined,
        true,
    );

    engine.destroy();
});

test("reapplies steady-state controls when preset matches but VHS globals drift", async () => {
    state.isLive = true;
    state.durationSec = Number.POSITIVE_INFINITY;

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/live-a.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);

    vhsGlobal.GOAL_BUFFER_LENGTH = 99;
    vhsGlobal.MAX_GOAL_BUFFER_LENGTH = 99;
    vhsGlobal.BUFFER_LOW_WATER_LINE = 77;
    vhsGlobal.MAX_BUFFER_LOW_WATER_LINE = 77;

    engine.load({
        url: "https://example.test/audio/live-b.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 120);

    engine.destroy();
});

test("detaches request hooks before src transition and reattaches after load", async () => {
    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/hook-order-a.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(state.srcRequestHookCounts[0], 0);
    assert.equal(lastPlayer?.getRequestHookCount(), 1);

    engine.load({
        url: "https://example.test/audio/hook-order-b.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(state.srcRequestHookCounts[1], 0);
    assert.equal(lastPlayer?.getRequestHookCount(), 1);

    engine.destroy();
});

test("does not clear stale quality levels before new source quality list binds", async () => {
    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    const staleLevels = createMockQualityLevelList([
        { id: "stale-0", enabled: true },
    ]);
    const nextLevels = createMockQualityLevelList([
        { id: "next-0", enabled: false },
    ]);

    activeQualityLevelList = staleLevels;
    engine.load({
        url: "https://example.test/audio/stale-levels-a.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });
    lastPlayer?.trigger("loadedmetadata");

    (staleLevels[0] as { enabled: boolean }).enabled = false;

    activeQualityLevelList = nextLevels;
    engine.load({
        url: "https://example.test/audio/stale-levels-b.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal((staleLevels[0] as { enabled: boolean }).enabled, false);

    lastPlayer?.trigger("loadedmetadata");
    assert.equal((nextLevels[0] as { enabled: boolean }).enabled, true);

    engine.destroy();
});

test("emits manifeststall when DASH manifest succeeds without a segment response", async () => {
    mock.timers.enable();

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();
    const manifestStallEvents: Array<Record<string, unknown>> = [];
    const legacyManifestStallEvents: Array<Record<string, unknown>> = [];

    engine.on("manifeststall", (payload) => {
        manifestStallEvents.push(payload as unknown as Record<string, unknown>);
    });
    engine.on("manifest-stall", (payload) => {
        legacyManifestStallEvents.push(
            payload as unknown as Record<string, unknown>,
        );
    });

    engine.load({
        url: "https://example.test/audio/manifest-stall.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
        trackId: "manifest-stall-track",
        sessionId: "manifest-stall-session",
        sourceType: "local",
    });

    lastPlayer?.emitVhsResponse(
        {
            uri: "https://example.test/audio/manifest-stall.mpd?st=token",
            requestType: "manifest",
            statusCode: 200,
            roundTripTime: 22,
            bytesReceived: 1_024,
        },
        null,
        { statusCode: 200 },
    );

    mock.timers.tick(1_499);
    assert.equal(manifestStallEvents.length, 0);

    mock.timers.tick(1);
    assert.equal(manifestStallEvents.length, 1);
    assert.equal(legacyManifestStallEvents.length, 1);
    assert.equal(manifestStallEvents[0].reason, "playlist_refresh_timeout");
    assert.equal(manifestStallEvents[0].trackId, "manifest-stall-track");
    assert.equal(manifestStallEvents[0].sessionId, "manifest-stall-session");
    assert.equal(manifestStallEvents[0].manifestUri, "/audio/manifest-stall.mpd");

    const manifestStallMetrics = state.clientMetricPayloads.filter(
        (payload) => payload.event === "player.manifest_stall",
    );
    assert.equal(manifestStallMetrics.length, 1);
    assert.equal(
        manifestStallMetrics[0].reason,
        "playlist_refresh_timeout",
    );
    assert.equal(manifestStallMetrics[0].trackId, "manifest-stall-track");
    assert.equal(
        manifestStallMetrics[0].sessionId,
        "manifest-stall-session",
    );

    engine.destroy();
});

test("cancels manifeststall timer when the first segment response arrives", async () => {
    mock.timers.enable();

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();
    const manifestStallEvents: Array<Record<string, unknown>> = [];

    engine.on("manifeststall", (payload) => {
        manifestStallEvents.push(payload as unknown as Record<string, unknown>);
    });

    engine.load({
        url: "https://example.test/audio/no-stall.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
        trackId: "no-stall-track",
        sessionId: "no-stall-session",
        sourceType: "local",
    });

    lastPlayer?.emitVhsResponse(
        {
            uri: "https://example.test/audio/no-stall.mpd",
            requestType: "manifest",
            statusCode: 200,
        },
        null,
        { statusCode: 200 },
    );
    lastPlayer?.emitVhsResponse(
        {
            uri: "https://example.test/audio/chunk-0001.m4s",
            requestType: "segment",
            statusCode: 200,
            bytesReceived: 2_048,
        },
        null,
        { statusCode: 200 },
    );

    mock.timers.tick(2_000);
    assert.equal(manifestStallEvents.length, 0);
    assert.equal(
        state.clientMetricPayloads.some(
            (payload) => payload.event === "player.manifest_stall",
        ),
        false,
    );

    engine.destroy();
});

test("cancels manifeststall timer when source is reset before timeout", async () => {
    mock.timers.enable();

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();
    const manifestStallEvents: Array<Record<string, unknown>> = [];

    engine.on("manifeststall", (payload) => {
        manifestStallEvents.push(payload as unknown as Record<string, unknown>);
    });

    engine.load({
        url: "https://example.test/audio/source-reset-a.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
        trackId: "source-reset-a",
        sessionId: "source-reset-session-a",
        sourceType: "local",
    });

    lastPlayer?.emitVhsResponse(
        {
            uri: "https://example.test/audio/source-reset-a.mpd",
            requestType: "manifest",
            statusCode: 200,
        },
        null,
        { statusCode: 200 },
    );

    engine.load({
        url: "https://example.test/audio/direct-reset.mp3",
        mimeType: "audio/mpeg",
    });

    mock.timers.tick(2_000);
    assert.equal(manifestStallEvents.length, 0);
    assert.equal(
        state.clientMetricPayloads.some(
            (payload) => payload.event === "player.manifest_stall",
        ),
        false,
    );

    engine.destroy();
});

test("keeps steady-state controls for live DASH and applies dash.js liveDelay when available", async () => {
    state.isLive = true;
    state.hasDashJsRuntime = true;
    state.durationSec = Number.POSITIVE_INFINITY;

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/live.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);

    lastPlayer?.trigger("loadedmetadata");
    lastPlayer?.trigger("timeupdate");

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.deepEqual(state.updateSettingsCalls, [
        {
            streaming: {
                delay: {
                    liveDelay: 1.5,
                },
            },
        },
    ]);

    engine.destroy();
});

test("keeps steady-state controls for live DASH when dash.js runtime is unavailable", async () => {
    state.isLive = true;
    state.hasDashJsRuntime = false;
    state.durationSec = Number.POSITIVE_INFINITY;

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/live-no-dashjs.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    lastPlayer?.trigger("loadedmetadata");
    lastPlayer?.trigger("timeupdate");

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);
    assert.deepEqual(state.updateSettingsCalls, []);

    engine.destroy();
});

test("retains steady-state controls while DASH live/vod state becomes knowable", async () => {
    state.playlistMode = "unknown";
    state.durationSec = 0;

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/unknown-state.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    lastPlayer?.trigger("loadedmetadata");
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);

    state.durationSec = 180;
    lastPlayer?.trigger("durationchange");
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 195);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 195);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);

    engine.destroy();
});

test("keeps steady-state controls when DASH live/vod state remains unknown after startup progress", async () => {
    state.playlistMode = "unknown";
    state.durationSec = 0;

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/unknown-stuck-state.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    lastPlayer?.trigger("loadedmetadata");
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);

    lastPlayer?.currentTime(1.1);
    lastPlayer?.trigger("timeupdate");
    lastPlayer?.currentTime(1.6);
    lastPlayer?.trigger("timeupdate");
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);

    lastPlayer?.currentTime(2.2);
    lastPlayer?.trigger("timeupdate");
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 120);

    engine.destroy();
});

test("uses steady-state controls for DASH and keeps steady-state on non-DASH source load", async () => {
    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/live-start.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);

    engine.load({
        url: "https://example.test/audio/direct-track.mp3",
        mimeType: "audio/mpeg",
    });
    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 120);

    engine.destroy();
});

test("ignores runtime fragment duration for startup buffer controls", async () => {
    (
        globalScope.window as {
            [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
        }
    )[SOUNDSPAN_RUNTIME_CONFIG_KEY] = {
        [SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC_KEY]: 0.5,
    };

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/segment.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 180);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 600);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 15);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 120);

    engine.destroy();
});

test("keeps explicit runtime VHS buffer overrides for DASH VOD tuning", async () => {
    (
        globalScope.window as {
            [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
        }
    )[SOUNDSPAN_RUNTIME_CONFIG_KEY] = {
        [SEGMENTED_VHS_GOAL_BUFFER_SEC_KEY]: 90,
        [SEGMENTED_VHS_MAX_GOAL_BUFFER_SEC_KEY]: 120,
        [SEGMENTED_VHS_BUFFER_LOW_WATER_LINE_SEC_KEY]: 10,
        [SEGMENTED_VHS_MAX_BUFFER_LOW_WATER_LINE_SEC_KEY]: 20,
    };

    const { VideoJsSegmentedEngine } = await import(
        "../../lib/audio-engine/videoJsSegmentedEngine.ts"
    );
    const engine = new VideoJsSegmentedEngine();

    engine.load({
        url: "https://example.test/audio/runtime-overrides.mpd",
        protocol: "dash",
        mimeType: "application/dash+xml",
    });

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 90);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 120);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 10);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 20);

    lastPlayer?.trigger("loadedmetadata");

    assert.equal(vhsGlobal.GOAL_BUFFER_LENGTH, 90);
    assert.equal(vhsGlobal.MAX_GOAL_BUFFER_LENGTH, 120);
    assert.equal(vhsGlobal.BUFFER_LOW_WATER_LINE, 10);
    assert.equal(vhsGlobal.MAX_BUFFER_LOW_WATER_LINE, 20);

    engine.destroy();
});
