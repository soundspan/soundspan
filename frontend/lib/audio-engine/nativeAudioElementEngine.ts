/**
 * Native Audio Element Engine (GH #42)
 *
 * Fourth pluggable backend for the hybrid runtime engine: owns exactly
 * one `<audio>` element for the life of the engine and implements the
 * shared {@link AudioEngine} contract. All playback decisions live in
 * the pure policy module ({@link transitionNativeEngine}); this
 * controller only applies transitions and executes effects.
 *
 * Structural guarantees:
 * - Single engine-owned element; `load()` assigns `src` directly, which
 *   synchronously stops the previous stream (kills double-play).
 * - One optional muted, never-playing buffer element for preload
 *   (capped at one; warms the browser cache for gapless switches).
 * - No AudioContext on the default path — hi-res FLAC rides the bare
 *   media pipeline. The only sanctioned bridge is the gated iOS
 *   standalone PWA bridge (see iosStandalonePwaBridge.ts).
 * - End detection is the native `ended` event only (media-pipeline
 *   driven; fires under background timer throttling). Position updates
 *   come from `timeupdate` plus a 1s ticker.
 */

import {
    type AudioEngine,
    type AudioEngineEventHandler,
    type AudioEngineEventType,
    type AudioEngineLoadOptions,
    type AudioEngineSource,
} from "@/lib/audio-engine/types";
import {
    createInitialNativeEngineState,
    NATIVE_ENGINE_END_PAUSE_EPSILON_SEC,
    transitionNativeEngine,
    type NativeEnginePolicyEffect,
    type NativeEnginePolicyEvent,
    type NativeEnginePolicyState,
} from "@/lib/audio-engine/nativeAudioElementPolicy";
import {
    IosStandaloneAudioContextBridge,
    detectIosStandaloneAudioBridgeEnvironment,
} from "@/lib/audio-engine/iosStandalonePwaBridge";
import { DEFAULT_AUDIO_VOLUME, clampAudioVolume } from "@/lib/audio-volume";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

