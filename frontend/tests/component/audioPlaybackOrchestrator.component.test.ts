import assert from "node:assert/strict";
import {
    afterEach,
    before,
    beforeEach,
    mock,
    test,
} from "node:test";

type PlaybackType = "track" | "audiobook" | "podcast" | null;

type Track = {
    id: string;
    title: string;
    duration?: number;
    filePath?: string;
    streamSource?: "local" | "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    artist?: { name?: string };
    album?: { title?: string };
    displayTitle?: string;
    mediaSource?: unknown;
    provider?: {
        providerTrackId?: string;
        tidalTrackId?: number;
        youtubeVideoId?: string;
    };
};

type Podcast = {
    id: string;
    title?: string;
    podcastTitle?: string;
    duration?: number;
    progress?: { currentTime?: number };
};

type Audiobook = {
    id: string;
    duration?: number;
    progress?: { currentTime?: number };
};

type SegmentedSession = {
    sessionId: string;
    sessionToken: string;
    manifestUrl: string;
    expiresAt: string;
    playbackProfile?: {
        sourceType?: "local" | "tidal" | "ytmusic";
        codec?: string;
        bitrateKbps?: number;
    };
    engineHints?: {
        sourceType?: "local" | "tidal" | "ytmusic";
        assetBuildInFlight?: boolean;
    };
};

type HandoffSession = SegmentedSession & {
    resumeAtSec?: number;
    shouldPlay?: boolean;
};

class FakeAudioEngine {
    public readonly loadCalls: Array<{ args: unknown[] }> = [];
    public readonly onCalls: Array<{ event: string }> = [];
    public readonly offCalls: Array<{ event: string }> = [];
    public readonly seekCalls: number[] = [];
    public readonly setVolumeCalls: number[] = [];
    public readonly setMutedCalls: boolean[] = [];
    public readonly preloadCalls: Array<{ url: string; format: string }> = [];

    public playCalls = 0;
    public pauseCalls = 0;
    public stopCalls = 0;
    public reloadCalls = 0;

    public currentTime = 0;
    public actualCurrentTime = 0;
    public duration = 240;
    public playing = false;

    private handlers = new Map<string, Set<(payload?: unknown) => void>>();

    reset(): void {
        this.loadCalls.length = 0;
        this.onCalls.length = 0;
        this.offCalls.length = 0;
        this.seekCalls.length = 0;
        this.setVolumeCalls.length = 0;
        this.setMutedCalls.length = 0;
        this.preloadCalls.length = 0;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.stopCalls = 0;
        this.reloadCalls = 0;
        this.currentTime = 0;
        this.actualCurrentTime = 0;
        this.duration = 240;
        this.playing = false;
        this.handlers.clear();
    }

    emit(event: string, payload?: unknown): void {
        const listeners = this.handlers.get(event);
        if (!listeners) return;
        for (const handler of listeners) {
            handler(payload);
        }
    }

    load(...args: unknown[]): void {
        this.loadCalls.push({ args });
    }

    play(): void {
        this.playing = true;
        this.playCalls += 1;
    }

    pause(): void {
        this.playing = false;
        this.pauseCalls += 1;
    }

    stop(): void {
        this.playing = false;
        this.stopCalls += 1;
    }

    seek(timeSec: number): void {
        this.currentTime = timeSec;
        this.actualCurrentTime = timeSec;
        this.seekCalls.push(timeSec);
    }

    reload(): void {
        this.reloadCalls += 1;
    }

    preload(url: string, format: string): void {
        this.preloadCalls.push({ url, format });
    }

    setVolume(value: number): void {
        this.setVolumeCalls.push(value);
    }

    setMuted(value: boolean): void {
        this.setMutedCalls.push(Boolean(value));
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getActualCurrentTime(): number {
        return this.actualCurrentTime;
    }

    getDuration(): number {
        return this.duration;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    quarantineRepresentation(): null {
        return null;
    }

    clearRepresentationQuarantine(): void {}

    on(event: string, handler: (payload?: unknown) => void): void {
        let listeners = this.handlers.get(event);
        if (!listeners) {
            listeners = new Set();
            this.handlers.set(event, listeners);
        }
        listeners.add(handler);
        this.onCalls.push({ event });
    }

    off(event: string, handler: (payload?: unknown) => void): void {
        this.handlers.get(event)?.delete(handler);
        this.offCalls.push({ event });
    }

    destroy(): void {
        this.handlers.clear();
    }
}

type EffectCallback = () => void | (() => void);

type HookSlot =
    | { kind: "ref"; value: { current: unknown } }
    | { kind: "callback"; deps: readonly unknown[] | undefined; fn: (...args: unknown[]) => unknown }
    | { kind: "effect" | "layout"; deps: readonly unknown[] | undefined; cleanup: (() => void) | null };

class HookRuntime {
    private slots: HookSlot[] = [];
    private cursor = 0;
    private pendingLayouts: Array<{ index: number; callback: EffectCallback; deps: readonly unknown[] | undefined }> = [];
    private pendingEffects: Array<{ index: number; callback: EffectCallback; deps: readonly unknown[] | undefined }> = [];

    render(component: () => unknown): void {
        this.cursor = 0;
        this.pendingLayouts = [];
        this.pendingEffects = [];

        component();

        this.flush(this.pendingLayouts, "layout");
        this.flush(this.pendingEffects, "effect");
    }

    unmount(): void {
        for (const slot of this.slots) {
            if ((slot.kind === "effect" || slot.kind === "layout") && slot.cleanup) {
                slot.cleanup();
                slot.cleanup = null;
            }
        }
        this.slots = [];
        this.cursor = 0;
        this.pendingLayouts = [];
        this.pendingEffects = [];
    }

    useRef<T>(initialValue: T): { current: T } {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            const value = { current: initialValue };
            this.slots[index] = { kind: "ref", value };
            return value;
        }
        assert.equal(slot.kind, "ref");
        return slot.value as { current: T };
    }

    useCallback<T extends (...args: unknown[]) => unknown>(
        fn: T,
        deps: readonly unknown[] | undefined,
    ): T {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            this.slots[index] = { kind: "callback", deps, fn };
            return fn;
        }

        assert.equal(slot.kind, "callback");
        if (!areDepsEqual(slot.deps, deps)) {
            slot.deps = deps;
            slot.fn = fn;
        }
        return slot.fn as T;
    }

    useEffect(callback: EffectCallback, deps: readonly unknown[] | undefined): void {
        this.registerEffect("effect", callback, deps);
    }

    useLayoutEffect(
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        this.registerEffect("layout", callback, deps);
    }

