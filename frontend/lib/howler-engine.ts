import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * Howler.js Audio Engine
 *
 * Singleton manager for audio playback using Howler.js
 * Handles: play, pause, seek, volume, track changes, events
 */

import { Howl, HowlOptions, Howler } from "howler";
import { DEFAULT_AUDIO_VOLUME, clampAudioVolume } from "@/lib/audio-volume";

const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";
const HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_KEY =
    "HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED";

interface ExtendedHowlOptions extends HowlOptions {
    xhr?: {
        method?: string;
        headers?: Record<string, string>;
        withCredentials?: boolean;
        timeout?: number;
    };
}

export interface HowlerRequestOptions {
    withCredentials?: boolean;
    requestHeaders?: Record<string, string>;
    timeoutMs?: number;
}

export type HowlerEventType =
    | "play"
    | "pause"
    | "stop"
    | "end"
    | "seek"
    | "volume"
    | "load"
    | "loaderror"
    | "playerror"
    | "timeupdate";

export type HowlerEventCallback = (data?: unknown) => void;

interface HowlerEngineState {
    currentSrc: string | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    isMuted: boolean;
}

interface NavigatorAudioSession {
    type?: string;
}

const readRuntimeConfigValue = (key: string): unknown => {
    if (typeof window === "undefined") {
        return undefined;
    }

    const runtimeConfig = (
        window as Window & {
            [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
        }
    )[SOUNDSPAN_RUNTIME_CONFIG_KEY];
    return runtimeConfig?.[key];
};

const resolveRuntimeConfigBoolean = (key: string): boolean => {
    const runtimeValue = readRuntimeConfigValue(key);
    if (typeof runtimeValue === "boolean") {
        return runtimeValue;
    }

    return String(runtimeValue ?? "").trim().toLowerCase() === "true";
};

const isHowlerIosLockscreenWorkaroundsEnabled = (): boolean =>
    resolveRuntimeConfigBoolean(HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED_KEY);

const isIosDevice = (): boolean => {
    if (typeof navigator === "undefined") {
        return false;
    }

    const userAgent = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return (
        /iPad|iPhone|iPod/i.test(userAgent) ||
        (platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1)
    );
};

class HowlerEngine {
    private howl: Howl | null = null;
    private timeUpdateInterval: NodeJS.Timeout | null = null;
    private eventListeners: Map<HowlerEventType, Set<HowlerEventCallback>> =
        new Map();
    private state: HowlerEngineState = {
        currentSrc: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: DEFAULT_AUDIO_VOLUME,
        isMuted: false,
    };
    private isLoading: boolean = false; // Guard against duplicate loads
    private userInitiatedPlay: boolean = false; // Track if play was user-initiated
    private retryCount: number = 0; // Track retry attempts
    private maxRetries: number = 3; // Max retry attempts for load errors
    private playRetryCount: number = 0; // Retry attempts for play/start failures
    private maxPlayRetries: number = 1; // Keep conservative to avoid loops
    private pendingAutoplay: boolean = false; // Track pending autoplay for retries
    private lastFormat: string | undefined; // Store format for retries
    private lastRequestOptions: HowlerRequestOptions | undefined; // Store request options for retries/reload
    private readonly popFadeMs: number = 10; // ms - micro-fade to reduce click/pop on track changes
    private shouldRetryLoads: boolean = false; // Only retry transient load errors where it helps (Android WebView)
    private cleanupTimeoutId: NodeJS.Timeout | null = null; // Track cleanup timeout to prevent race conditions
    private playRetryTimeoutId: NodeJS.Timeout | null = null; // Delayed retry for play/start failures
    private pendingCleanupHowls: Set<Howl> = new Set(); // Track Howls being cleaned up
    private iosAudioSessionConfigured: boolean = false;

    // Seek state management - prevents stale timeupdate events during seeks
    private isSeeking: boolean = false;
    private seekTargetTime: number | null = null;
    private seekTimeoutId: NodeJS.Timeout | null = null;

    // Preload state - for gapless playback
    private preloadHowl: Howl | null = null;
    private preloadSrc: string | null = null;
    private preloadFormat: string | undefined = undefined;
    private isPreloading: boolean = false;

    constructor() {
        // Initialize event listener maps
        const events: HowlerEventType[] = [
            "play",
            "pause",
            "stop",
            "end",
            "seek",
            "volume",
            "load",
            "loaderror",
            "playerror",
            "timeupdate",
        ];
        events.forEach((event) => this.eventListeners.set(event, new Set()));
        this.applyHowlerGlobalPlaybackConfig();
    }

    /**
     * Load and optionally play a new audio source
     * @param src - Audio URL
     * @param autoplay - Whether to auto-play after loading
     * @param format - Audio format hint (mp3, flac, etc.) - required for URLs without extensions
     * @param requestOptions - Optional request headers/credentials/timeout for fetch-backed loads
     */
    load(
        src: string,
        autoplay: boolean = false,
        format?: string,
        isRetry: boolean = false,
        requestOptions?: HowlerRequestOptions
    ): void {
        // Don't reload if same source and already loaded
        if (this.state.currentSrc === src && this.howl) {
            if (autoplay && !this.state.isPlaying) {
                this.play();
            }
            return;
        }

        // Prevent duplicate loads - if already loading this URL, skip
        if (this.isLoading && this.state.currentSrc === src) {
            return;
        }

        // Check if this source is preloaded - enables instant gapless switching
        if (this.isPreloaded(src)) {
            const preloadedHowl = this.getPreloadedHowl(src);
            if (preloadedHowl) {
                // Clean up current track immediately to prevent doubled audio
                this.cleanup(true);

                this.state.currentSrc = src;
                this.howl = preloadedHowl;

                // Set up event handlers for the preloaded instance
                this.setupHowlEventHandlers();

                // Set correct volume
                const targetVolume = this.state.isMuted ? 0 : this.state.volume;
                this.howl.volume(targetVolume);

                // Mark as loaded and emit asynchronously
                // IMPORTANT: Must be async so callers can register listeners before event fires
                this.isLoading = false;
                this.state.duration = this.howl.duration() || 0;

                // Use setTimeout to emit after caller registers listeners
                setTimeout(() => {
                    this.emit("load", { duration: this.state.duration });
                    if (autoplay) {
                        this.play();
                    }
                }, 0);
                return;
            }
        }

        // Set loading guard immediately
        this.isLoading = true;

        // Immediate cleanup to prevent doubled audio from race conditions
        this.cleanup(true);

        this.state.currentSrc = src;

        // Detect if running in Android WebView (for graceful degradation)
        const isAndroidWebView =
            typeof navigator !== "undefined" &&
            /wv/.test(navigator.userAgent.toLowerCase()) &&
            /android/.test(navigator.userAgent.toLowerCase());
        this.shouldRetryLoads = isAndroidWebView;

        // Check if this is a podcast/audiobook stream (they need HTML5 Audio for Range request support)
        const isPodcastOrAudiobook =
            src.includes("/api/podcasts/") || src.includes("/api/audiobooks/");
        const xhrOptions = this.buildXhrOptions(
            isAndroidWebView,
            requestOptions
        );

        // Build Howl config
        // Note: On Android WebView, HTML5 Audio causes crackling/popping on track changes
        // Use Web Audio API on Android for smoother playback (trades streaming for quality)
        // EXCEPTION: Podcasts always use HTML5 Audio because they need Range request support
        // for seeking in large files. Web Audio would try to download the entire ~100MB file.
        const howlConfig: ExtendedHowlOptions = {
            src: [src],
            html5: isPodcastOrAudiobook || !isAndroidWebView, // HTML5 for podcasts/audiobooks OR non-Android
            autoplay: false, // We'll handle autoplay with fade
            preload: true,
            volume: this.state.isMuted ? 0 : this.state.volume,
            ...(xhrOptions ? { xhr: xhrOptions } : {}),
        };

        // Store for potential retry
        this.pendingAutoplay = autoplay;
        this.lastFormat = format;
        this.lastRequestOptions = requestOptions
            ? {
                  ...requestOptions,
                  requestHeaders: requestOptions.requestHeaders
                      ? { ...requestOptions.requestHeaders }
                      : undefined,
              }
            : undefined;
        this.playRetryCount = 0;
        this.clearPlayRetryTimeout();
        // Reset retry count only when this is NOT a retry attempt.
        // If we reset on retries, we can end up in an infinite retry loop.
        if (!isRetry) {
            this.retryCount = 0;
        }

        // Add format hint if provided
        // Only use the specific format - fallbacks cause wrong decoder attempts
        if (format) {
            howlConfig.format = [format];
        }
        // If no format provided, let Howler detect from Content-Type header

        this.howl = new Howl({
            ...howlConfig,
            onload: () => {
                this.isLoading = false;
                this.state.duration = this.howl?.duration() || 0;
                this.emit("load", { duration: this.state.duration });

                if (autoplay) {
                    this.play();
                }
            },
            onloaderror: (id, error) => {
                sharedFrontendLogger.error(
                    "[HowlerEngine] Load error:",
                    error,
                    "Attempt:",
                    this.retryCount + 1
                );
                this.isLoading = false;

                // Retry logic for transient errors (common on Android WebView)
                if (
                    this.shouldRetryLoads &&
                    this.retryCount < this.maxRetries &&
                    this.state.currentSrc
                ) {
                    this.retryCount++;

                    // Save src before cleanup
                    const srcToRetry = this.state.currentSrc;
                    const autoplayToRetry = this.pendingAutoplay;
                    const formatToRetry = this.lastFormat;
                    const requestOptionsToRetry = this.lastRequestOptions;

                    // CRITICAL: Clean up the failed Howl instance BEFORE retrying
                    // This prevents "HTML5 Audio pool exhausted" errors
                    this.cleanup();

                    // Wait a bit before retrying
                    setTimeout(() => {
                        this.load(
                            srcToRetry,
                            autoplayToRetry,
                            formatToRetry,
                            true,
                            requestOptionsToRetry
                        );
                    }, 500 * this.retryCount); // Exponential backoff
                    return;
                }

                // All retries failed - clean up and emit error
                this.retryCount = 0;
                this.cleanup(); // Clean up failed instance
                this.emit("loaderror", { error });
            },
            onplayerror: (id, error) => {
                this.handlePlayError(error);
            },
            onplay: () => {
                this.state.isPlaying = true;
                this.userInitiatedPlay = false; // Clear flag after successful play
                this.playRetryCount = 0;
                this.clearPlayRetryTimeout();
                this.startTimeUpdates();
                this.emit("play");
            },
            onpause: () => {
                this.state.isPlaying = false;
                this.userInitiatedPlay = false;
                this.stopTimeUpdates();
                this.emit("pause");
            },
            onstop: () => {
                this.state.isPlaying = false;
                this.state.currentTime = 0;
                this.stopTimeUpdates();
                this.emit("stop");
            },
            onend: () => {
                this.state.isPlaying = false;
                this.stopTimeUpdates();
                this.emit("end");
            },
            onseek: () => {
                if (this.howl) {
                    this.state.currentTime = this.howl.seek() as number;
                    this.emit("seek", { time: this.state.currentTime });
                }
            },
        });
    }

    /**
     * Play audio (user-initiated)
     */
    play(): void {
        if (!this.howl) {
            sharedFrontendLogger.warn("[HowlerEngine] No audio loaded");
            return;
        }

        // Guard against stale state: Howler can still be playing even if our
        // local flag got out of sync during transient network errors.
        if (this.state.isPlaying || this.howl.playing()) {
            this.state.isPlaying = true;
            return;
        }

        // Mark as user-initiated for autoplay recovery
        this.userInitiatedPlay = true;
        this.applyHowlerGlobalPlaybackConfig();

        // Some browsers keep WebAudio suspended on first interaction in edge cases.
        // Attempt a best-effort resume before/around play().
        this.resumeAudioContextIfNeeded();
        this.configureIosAudioSessionForPlayback();

        // Ensure volume is set correctly before playing
        const targetVolume = this.state.isMuted ? 0 : this.state.volume;
        this.howl.volume(targetVolume);
        this.howl.play();
    }

    /**
     * Pause audio
     */
    pause(): void {
        if (!this.howl || !this.state.isPlaying) return;
        this.howl.pause();
    }

    /**
     * Stop playback completely
     */
    stop(): void {
        if (!this.howl) return;
        this.clearPlayRetryTimeout();
        this.howl.stop();
    }

    /**
     * Seek to a specific time
     * Includes seek locking to prevent stale timeupdate events from causing UI flicker
     */
    seek(time: number): void {
        if (!this.howl) return;

        // Set seek lock - this prevents timeupdate from emitting stale values
        this.isSeeking = true;
        this.seekTargetTime = time;

        // Clear any existing seek timeout
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
        }

        this.state.currentTime = time;
        this.howl.seek(time);
        this.emit("seek", { time });

        // Release seek lock after audio has time to sync
        // This timeout ensures timeupdate doesn't emit stale values during the seek operation
        this.seekTimeoutId = setTimeout(() => {
            this.isSeeking = false;
            this.seekTargetTime = null;
            this.seekTimeoutId = null;
        }, 300);
    }

    /**
     * Check if currently in a seek operation
     */
    isCurrentlySeeking(): boolean {
        return this.isSeeking;
    }

    /**
     * Get the target seek position (if seeking)
     */
    getSeekTarget(): number | null {
        return this.seekTargetTime;
    }

    /**
     * Force reload the audio from current source
     * Used after cache is ready to enable seeking
     */
    reload(): void {
        if (!this.state.currentSrc) return;

        const src = this.state.currentSrc;
        const format = this.howl ? (this.howl as unknown as { _format?: string[] })._format : undefined;

        this.cleanup();
        this.load(src, false, format?.[0], false, this.lastRequestOptions);
    }

    /**
     * Preload a track in the background for gapless playback
     * @param src - Audio URL to preload
     * @param format - Audio format hint (mp3, flac, etc.)
     * @param requestOptions - Optional request headers/credentials/timeout for fetch-backed loads
     */
    preload(
        src: string,
        format?: string,
        requestOptions?: HowlerRequestOptions
    ): void {
        // Don't preload if same as current source
        if (this.state.currentSrc === src) {
            return;
        }

        // Don't preload if already preloading/preloaded same source
        if (this.preloadSrc === src) {
            return;
        }

        // Cancel any existing preload first
        this.cancelPreload();

        this.isPreloading = true;
        this.preloadSrc = src;
        this.preloadFormat = format;

        // Detect if running in Android WebView
        const isAndroidWebView =
            typeof navigator !== "undefined" &&
            /wv/.test(navigator.userAgent.toLowerCase()) &&
            /android/.test(navigator.userAgent.toLowerCase());

        // Check if this is a podcast/audiobook stream
        const isPodcastOrAudiobook =
            src.includes("/api/podcasts/") || src.includes("/api/audiobooks/");
        const xhrOptions = this.buildXhrOptions(
            isAndroidWebView,
            requestOptions
        );

        // Build Howl config (same logic as load())
        const howlConfig: ExtendedHowlOptions = {
            src: [src],
            html5: isPodcastOrAudiobook || !isAndroidWebView,
            autoplay: false,
            preload: true,
            volume: 0, // Start muted for preload
            ...(xhrOptions ? { xhr: xhrOptions } : {}),
        };

        // Only add format if provided
        if (format) {
            howlConfig.format = [format];
        }

        this.preloadHowl = new Howl({
            ...howlConfig,
            onload: () => {
                this.isPreloading = false;
            },
            onloaderror: (id, error) => {
                sharedFrontendLogger.error("[HowlerEngine] Preload error:", error);
                this.cancelPreload();
            },
        });
    }

    /**
     * Cancel any in-progress preload
     */
    cancelPreload(): void {
        if (this.preloadHowl) {
            try {
                this.preloadHowl.unload();
            } catch {
                // Intentionally ignored: cleanup errors are harmless
            }
            this.preloadHowl = null;
        }
        this.preloadSrc = null;
        this.preloadFormat = undefined;
        this.isPreloading = false;
    }

    /**
     * Check if a source is preloaded and ready
     * @param src - Audio URL to check
     */
    isPreloaded(src: string): boolean {
        return (
            this.preloadSrc === src &&
            this.preloadHowl !== null &&
            !this.isPreloading
        );
    }

    /**
     * Get the preloaded Howl instance and transfer ownership
     * After calling this, the caller owns the Howl and must manage its lifecycle
     * @param src - Audio URL to get preloaded Howl for
     * @returns The preloaded Howl instance or null if not preloaded
     */
    getPreloadedHowl(src: string): Howl | null {
        if (!this.isPreloaded(src)) {
            return null;
        }

        const howl = this.preloadHowl;
        // Transfer ownership - clear preload state without unloading
        this.preloadHowl = null;
        this.preloadSrc = null;
        this.preloadFormat = undefined;
        this.isPreloading = false;

        return howl;
    }

    /**
     * Set volume (0-1)
     */
    setVolume(volume: number): void {
        this.state.volume = clampAudioVolume(volume);

        if (this.howl && !this.state.isMuted) {
            this.howl.volume(this.state.volume);
        }

        this.emit("volume", { volume: this.state.volume });
    }

    /**
     * Mute/unmute
     */
    setMuted(muted: boolean): void {
        this.state.isMuted = muted;

        if (this.howl) {
            this.howl.volume(muted ? 0 : this.state.volume);
        }
    }

    /**
     * Get current playback state
     */
    getState(): Readonly<HowlerEngineState> {
        return { ...this.state };
    }

    /**
     * Get current time (from Howler's state)
     */
    getCurrentTime(): number {
        if (this.howl) {
            const seek = this.howl.seek();
            return typeof seek === "number" ? seek : 0;
        }
        return 0;
    }

    /**
     * Get the ACTUAL current time from the HTML5 audio element
     * This is more accurate than Howler's reported position after failed seeks
     */
    getActualCurrentTime(): number {
        if (!this.howl) return 0;

        try {
            // Access the underlying HTML5 audio element
            const sounds = (this.howl as unknown as { _sounds?: Array<{ _node?: HTMLAudioElement }> })._sounds;
            if (sounds && sounds.length > 0 && sounds[0]._node) {
                return sounds[0]._node.currentTime || 0;
            }
        } catch {
            // Fallback to Howler's reported time
        }

        return this.getCurrentTime();
    }

    /**
     * Get duration
     */
    getDuration(): number {
        return this.howl?.duration() || 0;
    }

    /**
     * Check if currently playing
     */
    isPlaying(): boolean {
        return this.howl?.playing() || false;
    }

    /**
     * Subscribe to events
     */
    on(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.add(callback);
    }

    /**
     * Unsubscribe from events
     */
    off(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    /**
     * Emit event to all listeners
     */
    private emit(event: HowlerEventType, data?: unknown): void {
        this.eventListeners.get(event)?.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                sharedFrontendLogger.error(
                    `[HowlerEngine] Event listener error (${event}):`,
                    err
                );
            }
        });
    }

    /**
     * Start time update interval
     */
    private startTimeUpdates(): void {
        this.stopTimeUpdates();

        this.timeUpdateInterval = setInterval(() => {
            if (this.howl && this.state.isPlaying) {
                const seek = this.howl.seek();
                if (typeof seek === "number") {
                    // During a seek operation, ignore timeupdate events that report stale positions
                    // This prevents the UI flicker where old position briefly shows during seek
                    if (this.isSeeking && this.seekTargetTime !== null) {
                        const isNearTarget = Math.abs(seek - this.seekTargetTime) < 2;
                        if (!isNearTarget) {
                            // Stale position - don't emit, use target instead
                            return;
                        }
                        // Position is near target, seek completed - clear seek state
                        this.isSeeking = false;
                        this.seekTargetTime = null;
                        if (this.seekTimeoutId) {
                            clearTimeout(this.seekTimeoutId);
                            this.seekTimeoutId = null;
                        }
                    }
                    
                    this.state.currentTime = seek;
                    this.emit("timeupdate", { time: seek });
                }
            }
        }, 250); // Update 4 times per second
    }

    /**
     * Stop time update interval
     */
    private stopTimeUpdates(): void {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }

    /**
     * Set up event handlers on a Howl instance
     * Used to attach handlers to preloaded instances after ownership transfer
     */
    private setupHowlEventHandlers(): void {
        if (!this.howl) return;

        this.howl.on("play", () => {
            this.state.isPlaying = true;
            this.userInitiatedPlay = false;
            this.playRetryCount = 0;
            this.clearPlayRetryTimeout();
            this.startTimeUpdates();
            this.emit("play");
        });

        this.howl.on("pause", () => {
            this.state.isPlaying = false;
            this.userInitiatedPlay = false;
            this.stopTimeUpdates();
            this.emit("pause");
        });

        this.howl.on("stop", () => {
            this.state.isPlaying = false;
            this.state.currentTime = 0;
            this.stopTimeUpdates();
            this.emit("stop");
        });

        this.howl.on("end", () => {
            this.state.isPlaying = false;
            this.stopTimeUpdates();
            this.emit("end");
        });

        this.howl.on("seek", () => {
            if (this.howl) {
                this.state.currentTime = this.howl.seek() as number;
                this.emit("seek", { time: this.state.currentTime });
            }
        });

        this.howl.on("playerror", (id, error) => {
            this.handlePlayError(error);
        });
    }

    private handlePlayError(error: unknown): void {
        sharedFrontendLogger.error("[HowlerEngine] Play error:", error);
        this.state.isPlaying = false;
        this.userInitiatedPlay = false;
        this.stopTimeUpdates();

        const sourceAtError = this.state.currentSrc;
        if (sourceAtError) {
            this.scheduleUnlockRetry(sourceAtError);
        }

        const canRetryPlay =
            Boolean(sourceAtError) && this.playRetryCount < this.maxPlayRetries;

        if (canRetryPlay) {
            this.playRetryCount += 1;
            this.schedulePlayRetry(sourceAtError);
        }

        this.emit("playerror", { error });
    }

    private scheduleUnlockRetry(source: string): void {
        if (!this.howl || !this.isIosLockscreenWorkaroundEnabled()) {
            return;
        }

        const howlAtError = this.howl;
        howlAtError.once("unlock", () => {
            if (!this.howl || this.howl !== howlAtError) return;
            if (this.state.currentSrc !== source) return;
            if (this.howl.playing()) return;

            this.applyHowlerGlobalPlaybackConfig();
            this.resumeAudioContextIfNeeded();
            this.configureIosAudioSessionForPlayback();
            const targetVolume = this.state.isMuted ? 0 : this.state.volume;
            this.howl.volume(targetVolume);
            this.howl.play();
        });
    }

    private schedulePlayRetry(source: string | null): void {
        if (!source) return;

        this.clearPlayRetryTimeout();
        this.playRetryTimeoutId = setTimeout(() => {
            this.playRetryTimeoutId = null;

            if (!this.howl) return;
            if (this.state.currentSrc !== source) return;
            if (this.howl.playing()) return;

            this.applyHowlerGlobalPlaybackConfig();
            this.resumeAudioContextIfNeeded();
            this.configureIosAudioSessionForPlayback();
            const targetVolume = this.state.isMuted ? 0 : this.state.volume;
            this.howl.volume(targetVolume);
            this.howl.play();
        }, 250);
    }

    private clearPlayRetryTimeout(): void {
        if (this.playRetryTimeoutId) {
            clearTimeout(this.playRetryTimeoutId);
            this.playRetryTimeoutId = null;
        }
    }

    private resumeAudioContextIfNeeded(): void {
        if (typeof window === "undefined") return;

        const ctx = (Howler as unknown as { ctx?: AudioContext }).ctx;
        if (!ctx) return;
        if (ctx.state === "running") return;

        void ctx.resume().catch((err) => {
            sharedFrontendLogger.warn("[HowlerEngine] Failed to resume audio context:", err);
        });
    }

    private isIosLockscreenWorkaroundEnabled(): boolean {
        return isIosDevice() && isHowlerIosLockscreenWorkaroundsEnabled();
    }

    private applyHowlerGlobalPlaybackConfig(): void {
        if (!this.isIosLockscreenWorkaroundEnabled()) {
            return;
        }

        Howler.autoUnlock = true;
        Howler.autoSuspend = false;
    }

    private configureIosAudioSessionForPlayback(): void {
        if (!this.isIosLockscreenWorkaroundEnabled()) {
            return;
        }
        if (this.iosAudioSessionConfigured || typeof navigator === "undefined") {
            return;
        }

        const audioSession = (
            navigator as Navigator & { audioSession?: NavigatorAudioSession }
        ).audioSession;
        if (!audioSession) {
            return;
        }

        try {
            audioSession.type = "playback";
            this.iosAudioSessionConfigured = true;
        } catch (err) {
            sharedFrontendLogger.warn(
                "[HowlerEngine] Failed to set navigator.audioSession.type=playback:",
                err
            );
        }
    }

    private buildXhrOptions(
        isAndroidWebView: boolean,
        requestOptions?: HowlerRequestOptions
    ): ExtendedHowlOptions["xhr"] | undefined {
        const timeoutOverride =
            typeof requestOptions?.timeoutMs === "number" &&
            Number.isFinite(requestOptions.timeoutMs) &&
            requestOptions.timeoutMs > 0
                ? requestOptions.timeoutMs
                : undefined;
        const timeout = timeoutOverride ?? (isAndroidWebView ? 30000 : undefined);
        const hasHeaders =
            Boolean(requestOptions?.requestHeaders) &&
            Object.keys(requestOptions?.requestHeaders ?? {}).length > 0;
        const hasWithCredentials =
            typeof requestOptions?.withCredentials === "boolean";

        if (!hasHeaders && !hasWithCredentials && typeof timeout !== "number") {
            return undefined;
        }

        return {
            ...(hasHeaders
                ? {
                      headers: {
                          ...requestOptions?.requestHeaders,
                      },
                  }
                : {}),
            ...(hasWithCredentials
                ? { withCredentials: requestOptions?.withCredentials }
                : {}),
            ...(typeof timeout === "number" ? { timeout } : {}),
        };
    }

    /**
     * Cleanup current Howl instance
     * Safe for rapid consecutive calls - tracks pending cleanups
     * @param immediate - Skip fade and clean up synchronously (used during track changes to prevent doubled audio)
     */
    private cleanup(immediate: boolean = false): void {
        this.cancelPreload();
        this.stopTimeUpdates();
        this.clearPlayRetryTimeout();
        this.playRetryCount = 0;

        // Cancel any pending cleanup timeout
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }

        if (this.howl) {
            const oldHowl = this.howl;
            const wasPlaying = this.state.isPlaying;
            const targetVolume = this.state.isMuted ? 0 : this.state.volume;

            // Detach immediately so new loads don't race with cleanup
            this.howl = null;

            // Track this howl for cleanup
            this.pendingCleanupHowls.add(oldHowl);

            const finalizeCleanup = (howl: Howl) => {
                try {
                    howl.stop();
                    howl.unload();
                } catch {
                    // Intentionally ignored: Howl instance is being destroyed
                }
                // Remove from pending set
                this.pendingCleanupHowls.delete(howl);
            };

            try {
                if (wasPlaying && !immediate) {
                    // Micro-fade before stop/unload to reduce click/pop artifacts
                    oldHowl.fade(targetVolume, 0, this.popFadeMs);
                    this.cleanupTimeoutId = setTimeout(() => {
                        this.cleanupTimeoutId = null;
                        finalizeCleanup(oldHowl);
                    }, this.popFadeMs + 2);
                } else {
                    // Immediate cleanup - no fade delay (track changes, or not playing)
                    if (wasPlaying) {
                        oldHowl.stop();
                    }
                    finalizeCleanup(oldHowl);
                }
            } catch {
                // Intentionally ignored: cleanup errors on destroyed Howl are harmless
                finalizeCleanup(oldHowl);
            }
        }

        this.state.currentSrc = null;
        this.state.isPlaying = false;
        this.state.currentTime = 0;
        this.state.duration = 0;
    }

    /**
     * Destroy the engine completely
     */
    destroy(): void {
        this.cleanup();
        // Note: cancelPreload() is already called by cleanup()
        this.isLoading = false;
        this.eventListeners.clear();
        this.clearPlayRetryTimeout();

        // Clean up any pending Howls from rapid cleanup calls
        for (const howl of this.pendingCleanupHowls) {
            try {
                howl.stop();
                howl.unload();
            } catch {
                // Ignore cleanup errors
            }
        }
        this.pendingCleanupHowls.clear();

        // Ensure cleanup timeout is cleared
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }
        // Clear seek state
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
            this.seekTimeoutId = null;
        }
        this.isSeeking = false;
        this.seekTargetTime = null;
    }
}

// Export singleton instance
export const howlerEngine = new HowlerEngine();

// Also export class for testing
export { HowlerEngine };