/** Structural subset of HTMLAudioElement the engine drives (testable). */
export interface NativeAudioElementLike {
    src: string;
    currentTime: number;
    readonly duration: number;
    readonly paused: boolean;
    readonly ended: boolean;
    muted: boolean;
    volume: number;
    preload: string;
    crossOrigin: string | null;
    readonly error: { code: number; message?: string } | null;
    play(): Promise<void> | void;
    pause(): void;
    removeAttribute(name: string): void;
    load(): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Injectable timer surface (deterministic tests). */
export interface NativeEngineScheduler {
    setTimer(callback: () => void, delayMs: number): unknown;
    clearTimer(id: unknown): void;
    setTicker(callback: () => void, intervalMs: number): unknown;
    clearTicker(id: unknown): void;
}

export interface NativeAudioElementEngineOptions {
    /** Element factory; defaults to `document.createElement("audio")`. */
    createElement?: () => NativeAudioElementLike | null;
    /** Clock; defaults to Date.now. */
    now?: () => number;
    /** Timer surface; defaults to global setTimeout/setInterval. */
    scheduler?: NativeEngineScheduler;
    /**
     * Binds a global listener and returns its cleanup. Defaults to the
     * real window/document; injectable for tests.
     */
    bindGlobalListener?: (
        target: "window" | "document",
        type: string,
        handler: (event: unknown) => void,
    ) => () => void;
    /** Page-visibility probe for error classification. */
    isPageHidden?: () => boolean;
    /** Gate for the iOS standalone PWA AudioContext bridge. */
    iosBridgeGate?: () => boolean;
    /** Bridge instance (injectable for tests). */
    iosBridge?: IosStandaloneAudioContextBridge;
    /** Telemetry sink; defaults to structured logger output. */
    telemetry?: (event: string, fields: Record<string, unknown>) => void;
}

type AnyAudioEventHandler = (payload: unknown) => void;

const TICKER_INTERVAL_MS = 1_000;

const ELEMENT_EVENT_TYPES = [
    "loadedmetadata",
    "playing",
    "pause",
    "ended",
    "seeked",
    "timeupdate",
    "waiting",
    "error",
] as const;

const GESTURE_EVENT_TYPES = ["pointerdown", "keydown"] as const;

const createDefaultElement = (): NativeAudioElementLike | null => {
    if (typeof document === "undefined") {
        return null;
    }
    return document.createElement("audio") as unknown as NativeAudioElementLike;
};

const defaultScheduler: NativeEngineScheduler = {
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setTicker: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearTicker: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

const defaultBindGlobalListener = (
    target: "window" | "document",
    type: string,
    handler: (event: unknown) => void,
): (() => void) => {
    const bindTarget =
        target === "window"
            ? typeof window !== "undefined"
                ? window
                : null
            : typeof document !== "undefined"
              ? document
              : null;
    if (!bindTarget) {
        return () => undefined;
    }
    bindTarget.addEventListener(type, handler);
    return () => bindTarget.removeEventListener(type, handler);
};

const defaultIsPageHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

const defaultTelemetry = (
    event: string,
    fields: Record<string, unknown>,
): void => {
    sharedFrontendLogger.info("[NativeAudioEngine][Telemetry]", {
        engineMode: "native",
        event,
        ...fields,
    });
};

const resolveSource = (
    source: AudioEngineSource | string,
): AudioEngineSource => (typeof source === "string" ? { url: source } : source);

const toFiniteDuration = (value: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;

const isAtEndOfStream = (element: NativeAudioElementLike): boolean =>
    element.ended ||
    (Number.isFinite(element.duration) &&
        element.duration > 0 &&
        element.currentTime >=
            element.duration - NATIVE_ENGINE_END_PAUSE_EPSILON_SEC);

/**
 * AudioEngine implementation backed by a single native `<audio>` element.
 */
export class NativeAudioElementEngine implements AudioEngine {
    private element: NativeAudioElementLike | null = null;
    private preloadElement: NativeAudioElementLike | null = null;
    private preloadedUrl: string | null = null;
    private policyState: NativeEnginePolicyState =
        createInitialNativeEngineState();
    private lastSource: AudioEngineSource | null = null;
    private lastLoadOptions: AudioEngineLoadOptions | null = null;
    private loadGeneration = 0;
    private volume = DEFAULT_AUDIO_VOLUME;
    private muted = false;
    private retryTimerId: unknown = null;
    private tickerId: unknown = null;
    private gestureCleanups: Array<() => void> = [];
    private visibilityRetryCleanup: (() => void) | null = null;
    private pageShowCleanup: (() => void) | null = null;
    private elementCleanups: Array<() => void> = [];
    private isDestroyed = false;
    private readonly listeners = new Map<
        AudioEngineEventType,
        Set<AnyAudioEventHandler>
    >();

    private readonly createElement: () => NativeAudioElementLike | null;
    private readonly now: () => number;
    private readonly scheduler: NativeEngineScheduler;
    private readonly bindGlobalListener: NonNullable<
        NativeAudioElementEngineOptions["bindGlobalListener"]
    >;
    private readonly isPageHidden: () => boolean;
    private readonly iosBridgeGate: () => boolean;
    private readonly iosBridge: IosStandaloneAudioContextBridge;
    private readonly telemetry: (
        event: string,
        fields: Record<string, unknown>,
    ) => void;

    constructor(options: NativeAudioElementEngineOptions = {}) {
        this.createElement = options.createElement ?? createDefaultElement;
        this.now = options.now ?? Date.now;
        this.scheduler = options.scheduler ?? defaultScheduler;
        this.bindGlobalListener =
            options.bindGlobalListener ?? defaultBindGlobalListener;
        this.isPageHidden = options.isPageHidden ?? defaultIsPageHidden;
        this.iosBridgeGate =
            options.iosBridgeGate ?? detectIosStandaloneAudioBridgeEnvironment;
        this.iosBridge =
            options.iosBridge ?? new IosStandaloneAudioContextBridge();
        this.telemetry = options.telemetry ?? defaultTelemetry;
    }

    load(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    load(
        source: AudioEngineSource | string,
        autoplay?: boolean,
        format?: string,
    ): void;
    load(
        source: AudioEngineSource | string,
        optionsOrAutoplay: AudioEngineLoadOptions | boolean = {},
        format?: string,
    ): void {
        const resolvedSource = resolveSource(source);
        if (!resolvedSource.url) {
            throw new Error(
                "NativeAudioElementEngine.load requires a non-empty source URL.",
            );
        }
        const normalizedOptions: AudioEngineLoadOptions =
            typeof optionsOrAutoplay === "boolean"
                ? { autoplay: optionsOrAutoplay, format }
                : optionsOrAutoplay;

        // Computed before staging: is this a duplicate load for the
        // source the element already carries? (Howler parity — see the
        // policy's same-source dedupe.) Load-affecting options are part
        // of the identity: flipping withCredentials changes crossOrigin,
        // which is only applied on a fresh load.
        const sameLoadedSource =
            this.lastSource?.url === resolvedSource.url &&
            this.element?.src === resolvedSource.url &&
            Boolean(this.lastLoadOptions?.withCredentials) ===
                Boolean(normalizedOptions.withCredentials);

        this.lastSource = resolvedSource;
        this.lastLoadOptions = normalizedOptions;
        this.dispatch({
            type: "LOAD_REQUESTED",
            autoplay: Boolean(normalizedOptions.autoplay),
            startTimeSec:
                typeof normalizedOptions.startTimeSec === "number"
                    ? normalizedOptions.startTimeSec
                    : null,
            nowMs: this.now(),
            sameLoadedSource,
        });
    }

    play(): void {
        this.dispatch({
            type: "PLAY_REQUESTED",
            currentTimeSec: this.element?.currentTime ?? 0,
            nowMs: this.now(),
        });
    }

    pause(): void {
        this.dispatch({ type: "PAUSE_REQUESTED", nowMs: this.now() });
    }

    stop(): void {
        this.dispatch({ type: "STOP_REQUESTED", nowMs: this.now() });
    }

    seek(timeSec: number): void {
        this.dispatch({ type: "SEEK_REQUESTED", timeSec, nowMs: this.now() });
    }

    setVolume(value: number): void {
        this.volume = clampAudioVolume(value);
        if (this.element) {
            // Muting rides the element's muted flag, so volume can always
            // track — unmuting then resumes at the freshest user volume.
            this.element.volume = this.volume;
        }
        this.emit("volume", { volume: this.volume });
    }

    setMuted(value: boolean): void {
        this.muted = Boolean(value);
        if (this.element) {
            this.element.muted = this.muted;
        }
    }

    getCurrentTime(): number {
        return this.element?.currentTime ?? 0;
    }

    getDuration(): number {
        return toFiniteDuration(this.element?.duration ?? 0);
    }

    isPlaying(): boolean {
        return Boolean(
            this.element && !this.element.paused && !this.element.ended,
        );
    }

    on<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        let handlers = this.listeners.get(event);
        if (!handlers) {
            handlers = new Set();
            this.listeners.set(event, handlers);
        }
        handlers.add(handler as unknown as AnyAudioEventHandler);
    }

    off<T extends AudioEngineEventType>(
        event: T,
        handler: AudioEngineEventHandler<T>,
    ): void {
        this.listeners
            .get(event)
            ?.delete(handler as unknown as AnyAudioEventHandler);
    }

    preload(
        source: AudioEngineSource | string,
        options?: AudioEngineLoadOptions,
    ): void;
    preload(source: AudioEngineSource | string, format?: string): void;
    preload(
        source: AudioEngineSource | string,
        _optionsOrFormat?: AudioEngineLoadOptions | string,
    ): void {
        const resolvedSource = resolveSource(source);
        const url = resolvedSource.url;
        if (!url || url === this.lastSource?.url || url === this.preloadedUrl) {
            return;
        }
        const buffer = this.ensurePreloadElement();
        if (!buffer) {
            return;
        }
        buffer.src = url;
        this.preloadedUrl = url;
    }

    reload(): void {
        this.dispatch({ type: "RELOAD_REQUESTED", nowMs: this.now() });
    }

    getActualCurrentTime(): number {
        return this.getCurrentTime();
    }

    hasTrackEnded(): boolean {
        if (!this.element) {
            return false;
        }
        if (this.element.ended) {
            return true;
        }
        const duration = this.getDuration();
        return duration > 0 && this.element.currentTime >= duration - 0.1;
    }

    notifyTrackEnded(): void {
        this.dispatch({ type: "FORCE_ENDED", nowMs: this.now() });
    }

    isCurrentlySeeking(): boolean {
        if (this.policyState.pendingSeekSec !== null) {
            return true;
        }
        return (
            this.policyState.seekMarkUntilMs !== null &&
            this.now() < this.policyState.seekMarkUntilMs
        );
    }

    getSeekTarget(): number | null {
        return (
            this.policyState.seekTargetSec ?? this.policyState.pendingSeekSec
        );
    }

    destroy(): void {
        this.isDestroyed = true;
        this.cancelRetryTimer();
        this.stopTicker();
        this.disarmGestureRetry();
        this.disarmVisibilityRetry();
        this.pageShowCleanup?.();
        this.pageShowCleanup = null;
        this.elementCleanups.forEach((cleanup) => cleanup());
        this.elementCleanups = [];
        this.releaseElement(this.element);
        this.element = null;
        this.releaseElement(this.preloadElement);
        this.preloadElement = null;
        this.preloadedUrl = null;
        this.iosBridge.close();
        this.listeners.clear();
        this.policyState = createInitialNativeEngineState();
    }

    // ------------------------------------------------------------------
    // Policy plumbing
    // ------------------------------------------------------------------

    private dispatch(event: NativeEnginePolicyEvent): void {
        if (this.isDestroyed) {
            return;
        }
        const transition = transitionNativeEngine(this.policyState, event);
        this.policyState = transition.state;
        transition.effects.forEach((effect) => this.executeEffect(effect));
    }

    private executeEffect(effect: NativeEnginePolicyEffect): void {
        switch (effect.kind) {
            case "applyLoad":
                return this.applyLoad(effect.isRetry);
            case "applySeek":
                return this.applySeek(effect.timeSec);
            case "callPlay":
                return this.callPlay();
            case "callPause":
                return this.element?.pause();
            case "haltPlayback":
                return this.haltPlayback();
            case "startTicker":
                return this.startTicker();
            case "stopTicker":
                return this.stopTicker();
            case "scheduleRetry":
                return this.scheduleRetry(effect.delayMs);
            case "cancelRetry":
                return this.cancelRetryTimer();
            case "armGestureRetry":
                return this.armGestureRetry();
            case "disarmGestureRetry":
                return this.disarmGestureRetry();
            case "armVisibilityRetry":
                return this.armVisibilityRetry();
            case "disarmVisibilityRetry":
                return this.disarmVisibilityRetry();
            case "reloadFromSource":
                return this.reloadFromSource(
                    effect.resumeAtSec,
                    effect.resumePlaying,
                    effect.carryRetryBudget ?? false,
                );
            case "telemetry":
                return this.telemetry(effect.event, effect.fields);
            default:
                return this.executeEmitEffect(effect);
        }
    }

    private executeEmitEffect(effect: NativeEnginePolicyEffect): void {
        switch (effect.kind) {
            case "emitLoad":
                return this.emit("load", { durationSec: effect.durationSec });
            case "emitPlay":
                return this.emit("play", undefined);
            case "emitPause":
                return this.emit("pause", undefined);
            case "emitStop":
                return this.emit("stop", undefined);
            case "emitEnd":
                return this.emit("end", undefined);
            case "emitSeek":
                return this.emit("seek", { timeSec: effect.timeSec });
            case "emitTimeUpdate":
                return this.emit("timeupdate", { timeSec: effect.timeSec });
            case "emitBuffering":
                return this.emit("buffering", {
                    isBuffering: effect.isBuffering,
                    reason: effect.reason,
                });
            case "emitLoadError":
                return this.emitError("loaderror", effect);
            case "emitPlayError":
                return this.emitError("playerror", effect);
            default:
                return undefined;
        }
    }

    private emitError(
        event: "loaderror" | "playerror",
        effect: Extract<
            NativeEnginePolicyEffect,
            { kind: "emitLoadError" | "emitPlayError" }
        >,
    ): void {
        const payload = {
            error: new Error(effect.message),
            code: effect.code ?? undefined,
            recoverable: effect.recoverable,
        };
        this.emit(event, payload);
        this.emit("error", payload);
    }

    private emit(event: AudioEngineEventType, payload: unknown): void {
        this.listeners.get(event)?.forEach((handler) => {
            try {
                handler(payload);
            } catch (err) {
                sharedFrontendLogger.error(
                    `[NativeAudioEngine] Event listener error (${event}):`,
                    err,
                );
            }
        });
    }

    // ------------------------------------------------------------------
    // Effects
    // ------------------------------------------------------------------

    private applyLoad(isRetry: boolean): void {
        const element = this.ensureElement();
        const source = this.lastSource;
        if (!element || !source) {
            sharedFrontendLogger.error(
                "[NativeAudioEngine] Cannot apply load without an element and source.",
            );
            return;
        }
        this.loadGeneration += 1;
        if (this.preloadedUrl === source.url) {
            // Consumed by this load; the buffer element stays for reuse.
            this.preloadedUrl = null;
        }
        element.crossOrigin = this.lastLoadOptions?.withCredentials
            ? "use-credentials"
            : "anonymous";
        element.preload = "auto";
        // Assigning src synchronously stops the previous stream before the
        // new one exists — the structural double-play guarantee.
        element.src = source.url;
        if (isRetry) {
            this.telemetry("load_retry_applied", { url: source.url });
        }
    }

    private applySeek(timeSec: number): void {
        if (this.element) {
            this.element.currentTime = timeSec;
        }
    }

    private callPlay(): void {
        const element = this.element;
        if (!element) {
            sharedFrontendLogger.warn("[NativeAudioEngine] No audio loaded");
            return;
        }
        if (this.iosBridgeGate()) {
            this.iosBridge.ensureForElement(
                element as unknown as HTMLAudioElement,
            );
            this.iosBridge.resumeIfSuspended();
        }
        const generationAtPlay = this.loadGeneration;
        const result = element.play();
        if (result && typeof result.catch === "function") {
            result.catch((err: unknown) => {
                if (
                    this.isDestroyed ||
                    generationAtPlay !== this.loadGeneration
                ) {
                    return;
                }
                const errorName =
                    err instanceof Error && err.name
                        ? err.name
                        : "UnknownError";
                const errorMessage =
                    err instanceof Error ? err.message : String(err);
                this.dispatch({
                    type: "PLAY_PROMISE_REJECTED",
                    errorName,
                    errorMessage,
                    isPageHidden: this.isPageHidden(),
                    nowMs: this.now(),
                });
            });
        }
    }

    private haltPlayback(): void {
        if (!this.element) {
            return;
        }
        this.element.pause();
        try {
            this.element.currentTime = 0;
        } catch {
            // Intentionally ignored: resetting position on an element with
            // no seekable range throws on some platforms.
        }
    }

    private reloadFromSource(
        resumeAtSec: number,
        resumePlaying: boolean,
        carryRetryBudget: boolean,
    ): void {
        if (!this.lastSource) {
            return;
        }
        // Dispatch directly (instead of via the public load()) so
        // engine-initiated recovery can carry the retry budget across
        // the reload; the staged source and options stay as provided by
        // the orchestrator.
        this.dispatch({
            type: "LOAD_REQUESTED",
            autoplay: resumePlaying,
            startTimeSec: resumeAtSec > 0 ? resumeAtSec : null,
            nowMs: this.now(),
            carryRetryBudget,
            // Recovery reloads exist to re-fetch the source; they must
            // bypass the same-source dedupe.
            force: true,
        });
    }

    private scheduleRetry(delayMs: number): void {
        this.cancelRetryTimer();
        this.retryTimerId = this.scheduler.setTimer(() => {
            this.retryTimerId = null;
            this.dispatch({ type: "RETRY_TIMER_FIRED", nowMs: this.now() });
        }, delayMs);
    }

    private cancelRetryTimer(): void {
        if (this.retryTimerId !== null) {
            this.scheduler.clearTimer(this.retryTimerId);
            this.retryTimerId = null;
        }
    }

    private startTicker(): void {
        this.stopTicker();
        this.tickerId = this.scheduler.setTicker(() => {
            if (this.element) {
                this.dispatch({
                    type: "ELEMENT_TIME_UPDATE",
                    timeSec: this.element.currentTime,
                    nowMs: this.now(),
                });
            }
        }, TICKER_INTERVAL_MS);
    }

    private stopTicker(): void {
        if (this.tickerId !== null) {
            this.scheduler.clearTicker(this.tickerId);
            this.tickerId = null;
        }
    }

    private armGestureRetry(): void {
        this.disarmGestureRetry();
        this.gestureCleanups = GESTURE_EVENT_TYPES.map((type) =>
            this.bindGlobalListener("document", type, () => {
                this.dispatch({
                    type: "GESTURE_RETRY_FIRED",
                    nowMs: this.now(),
                });
            }),
        );
    }

    private disarmGestureRetry(): void {
        this.gestureCleanups.forEach((cleanup) => cleanup());
        this.gestureCleanups = [];
    }

    private armVisibilityRetry(): void {
        this.disarmVisibilityRetry();
        this.visibilityRetryCleanup = this.bindGlobalListener(
            "document",
            "visibilitychange",
            () => {
                if (this.isPageHidden()) {
                    return;
                }
                this.dispatch({
                    type: "VISIBILITY_RETRY_FIRED",
                    nowMs: this.now(),
                });
            },
        );
    }

    private disarmVisibilityRetry(): void {
        if (this.visibilityRetryCleanup) {
            this.visibilityRetryCleanup();
            this.visibilityRetryCleanup = null;
        }
    }

    // ------------------------------------------------------------------
    // Element lifecycle
    // ------------------------------------------------------------------

    private ensureElement(): NativeAudioElementLike | null {
        if (this.element) {
            return this.element;
        }
        const element = this.createElement();
        if (!element) {
            return null;
        }
        element.preload = "auto";
        element.volume = this.volume;
        element.muted = this.muted;
        this.element = element;
        this.bindElementEvents(element);
        if (!this.pageShowCleanup) {
            this.pageShowCleanup = this.bindGlobalListener(
                "window",
                "pageshow",
                (event) => this.handlePageShow(event),
            );
        }
        return element;
    }

    private ensurePreloadElement(): NativeAudioElementLike | null {
        if (this.preloadElement) {
            return this.preloadElement;
        }
        const element = this.createElement();
        if (!element) {
            return null;
        }
        // The one exception to "single element": a muted, non-playing
        // buffer dedicated to preload. It is never audible and never
        // grows past one instance (GH #42 §9).
        element.muted = true;
        element.volume = 0;
        element.preload = "auto";
        this.preloadElement = element;
        return element;
    }

    private releaseElement(element: NativeAudioElementLike | null): void {
        if (!element) {
            return;
        }
        try {
            element.pause();
            element.removeAttribute("src");
            element.load();
        } catch {
            // Intentionally ignored: teardown errors on a released element
            // are harmless.
        }
    }

    private bindElementEvents(element: NativeAudioElementLike): void {
        ELEMENT_EVENT_TYPES.forEach((type) => {
            const handler = (): void => this.handleElementEvent(type);
            element.addEventListener(type, handler);
            this.elementCleanups.push(() =>
                element.removeEventListener(type, handler),
            );
        });
    }

    private handleElementEvent(
        type: (typeof ELEMENT_EVENT_TYPES)[number],
    ): void {
        const element = this.element;
        if (!element || this.isDestroyed) {
            return;
        }
        const nowMs = this.now();
        switch (type) {
            case "loadedmetadata":
                return this.dispatch({
                    type: "LOADED_METADATA",
                    durationSec: toFiniteDuration(element.duration),
                    nowMs,
                });
            case "playing":
                return this.dispatch({ type: "ELEMENT_PLAYING", nowMs });
            case "pause":
                return this.dispatch({
                    type: "ELEMENT_PAUSED",
                    atEndOfStream: isAtEndOfStream(element),
                    nowMs,
                });
            case "ended":
                return this.dispatch({ type: "ELEMENT_ENDED", nowMs });
            case "seeked":
                return this.dispatch({
                    type: "ELEMENT_SEEKED",
                    timeSec: element.currentTime,
                    nowMs,
                });
            case "timeupdate":
                return this.dispatch({
                    type: "ELEMENT_TIME_UPDATE",
                    timeSec: element.currentTime,
                    nowMs,
                });
            case "waiting":
                return this.emit("buffering", {
                    isBuffering: true,
                    reason: "waiting",
                });
            case "error":
                return this.dispatch({
                    type: "ELEMENT_ERROR",
                    mediaErrorCode: element.error?.code ?? null,
                    mediaErrorMessage: element.error?.message ?? null,
                    isPageHidden: this.isPageHidden(),
                    currentTimeSec: element.currentTime || 0,
                    nowMs,
                });
            default:
                return undefined;
        }
    }

    private handlePageShow(event: unknown): void {
        const persisted =
            typeof event === "object" &&
            event !== null &&
            (event as { persisted?: boolean }).persisted === true;
        if (!persisted || !this.element) {
            return;
        }
        this.dispatch({
            type: "PAGE_RESTORED",
            elementPaused: this.element.paused,
            elementEnded: this.element.ended,
            nowMs: this.now(),
        });
    }
}