    private registerEffect(
        kind: "effect" | "layout",
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        const index = this.cursor;
        this.cursor += 1;

        const slot = this.slots[index];
        if (!slot) {
            this.slots[index] = { kind, deps, cleanup: null };
            this.enqueue(kind, index, callback, deps);
            return;
        }

        assert.equal(slot.kind, kind);
        if (!areDepsEqual(slot.deps, deps)) {
            this.enqueue(kind, index, callback, deps);
        }
    }

    private enqueue(
        kind: "effect" | "layout",
        index: number,
        callback: EffectCallback,
        deps: readonly unknown[] | undefined,
    ): void {
        const queue = kind === "layout" ? this.pendingLayouts : this.pendingEffects;
        queue.push({ index, callback, deps });
    }

    private flush(
        queue: Array<{ index: number; callback: EffectCallback; deps: readonly unknown[] | undefined }>,
        expectedKind: "effect" | "layout",
    ): void {
        for (const entry of queue) {
            const slot = this.slots[entry.index];
            assert.ok(slot && (slot.kind === "effect" || slot.kind === "layout"));
            assert.equal(slot.kind, expectedKind);
            if (slot.cleanup) {
                slot.cleanup();
                slot.cleanup = null;
            }
            const cleanup = entry.callback();
            slot.deps = entry.deps;
            slot.cleanup = typeof cleanup === "function" ? cleanup : null;
        }
    }
}

const areDepsEqual = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
): boolean => {
    if (!previous || !next) return false;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        if (!Object.is(previous[index], next[index])) return false;
    }
    return true;
};

const hookRuntime = new HookRuntime();
const engine = new FakeAudioEngine();

const seekSubscribers = new Set<(time: number) => void | Promise<void>>();
const emitSeek = (time: number): void => {
    for (const handler of seekSubscribers) {
        void handler(time);
    }
};

const audioState = {
    currentTrack: null as Track | null,
    currentAudiobook: null as Audiobook | null,
    currentPodcast: null as Podcast | null,
    playbackType: "track" as PlaybackType,
    volume: 0.8,
    isMuted: false,
    repeatMode: "off" as "off" | "one" | "all",
    queue: [] as Track[],
    currentIndex: 0,
    isShuffle: false,
    shuffleIndices: [] as number[],
};

const playbackState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isBuffering: false,
    canSeek: true,
};

const playbackCalls = {
    setCurrentTime: [] as number[],
    setCurrentTimeFromEngine: [] as number[],
    setDuration: [] as number[],
    setIsPlaying: [] as boolean[],
    setIsBuffering: [] as boolean[],
    setTargetSeekPosition: [] as Array<number | null>,
    setCanSeek: [] as boolean[],
    setDownloadProgress: [] as Array<number | null>,
    setStreamProfile: [] as Array<unknown>,
};

const audioStateSetterCalls = {
    setCurrentTrack: [] as Array<Track | null>,
    setCurrentAudiobook: [] as Array<Audiobook | null>,
    setCurrentPodcast: [] as Array<Podcast | null>,
    setPlaybackType: [] as Array<PlaybackType>,
};

const controlCalls = {
    pause: 0,
    next: 0,
    nextPodcastEpisode: 0,
    startVibeMode: 0,
};

const apiCalls = {
    getStreamUrl: [] as string[],
    createSegmentedStreamingSession: [] as Array<Record<string, unknown>>,
    handoffSegmentedStreamingSession: [] as Array<{
        sessionId: string;
        sessionToken: string;
        payload: Record<string, unknown>;
    }>,
    getPodcastEpisodeCacheStatus: [] as Array<{ podcastId: string; episodeId: string }>,
    updatePodcastProgress: [] as Array<{
        podcastId: string;
        episodeId: string;
        positionSec: number;
        durationSec: number;
        isFinished: boolean;
    }>,
    reportPlaybackClientMetric: [] as Array<Record<string, unknown>>,
};

const preemptChecks: Array<{
    currentMediaId: string | null;
    previousMediaId: string | null;
    isLoading: boolean;
}> = [];

const toastErrors: string[] = [];

let runtimeEngineMode: "howler" | "videojs" = "howler";
let listenTogetherSnapshot: { groupId?: string } | null = null;
let podcastCacheStatus = {
    cached: true,
    downloading: false,
    downloadProgress: null as number | null,
};
let seekToleranceOverride: boolean | null = null;
let segmentedStartupRetryDelayOverride: number | null = null;
const segmentedStartupRetryDelayInputs: Array<{
    retryTimeoutMs: number;
    sourceKind: "segmented" | "direct";
    requestLoadId: number;
    activeLoadId: number;
}> = [];

const segmentedSessionQueue: Array<SegmentedSession | Error> = [];
const handoffSessionQueue: Array<HandoffSession | Error> = [];
const loggerCalls = {
    info: [] as Array<unknown[]>,
    warn: [] as Array<unknown[]>,
    error: [] as Array<unknown[]>,
};

const makeTrack = (id: string, overrides: Partial<Track> = {}): Track => ({
    id,
    title: `Track ${id}`,
    duration: 210,
    filePath: `${id}.mp3`,
    streamSource: "local",
    ...overrides,
});

const makeSegmentedSession = (
    sessionId: string,
    overrides: Partial<SegmentedSession> = {},
): SegmentedSession => ({
    sessionId,
    sessionToken: `${sessionId}-token`,
    manifestUrl: `https://stream.test/${sessionId}/manifest.mpd`,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    playbackProfile: {
        sourceType: "local",
        codec: "aac",
        bitrateKbps: 320,
    },
    engineHints: {
        sourceType: "local",
        assetBuildInFlight: false,
    },
    ...overrides,
});

const resetHarnessState = (): void => {
    engine.reset();
    hookRuntime.unmount();

    audioState.currentTrack = makeTrack("track-1");
    audioState.currentAudiobook = null;
    audioState.currentPodcast = null;
    audioState.playbackType = "track";
    audioState.volume = 0.8;
    audioState.isMuted = false;
    audioState.repeatMode = "off";
    audioState.queue = [audioState.currentTrack, makeTrack("track-2")];
    audioState.currentIndex = 0;
    audioState.isShuffle = false;
    audioState.shuffleIndices = [0, 1];

    playbackState.isPlaying = false;
    playbackState.currentTime = 0;
    playbackState.duration = 0;
    playbackState.isBuffering = false;
    playbackState.canSeek = true;

    for (const values of Object.values(playbackCalls)) {
        values.length = 0;
    }
    for (const values of Object.values(audioStateSetterCalls)) {
        values.length = 0;
    }

    controlCalls.pause = 0;
    controlCalls.next = 0;
    controlCalls.nextPodcastEpisode = 0;
    controlCalls.startVibeMode = 0;

    for (const values of Object.values(apiCalls)) {
        values.length = 0;
    }
    preemptChecks.length = 0;
    toastErrors.length = 0;

    runtimeEngineMode = "howler";
    listenTogetherSnapshot = null;
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = null;
    segmentedStartupRetryDelayOverride = null;
    segmentedStartupRetryDelayInputs.length = 0;
    segmentedSessionQueue.length = 0;
    handoffSessionQueue.length = 0;
    loggerCalls.info.length = 0;
    loggerCalls.warn.length = 0;
    loggerCalls.error.length = 0;
    seekSubscribers.clear();
};

const applyValue = <T>(
    incoming: T | ((previous: T) => T),
    previous: T,
): T => {
    if (typeof incoming === "function") {
        return (incoming as (value: T) => T)(previous);
    }
    return incoming;
};

mock.module("react", {
    defaultExport: {
        createElement: (..._args: unknown[]) => ({ __mocked: true }),
        createContext: <T>(defaultValue: T) => ({
            __defaultValue: defaultValue,
        }),
        useContext: (context: { __defaultValue: unknown } | null) =>
            context?.__defaultValue ?? { prefetchQuery: async () => undefined },
        useRef: <T>(value: T) => hookRuntime.useRef(value),
        useCallback: <T extends (...args: unknown[]) => unknown>(
            fn: T,
            deps?: readonly unknown[],
        ) => hookRuntime.useCallback(fn, deps),
        useEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
            hookRuntime.useEffect(effect, deps),
        useLayoutEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
            hookRuntime.useLayoutEffect(effect, deps),
        useState: <T>(initial: T | (() => T)) => [
            typeof initial === "function" ? (initial as () => T)() : initial,
            () => undefined,
        ],
        useMemo: <T>(factory: () => T) => factory(),
        memo: <T>(component: T) => component,
        forwardRef: <T>(render: T) => render,
        Fragment: "mock-fragment",
    },
    namedExports: {
        memo: <T>(component: T) => component,
        createContext: <T>(defaultValue: T) => ({
            __defaultValue: defaultValue,
        }),
        useContext: (context: { __defaultValue: unknown } | null) =>
            context?.__defaultValue ?? { prefetchQuery: async () => undefined },
        useRef: <T>(value: T) => hookRuntime.useRef(value),
        useCallback: <T extends (...args: unknown[]) => unknown>(
            fn: T,
            deps?: readonly unknown[],
        ) => hookRuntime.useCallback(fn, deps),
        useEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
            hookRuntime.useEffect(effect, deps),
        useLayoutEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
            hookRuntime.useLayoutEffect(effect, deps),
    },
});

mock.module("@/lib/audio-engine", {
    namedExports: {
        createRuntimeAudioEngine: () => engine,
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: audioState.currentTrack,
            currentAudiobook: audioState.currentAudiobook,
            currentPodcast: audioState.currentPodcast,
            playbackType: audioState.playbackType,
            volume: audioState.volume,
            isMuted: audioState.isMuted,
            repeatMode: audioState.repeatMode,
            setCurrentAudiobook: (value: Audiobook | null | ((previous: Audiobook | null) => Audiobook | null)) => {
                audioState.currentAudiobook = applyValue(value, audioState.currentAudiobook);
                audioStateSetterCalls.setCurrentAudiobook.push(audioState.currentAudiobook);
            },
            setCurrentTrack: (value: Track | null | ((previous: Track | null) => Track | null)) => {
                audioState.currentTrack = applyValue(value, audioState.currentTrack);
                audioStateSetterCalls.setCurrentTrack.push(audioState.currentTrack);
            },
            setCurrentPodcast: (value: Podcast | null | ((previous: Podcast | null) => Podcast | null)) => {
                audioState.currentPodcast = applyValue(value, audioState.currentPodcast);
                audioStateSetterCalls.setCurrentPodcast.push(audioState.currentPodcast);
            },
            setPlaybackType: (value: PlaybackType | ((previous: PlaybackType) => PlaybackType)) => {
                audioState.playbackType = applyValue(value, audioState.playbackType);
                audioStateSetterCalls.setPlaybackType.push(audioState.playbackType);
            },
            queue: audioState.queue,
            currentIndex: audioState.currentIndex,
            isShuffle: audioState.isShuffle,
            shuffleIndices: audioState.shuffleIndices,
        }),
    },
});

mock.module("@/lib/audio-playback-context", {
    namedExports: {
        useAudioPlayback: () => ({
            isPlaying: playbackState.isPlaying,
            currentTime: playbackState.currentTime,
            setCurrentTime: (value: number) => {
                playbackState.currentTime = value;
                playbackCalls.setCurrentTime.push(value);
            },
            setCurrentTimeFromEngine: (value: number) => {
                playbackState.currentTime = value;
                playbackCalls.setCurrentTimeFromEngine.push(value);
            },
            setDuration: (value: number) => {
                playbackState.duration = value;
                playbackCalls.setDuration.push(value);
            },
            setIsPlaying: (value: boolean) => {
                playbackState.isPlaying = value;
                playbackCalls.setIsPlaying.push(value);
            },
            isBuffering: playbackState.isBuffering,
            setIsBuffering: (value: boolean) => {
                playbackState.isBuffering = value;
                playbackCalls.setIsBuffering.push(value);
            },
            setTargetSeekPosition: (value: number | null) => {
                playbackCalls.setTargetSeekPosition.push(value);
            },
            canSeek: playbackState.canSeek,
            setCanSeek: (value: boolean) => {
                playbackState.canSeek = value;
                playbackCalls.setCanSeek.push(value);
            },
            setDownloadProgress: (value: number | null) => {
                playbackCalls.setDownloadProgress.push(value);
            },
            setStreamProfile: (value: unknown) => {
                playbackCalls.setStreamProfile.push(value);
            },
        }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            pause: () => {
                controlCalls.pause += 1;
            },
            next: () => {
                controlCalls.next += 1;
            },
            nextPodcastEpisode: () => {
                controlCalls.nextPodcastEpisode += 1;
            },
            startVibeMode: async () => {
                controlCalls.startVibeMode += 1;
                return { success: false, trackCount: 0 };
            },
        }),
    },
});

mock.module("@/lib/audio-load-preemption", {
    namedExports: {
        shouldAllowInitialPersistedTrackResume: () => false,
        shouldPreemptInFlightAudioLoad: (input: {
            currentMediaId: string | null;
            previousMediaId: string | null;
            isLoading: boolean;
        }) => {
            preemptChecks.push(input);
            return Boolean(
                input.isLoading &&
                    input.currentMediaId &&
                    input.previousMediaId &&
                    input.currentMediaId !== input.previousMediaId
            );
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getStreamUrl: (trackId: string) => {
                apiCalls.getStreamUrl.push(trackId);
                return `https://stream.test/direct/${trackId}`;
            },
            getTidalStreamUrl: (trackId: number) =>
                `https://stream.test/tidal/${trackId}`,
            getYtMusicStreamUrl: (videoId: string) =>
                `https://stream.test/yt/${videoId}`,
            getAudiobookStreamUrl: (bookId: string) =>
                `https://stream.test/audiobook/${bookId}`,
            getPodcastEpisodeStreamUrl: (podcastId: string, episodeId: string) =>
                `https://stream.test/podcast/${podcastId}/${episodeId}`,
            getPodcastEpisodeCacheStatus: async (podcastId: string, episodeId: string) => {
                apiCalls.getPodcastEpisodeCacheStatus.push({ podcastId, episodeId });
                return {
                    cached: podcastCacheStatus.cached,
                    downloading: podcastCacheStatus.downloading,
                    downloadProgress: podcastCacheStatus.downloadProgress,
                };
            },
            createSegmentedStreamingSession: async (
                request: Record<string, unknown>,
            ) => {
                apiCalls.createSegmentedStreamingSession.push(request);
                const next = segmentedSessionQueue.shift();
                if (next instanceof Error) throw next;
                return next ?? makeSegmentedSession("default-segmented");
            },
            handoffSegmentedStreamingSession: async (
                sessionId: string,
                sessionToken: string,
                payload: Record<string, unknown>,
            ) => {
                apiCalls.handoffSegmentedStreamingSession.push({
                    sessionId,
                    sessionToken,
                    payload,
                });
                const next = handoffSessionQueue.shift();
                if (next instanceof Error) throw next;
                const resolved = next ?? makeSegmentedSession("default-handoff");
                return {
                    ...resolved,
                    resumeAtSec:
                        typeof resolved.resumeAtSec === "number"
                            ? resolved.resumeAtSec
                            : 0,
                    shouldPlay:
                        typeof resolved.shouldPlay === "boolean"
                            ? resolved.shouldPlay
                            : false,
                };
            },
            heartbeatSegmentedStreamingSession: async (
                sessionId: string,
                sessionToken: string,
            ) => ({
                sessionId,
                sessionToken,
                expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            }),
            updateAudiobookProgress: async () => undefined,
            updatePodcastProgress: async (
                podcastId: string,
                episodeId: string,
                positionSec: number,
                durationSec: number,
                isFinished: boolean,
            ) => {
                apiCalls.updatePodcastProgress.push({
                    podcastId,
                    episodeId,
                    positionSec,
                    durationSec,
                    isFinished,
                });
            },
            getStreamingAuthToken: () => "test-auth-token",
            reportPlaybackClientMetric: async (payload: Record<string, unknown>) => {
                apiCalls.reportPlaybackClientMetric.push(payload);
            },
        },
    },
});

mock.module("@/lib/audio-engine/engineMode", {
    namedExports: {
        resolveStreamingEngineMode: () => runtimeEngineMode,
    },
});

mock.module("@/lib/audio-engine/recoveryPolicy", {
    namedExports: {
        resolveLocalAuthoritativeRecovery: (
            local: { positionSec: number; shouldPlay: boolean },
            server?: { resumeAtSec?: number },
        ) => ({
            resumeAtSec: Math.max(
                0,
                local.positionSec > 0
                    ? local.positionSec
                    : Number.isFinite(server?.resumeAtSec)
                      ? (server?.resumeAtSec ?? 0)
                      : 0,
            ),
            shouldPlay: local.shouldPlay,
            authority: "local",
        }),
    },
});

mock.module("@/lib/audio-engine/segmentedStartupPolicy", {
    namedExports: {
        resolveSegmentedPrewarmMaxRetries: () => 0,
    },
});

mock.module("@/lib/audio-engine/segmentedPlaybackRegressionPolicy", {
    namedExports: {
        isSeekWithinTolerance: (_actual: number, _target: number) =>
            seekToleranceOverride ?? true,
        resolveHeartbeatGuardedRefreshDecision: () => ({
            shouldTriggerRefresh: false,
            reason: "below_threshold",
            remainingCooldownMs: 0,
        }),
        resolveCorrelatedRecoveryResumeDecision: (input: {
            requestedResumeAtSec: number;
        }) => ({
            matched: true,
            resumeAtSec: input.requestedResumeAtSec,
            mismatchReason: "none",
        }),
        resolveStartupGuardedRecoveryPositionSec: (input: {
            trustedPositionSec: number;
        }) => input.trustedPositionSec,
        resolveSegmentedStartupRetryDelayMs: (input: {
            sourceKind: "segmented" | "direct";
            requestLoadId: number;
            activeLoadId: number;
            retryTimeoutMs: number;
        }) => {
            segmentedStartupRetryDelayInputs.push({
                sourceKind: input.sourceKind,
                requestLoadId: input.requestLoadId,
                activeLoadId: input.activeLoadId,
                retryTimeoutMs: input.retryTimeoutMs,
            });
            return segmentedStartupRetryDelayOverride;
        },
        resolveBufferingRecoveryAction: () => "transition_playing",
        resolveTrustedTrackPositionSec: (input: {
            enginePositionSec: number;
            fallbackPositionSec: number;
        }) => Math.max(0, input.enginePositionSec || input.fallbackPositionSec),
        shouldRetrySegmentedStartupTimeout: (input: {
            isLoading: boolean;
            requestLoadId: number;
            activeLoadId: number;
        }) =>
            input.isLoading && input.requestLoadId === input.activeLoadId,
    },
});

mock.module("@/lib/audio-engine/segmentedRepresentationPolicy", {
    namedExports: {
        resolveSegmentAssetNameFromUri: (uri: string | null | undefined) => {
            if (!uri) return null;
            const parts = uri.split("/");
            return parts[parts.length - 1] ?? null;
        },
        resolveSegmentRepresentationIdFromName: (segmentName: string | null | undefined) => {
            if (!segmentName) return null;
            return segmentName.split("_")[0] ?? null;
        },
    },
});

mock.module("@/lib/audio-seek-emitter", {
    namedExports: {
        audioSeekEmitter: {
            subscribe: (handler: (time: number) => void | Promise<void>) => {
                seekSubscribers.add(handler);
                return () => {
                    seekSubscribers.delete(handler);
                };
            },
        },
    },
});

mock.module("@/lib/query-events", {
    namedExports: {
        dispatchQueryEvent: () => undefined,
    },
});

mock.module("@/lib/listen-together-session", {
    namedExports: {
        enqueueLatestListenTogetherHostTrackOperation: async () => undefined,
        getListenTogetherSessionSnapshot: () => listenTogetherSnapshot,
        isListenTogetherActiveOrPending: () => false,
        requestListenTogetherGroupResync: () => undefined,
    },
});

mock.module("@/lib/storage-migration", {
    namedExports: {
        createMigratingStorageKey: (key: string) => key,
        PODCAST_DEBUG_STORAGE_KEY: "podcast_debug",
        readMigratingStorageItem: () => null,
    },
});

const playbackMachine = { state: "IDLE" as string };

class MockHeartbeatMonitor {
    public monitoring = false;
    public stalled = false;
    private options: Record<string, unknown>;
    private readonly callbacks: Record<string, () => void>;
    private bufferTimeout: NodeJS.Timeout | null = null;

    constructor(
        callbacks: Record<string, () => void>,
        options: Record<string, unknown> = {},
    ) {
        this.callbacks = callbacks;
        this.options = options;
    }

    start(): void {
        this.monitoring = true;
    }

    stop(): void {
        this.monitoring = false;
    }

    startBufferTimeout(): void {
        this.clearBufferTimeout();
        const timeoutMs =
            typeof this.options.bufferTimeout === "number"
                ? this.options.bufferTimeout
                : 1000;
        this.bufferTimeout = setTimeout(() => {
            this.callbacks.onBufferTimeout?.();
        }, timeoutMs);
    }

    clearBufferTimeout(): void {
        if (this.bufferTimeout) {
            clearTimeout(this.bufferTimeout);
            this.bufferTimeout = null;
        }
    }

    updateConfig(next: Record<string, unknown>): void {
        this.options = { ...this.options, ...next };
    }

    notifyProgress(_time: number): void {}

    destroy(): void {
        this.clearBufferTimeout();
        this.monitoring = false;
    }
}

mock.module("@/lib/audio", {
    namedExports: {
        playbackStateMachine: {
            transition: (next: string) => {
                playbackMachine.state = next;
                return true;
            },
            forceTransition: (next: string) => {
                playbackMachine.state = next;
                return true;
            },
            getState: () => playbackMachine.state,
            get isPlaying() {
                return playbackMachine.state === "PLAYING";
            },
            get isBuffering() {
                return playbackMachine.state === "BUFFERING";
            },
        },
        HeartbeatMonitor: MockHeartbeatMonitor,
    },
});

mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({
            prefetchQuery: async () => undefined,
        }),
    },
});

mock.module("@/hooks/useLyrics", {
    namedExports: {
        fetchLyrics: async () => null,
        lyricsQueryKeys: {
            lyrics: (trackId: string) => ["lyrics", trackId],
        },
    },
});

mock.module("@/lib/lyrics-cache-policy", {
    namedExports: {
        LYRICS_QUERY_STALE_TIME: 60_000,
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            error: (message: string) => {
                toastErrors.push(message);
            },
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            info: (...args: unknown[]) => {
                loggerCalls.info.push(args);
            },
            warn: (...args: unknown[]) => {
                loggerCalls.warn.push(args);
            },
            error: (...args: unknown[]) => {
                loggerCalls.error.push(args);
            },
        },
    },
});

mock.module("@soundspan/media-metadata-contract", {
    namedExports: {
        normalizeCanonicalMediaProviderIdentity: (input: {
            streamSource?: "local" | "tidal" | "youtube";
            tidalTrackId?: number;
            youtubeVideoId?: string;
        }) => {
            if (input.streamSource === "tidal" || input.tidalTrackId) {
                return { source: "tidal" };
            }
            if (input.streamSource === "youtube" || input.youtubeVideoId) {
                return { source: "youtube" };
            }
            return { source: "local" };
        },
        toAudioEngineSourceType: (source: "local" | "tidal" | "youtube") =>
            source === "youtube" ? "ytmusic" : source,
    },
});

let orchestratorComponent: (() => null) | null = null;

before(async () => {
    const orchestratorModule = await import(
        "../../components/player/AudioPlaybackOrchestrator.tsx"
    );
    orchestratorComponent =
        orchestratorModule.AudioPlaybackOrchestrator as unknown as () => null;
});

beforeEach(() => {
    resetHarnessState();
    playbackMachine.state = "IDLE";
});

afterEach(() => {
    hookRuntime.unmount();
    delete (globalThis as { window?: unknown }).window;
    try {
        mock.timers.reset();
    } catch {
        // No timer mocks were active in this test.
    }
});

const renderOrchestrator = (): void => {
    assert.ok(orchestratorComponent, "orchestrator should be imported");
    hookRuntime.render(orchestratorComponent as () => null);
};

const rerenderOrchestrator = (): void => {
    assert.ok(orchestratorComponent, "orchestrator should be imported");
    hookRuntime.render(orchestratorComponent as () => null);
};

const flushAsync = async (ticks = 6): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) {
        await Promise.resolve();
    }
};

const enableWindowMetrics = (runtimeConfig: Record<string, unknown> = {}): void => {
    (globalThis as { window?: Record<string, unknown> }).window = {
        __SOUNDSPAN_RUNTIME_CONFIG__: runtimeConfig,
    };
};

const getClientMetricEvents = (
    eventName: string,
): Array<Record<string, unknown>> => {
    return loggerCalls.info
        .map((args) => args[1])
        .filter(
            (payload): payload is Record<string, unknown> =>
                Boolean(
                    payload &&
                        typeof payload === "object" &&
                        (payload as { event?: string }).event === eventName,
                ),
        );
};

test("loads direct track, applies output state, and syncs play/pause transitions", async () => {
    playbackState.isPlaying = true;
    audioState.currentTrack = makeTrack("direct-track", {
        filePath: "direct-track.flac",
    });
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();

    assert.equal(engine.loadCalls.length, 1);
    const [source, autoplay, format] = engine.loadCalls[0].args;
    assert.equal(source, "https://stream.test/direct/direct-track");
    assert.equal(autoplay, true);
    assert.equal(format, "flac");
    assert.ok(playbackCalls.setDuration.includes(210));
    assert.ok(
        playbackCalls.setStreamProfile.some(
            (profile) =>
                Boolean(
                    profile &&
                        typeof profile === "object" &&
                        "mode" in profile &&
                        (profile as { mode: string }).mode === "direct"
                ),
        ),
    );

    engine.emit("load", { durationSec: 210 });
    await flushAsync();
    assert.ok(engine.playCalls >= 1);
    assert.ok(engine.setVolumeCalls.length > 0);
    assert.ok(engine.setMutedCalls.length > 0);

    playbackState.isPlaying = false;
    rerenderOrchestrator();
    await flushAsync();
    assert.ok(engine.pauseCalls >= 1);

    playbackState.isPlaying = true;
    rerenderOrchestrator();
    await flushAsync();
    assert.ok(engine.playCalls >= 2);
});

test("preempts in-flight load when track switches before initial load settles", async () => {
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("track-a");
    audioState.queue = [audioState.currentTrack, makeTrack("track-b")];

    renderOrchestrator();
    await flushAsync();
    assert.equal(engine.loadCalls.length, 1);

    audioState.currentTrack = makeTrack("track-b");
    audioState.queue = [audioState.currentTrack];
    rerenderOrchestrator();
    await flushAsync();

    assert.equal(engine.loadCalls.length, 2);
    const [secondSource] = engine.loadCalls[1].args;
    assert.equal(secondSource, "https://stream.test/direct/track-b");
    assert.ok(engine.stopCalls >= 1);
    assert.ok(engine.offCalls.some((call) => call.event === "load"));
    assert.ok(engine.offCalls.some((call) => call.event === "loaderror"));
    assert.ok(
        preemptChecks.some(
            (check) =>
                check.currentMediaId === "track-b" &&
                check.previousMediaId === "track-a" &&
                check.isLoading === true,
        ),
    );
});

test("creates segmented startup session and loads DASH source", async () => {
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("seg-track");
    audioState.queue = [audioState.currentTrack];
    segmentedSessionQueue.push(makeSegmentedSession("seg-session"));

    renderOrchestrator();
    await flushAsync(10);

    assert.equal(apiCalls.createSegmentedStreamingSession.length, 1);
    assert.equal(engine.loadCalls.length, 1);
    const [source, options] = engine.loadCalls[0].args as [
        {
            protocol: string;
            trackId: string;
            sessionId: string;
            mimeType: string;
        },
        { withCredentials: boolean; autoplay: boolean; requestHeaders?: Record<string, string> },
    ];
    assert.equal(source.protocol, "dash");
    assert.equal(source.trackId, "seg-track");
    assert.equal(source.sessionId, "seg-session");
    assert.equal(source.mimeType, "application/dash+xml");
    assert.equal(options.withCredentials, true);
    assert.equal(options.autoplay, false);
    assert.equal(options.requestHeaders?.["x-streaming-session-token"], "seg-session-token");

    assert.ok(
        playbackCalls.setStreamProfile.some(
            (profile) =>
                Boolean(
                    profile &&
                        typeof profile === "object" &&
                        "mode" in profile &&
                        (profile as { mode: string }).mode === "dash"
                ),
        ),
    );
});

test("retries segmented startup after transient session creation failures", async () => {
    mock.timers.enable();

    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("retry-track");
    audioState.queue = [audioState.currentTrack];

    const transientSessionError1 = Object.assign(
        new Error("transient timeout #1"),
        { data: { isTransient: true, retryAfterMs: 1 } },
    );
    const transientSessionError2 = Object.assign(
        new Error("transient timeout #2"),
        { data: { isTransient: true, retryAfterMs: 1 } },
    );

    segmentedSessionQueue.push(
        transientSessionError1,
        transientSessionError2,
        makeSegmentedSession("retry-session"),
    );

    renderOrchestrator();
    await flushAsync(12);

    assert.equal(apiCalls.createSegmentedStreamingSession.length, 2);
    assert.equal(engine.loadCalls.length, 0);

    mock.timers.tick(5_000);
    await flushAsync(12);

    assert.ok(apiCalls.createSegmentedStreamingSession.length >= 3);
    assert.ok(engine.stopCalls >= 1);
    assert.equal(engine.loadCalls.length, 1);
    const [source] = engine.loadCalls[0].args as [{ sessionId?: string }];
    assert.equal(source.sessionId, "retry-session");
});

test("podcast cached seek falls back to reload when direct seek misses target", async () => {
    mock.timers.enable();

    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "pod-1:ep-1",
        title: "Episode 1",
        duration: 1800,
        progress: { currentTime: 30 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = false;
    engine.playing = true;
    engine.currentTime = 0;
    engine.actualCurrentTime = 0;

    renderOrchestrator();
    await flushAsync(10);

    emitSeek(120);
    await flushAsync(10);
    assert.ok(engine.seekCalls.includes(120));

    mock.timers.tick(150);
    await flushAsync(8);
    assert.equal(engine.reloadCalls, 1);

    engine.emit("load", { durationSec: 1800 });
    await flushAsync(8);
    assert.ok(engine.seekCalls.filter((value) => value === 120).length >= 2);
    assert.ok(engine.playCalls >= 1);
    assert.ok(playbackCalls.setIsPlaying.includes(true));
});

test("unmount cleanup stops engine and detaches listeners", async () => {
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("cleanup-track");
    audioState.queue = [audioState.currentTrack];

    renderOrchestrator();
    await flushAsync();

    const onListenerCount = engine.onCalls.length;
    assert.ok(onListenerCount > 0);

    hookRuntime.unmount();

    assert.ok(engine.stopCalls >= 1);
    assert.ok(engine.offCalls.length > 0);
});

test("aborts in-flight segmented prewarm validation when track changes", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = true;

    const currentTrack = makeTrack("prewarm-current");
    const nextTrack = makeTrack("prewarm-next");
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, nextTrack];
    audioState.currentIndex = 0;

    segmentedSessionQueue.push(
        makeSegmentedSession("startup-session"),
        makeSegmentedSession("prewarm-session"),
    );

    const originalFetch = globalThis.fetch;
    const abortReasons: unknown[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = ((
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ) => {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener(
                "abort",
                () => {
                    abortReasons.push(signal.reason);
                    const abortError = new Error("aborted");
                    (abortError as { name: string }).name = "AbortError";
                    reject(abortError);
                },
                { once: true },
            );
        });
    }) as typeof fetch;

    try {
        renderOrchestrator();
        await flushAsync(20);
        assert.ok(apiCalls.createSegmentedStreamingSession.length >= 2);

        audioState.currentTrack = makeTrack("prewarm-replacement");
        audioState.queue = [audioState.currentTrack];
        rerenderOrchestrator();
        await flushAsync(20);

        assert.ok(abortReasons.includes("track_change"));
        const abortedMetrics = getClientMetricEvents(
            "session.prewarm_validation_aborted",
        );
        assert.ok(
            abortedMetrics.some(
                (metric) =>
                    metric.reason === "track_change" &&
                    metric.trackId === "prewarm-next",
            ),
        );
    } finally {
        if (originalFetch) {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        } else {
            delete (globalThis as { fetch?: typeof fetch }).fetch;
        }
    }
});

test("consumes prewarmed segmented session while prewarm validation is still in-flight", async () => {
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = true;

    const currentTrack = makeTrack("inflight-current");
    const nextTrack = makeTrack("inflight-next");
    audioState.currentTrack = currentTrack;
    audioState.queue = [currentTrack, nextTrack];
    audioState.currentIndex = 0;

    segmentedSessionQueue.push(
        makeSegmentedSession("inflight-startup"),
        makeSegmentedSession("inflight-prewarm"),
    );

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (() =>
        new Promise<Response>(() => undefined)) as typeof fetch;

    try {
        renderOrchestrator();
        await flushAsync(20);
        assert.equal(apiCalls.createSegmentedStreamingSession.length, 2);

        audioState.currentTrack = nextTrack;
        audioState.queue = [nextTrack];
        audioState.currentIndex = 0;
        rerenderOrchestrator();
        await flushAsync(20);

        assert.equal(apiCalls.createSegmentedStreamingSession.length, 2);

        const loadedSessionIds = engine.loadCalls
            .map((call) => (call.args[0] as { sessionId?: string } | undefined)?.sessionId ?? null)
            .filter((sessionId): sessionId is string => typeof sessionId === "string");
        assert.ok(loadedSessionIds.includes("inflight-prewarm"));
    } finally {
        if (originalFetch) {
            (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        } else {
            delete (globalThis as { fetch?: typeof fetch }).fetch;
        }
    }
});

test("clears handoff listeners on track change while handoff load is pending", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;

    const primaryTrack = makeTrack("handoff-track-a");
    const replacementTrack = makeTrack("handoff-track-b");
    audioState.currentTrack = primaryTrack;
    audioState.queue = [primaryTrack, replacementTrack];
    audioState.currentIndex = 0;

    segmentedSessionQueue.push(makeSegmentedSession("handoff-startup"));
    handoffSessionQueue.push({
        ...makeSegmentedSession("handoff-recovered"),
        resumeAtSec: 14,
        shouldPlay: false,
    });

    renderOrchestrator();
    await flushAsync(14);
    assert.ok(engine.loadCalls.length >= 1);
    engine.emit("load", { durationSec: 210 });
    await flushAsync(8);
    engine.emit("vhsresponse", {
        kind: "manifest",
        uri: "https://stream.test/handoff-startup/manifest.mpd",
        representationId: null,
        statusCode: 200,
        hasError: false,
        roundTripMs: 24,
        bytesReceived: 1024,
        sourceType: "local",
        sessionId: "handoff-startup",
        trackId: "handoff-track-a",
        timestampMs: Date.now(),
    });
    engine.emit("vhsresponse", {
        kind: "segment",
        uri: "https://stream.test/handoff-startup/chunk-0001.m4s",
        representationId: "chunk-0001",
        statusCode: 200,
        hasError: false,
        roundTripMs: 22,
        bytesReceived: 2048,
        sourceType: "local",
        sessionId: "handoff-startup",
        trackId: "handoff-track-a",
        timestampMs: Date.now() + 1,
    });
    engine.currentTime = 0.3;
    engine.emit("timeupdate", {
        timeSec: 0.3,
    });
    await flushAsync(8);

    engine.emit("loaderror", {
        error: new Error("forced handoff recovery trigger"),
    });
    await flushAsync(20);
    assert.equal(apiCalls.handoffSegmentedStreamingSession.length, 1);

    audioState.currentTrack = replacementTrack;
    audioState.queue = [replacementTrack];
    rerenderOrchestrator();
    await flushAsync(20);

    const loadOffCount = engine.offCalls.filter(
        (call) => call.event === "load",
    ).length;
    const loadErrorOffCount = engine.offCalls.filter(
        (call) => call.event === "loaderror",
    ).length;
    assert.ok(loadOffCount >= 1);
    assert.ok(loadErrorOffCount >= 1);

    const cleanupMetrics = getClientMetricEvents(
        "session.handoff_listener_cleanup",
    );
    assert.ok(
        cleanupMetrics.some(
            (metric) =>
                metric.reason === "track_change" &&
                metric.trackId === "handoff-track-a" &&
                metric.activeTrackId === "handoff-track-b",
        ),
    );
});

test("routes segmented load errors into startup recovery before first chunk response", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;

    const track = makeTrack("startup-gate-track");
    audioState.currentTrack = track;
    audioState.queue = [track];
    segmentedSessionQueue.push(makeSegmentedSession("startup-gate-session"));

    renderOrchestrator();
    await flushAsync(14);
    assert.ok(engine.loadCalls.length >= 1);

    engine.emit("load", { durationSec: 210 });
    await flushAsync(8);

    engine.emit("loaderror", {
        error: new Error("forced startup gate error"),
    });
    await flushAsync(20);

    assert.equal(apiCalls.handoffSegmentedStreamingSession.length, 0);
    const rebufferMetrics = getClientMetricEvents("player.rebuffer");
    assert.ok(
        rebufferMetrics.some(
            (metric) =>
                metric.trackId === "startup-gate-track" &&
                metric.reason === "manifest_stall_startup_recovery" &&
                metric.manifestStallReason === "load_error_before_first_chunk",
        ),
    );
});

test("handles manifest-stall audio engine events through startup recovery path", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;

    const track = makeTrack("manifest-stall-track");
    audioState.currentTrack = track;
    audioState.queue = [track];
    segmentedSessionQueue.push(makeSegmentedSession("manifest-stall-session"));

    renderOrchestrator();
    await flushAsync(14);

    assert.ok(
        engine.onCalls.some((call) => call.event === "manifeststall"),
    );
    assert.ok(
        engine.onCalls.some((call) => call.event === "manifest-stall"),
    );

    engine.emit("manifeststall", {
        trackId: "manifest-stall-track",
        sessionId: "manifest-stall-session",
        reason: "playlist_refresh_timeout",
    });
    await flushAsync(12);

    assert.equal(apiCalls.handoffSegmentedStreamingSession.length, 0);
    const rebufferMetrics = getClientMetricEvents("player.rebuffer");
    assert.ok(
        rebufferMetrics.some(
            (metric) =>
                metric.trackId === "manifest-stall-track" &&
                metric.reason === "manifest_stall_startup_recovery" &&
                metric.manifestStallReason === "playlist_refresh_timeout",
        ),
    );
});

test("keeps track time snapshot id null when track playback has no active track", async () => {
    audioState.playbackType = "track";
    audioState.currentTrack = null;
    audioState.queue = [];
    playbackState.currentTime = 37;

    renderOrchestrator();
    await flushAsync(8);

    assert.equal(engine.loadCalls.length, 0);
    assert.ok(playbackCalls.setDuration.includes(0));
});

test("podcast progress save falls back to podcast duration when engine duration is zero", async () => {
    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "podcast-9:episode-2",
        duration: 1800,
        progress: { currentTime: 15 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    playbackState.isBuffering = false;
    engine.currentTime = 42;
    engine.actualCurrentTime = 42;
    engine.duration = 0;

    renderOrchestrator();
    await flushAsync(12);

    assert.ok(apiCalls.updatePodcastProgress.length >= 1);
    const saveCall = apiCalls.updatePodcastProgress[0];
    assert.equal(saveCall.podcastId, "podcast-9");
    assert.equal(saveCall.episodeId, "episode-2");
    assert.equal(saveCall.positionSec, 42);
    assert.equal(saveCall.durationSec, 1800);
    assert.equal(saveCall.isFinished, false);
});

test("preempting an in-flight load clears seek-reload load listener", async () => {
    mock.timers.enable();

    audioState.playbackType = "podcast";
    audioState.currentTrack = null;
    audioState.currentPodcast = {
        id: "pod-preempt:ep-1",
        title: "Preempt Episode",
        duration: 1500,
        progress: { currentTime: 0 },
    };
    audioState.queue = [];
    playbackState.isPlaying = false;
    podcastCacheStatus = {
        cached: true,
        downloading: false,
        downloadProgress: null,
    };
    seekToleranceOverride = false;
    engine.playing = true;
    engine.currentTime = 0;
    engine.actualCurrentTime = 0;

    renderOrchestrator();
    await flushAsync(10);
    emitSeek(120);
    await flushAsync(10);
    mock.timers.tick(150);
    await flushAsync(8);
    assert.equal(engine.reloadCalls, 1);

    const loadOffBefore = engine.offCalls.filter(
        (call) => call.event === "load",
    ).length;

    audioState.playbackType = "track";
    audioState.currentPodcast = null;
    audioState.currentTrack = makeTrack("post-seek-track");
    audioState.queue = [audioState.currentTrack];
    rerenderOrchestrator();
    await flushAsync(12);

    const loadOffAfter = engine.offCalls.filter(
        (call) => call.event === "load",
    ).length;
    assert.ok(loadOffAfter - loadOffBefore >= 2);
});

test("segmented startup create failure uses transient heuristic when backend hint omits transient flag", async () => {
    mock.timers.enable();
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("hintless-transient");
    audioState.queue = [audioState.currentTrack];

    segmentedSessionQueue.push(
        new Error("startup session bootstrap failed"),
        Object.assign(
            new Error("network timeout while creating segmented session"),
            { data: { retryAfterMs: 750 } },
        ),
    );

    renderOrchestrator();
    await flushAsync(16);

    const createFailures = getClientMetricEvents("session.create_failure");
    const transientFailure = createFailures.find(
        (metric) =>
            metric.trackId === "hintless-transient" &&
            metric.reason === "network timeout while creating segmented session",
    );
    assert.ok(transientFailure);
    assert.equal(transientFailure.isTransient, true);
    assert.equal(transientFailure.retryAfterMsHint, 750);
    assert.equal(transientFailure.backendHintTransient, null);

    const retryMetrics = getClientMetricEvents("session.startup_retry");
    assert.ok(
        retryMetrics.some(
            (metric) =>
                metric.trackId === "hintless-transient" &&
                metric.retryAfterMsHint === 750 &&
                metric.stage === "session_create",
        ),
    );
});

test("segmented startup create failure honors backend transient=false hint in retry metadata", async () => {
    mock.timers.enable();
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("backend-hint-false");
    audioState.queue = [audioState.currentTrack];

    segmentedSessionQueue.push(
        new Error("startup session bootstrap failed"),
        Object.assign(new Error("service unavailable"), {
            data: { isTransient: false, retryAfterMs: 321 },
        }),
    );

    renderOrchestrator();
    await flushAsync(16);

    const createFailures = getClientMetricEvents("session.create_failure");
    const hintedFailure = createFailures.find(
        (metric) =>
            metric.trackId === "backend-hint-false" &&
            metric.reason === "service unavailable",
    );
    assert.ok(hintedFailure);
    assert.equal(hintedFailure.isTransient, false);
    assert.equal(hintedFailure.retryAfterMsHint, 321);
    assert.equal(hintedFailure.backendHintTransient, false);
});

test("segmented startup with asset-build-inflight hint arms backend-aligned extended retry timeout metric", async () => {
    enableWindowMetrics();
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("asset-build-track");
    audioState.queue = [audioState.currentTrack];

    segmentedSessionQueue.push(
        makeSegmentedSession("asset-build-session", {
            engineHints: {
                sourceType: "local",
                assetBuildInFlight: true,
            },
        }),
    );

    renderOrchestrator();
    await flushAsync(16);

    const assetBuildMetrics = getClientMetricEvents(
        "session.startup_asset_build_retry_armed",
    );
    const metric = assetBuildMetrics.find(
        (entry) => entry.trackId === "asset-build-track",
    );
    assert.ok(metric);
    assert.equal(metric.sourceType, "local");
    assert.equal(metric.effectiveRetryTimeoutMs, 22000);
    assert.ok(
        segmentedStartupRetryDelayInputs.some(
            (entry) => entry.retryTimeoutMs === 22000,
        ),
    );
});

test("segmented startup uses backend-aligned default readiness timeout for retry arming", async () => {
    runtimeEngineMode = "videojs";
    playbackState.isPlaying = false;
    audioState.currentTrack = makeTrack("reduced-timeout-track");
    audioState.queue = [audioState.currentTrack];

    segmentedSessionQueue.push(makeSegmentedSession("reduced-timeout-session"));

    renderOrchestrator();
    await flushAsync(16);

    assert.ok(segmentedStartupRetryDelayInputs.length >= 1);
    assert.equal(segmentedStartupRetryDelayInputs[0]?.sourceKind, "segmented");
    assert.equal(segmentedStartupRetryDelayInputs[0]?.retryTimeoutMs, 20000);
});
