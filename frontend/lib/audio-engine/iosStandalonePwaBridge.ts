/**
 * iOS Standalone PWA AudioContext Bridge
 *
 * In standalone (installed) PWAs, iOS suspends background audio behavior
 * of a bare `HTMLAudioElement`: the next track fails to auto-play at
 * track end and MediaSession controls go dead while the UI still claims
 * "playing" (WebKit bug 261858; iOS standalone only — Safari-tab
 * playback is unaffected). Routing the element through an `AudioContext`
 * (`createMediaElementSource` → `destination`) holds the audio session
 * durably across backgrounding.
 *
 * This is the ONE sanctioned AudioContext path for the native element
 * engine (GH #42 §7). The gate is exactly: iOS user agent AND standalone
 * display mode. Desktop, Android, and iOS Safari tabs keep the bare
 * element pipeline for hi-res playback. iOS hardware output is 48 kHz
 * regardless, so the bridge costs nothing there.
 */

import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export interface IosStandaloneBridgeEnvironmentInput {
    /** navigator.userAgent */
    userAgent: string;
    /** navigator.maxTouchPoints (iPadOS desktop-mode detection). */
    maxTouchPoints: number;
    /** matchMedia("(display-mode: standalone)").matches */
    isStandaloneDisplayMode: boolean;
    /** Legacy iOS Safari navigator.standalone flag. */
    isLegacyNavigatorStandalone: boolean;
}

/**
 * Returns true only for iOS devices running as an installed (standalone)
 * PWA — the exact platform where the bare element loses its background
 * audio session.
 */
export function shouldUseIosStandaloneAudioBridge(
    input: IosStandaloneBridgeEnvironmentInput,
): boolean {
    const isClassicIosDevice = /iphone|ipad|ipod/i.test(input.userAgent);
    const isIpadOsDesktopMode =
        /macintosh/i.test(input.userAgent) && input.maxTouchPoints > 1;
    const isIosDevice = isClassicIosDevice || isIpadOsDesktopMode;
    const isStandalone =
        input.isStandaloneDisplayMode || input.isLegacyNavigatorStandalone;
    return isIosDevice && isStandalone;
}

/**
 * Reads the bridge gate inputs from the live browser environment.
 * Returns false during SSR.
 */
export function detectIosStandaloneAudioBridgeEnvironment(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        return false;
    }
    const standaloneNavigator = navigator as Navigator & {
        standalone?: boolean;
    };
    return shouldUseIosStandaloneAudioBridge({
        userAgent: navigator.userAgent ?? "",
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        isStandaloneDisplayMode:
            typeof window.matchMedia === "function"
                ? window.matchMedia("(display-mode: standalone)").matches
                : false,
        isLegacyNavigatorStandalone: standaloneNavigator.standalone === true,
    });
}

/** Structural subset of MediaElementAudioSourceNode used by the bridge. */
export interface BridgeMediaElementSourceLike {
    connect(destination: AudioDestinationNode): void;
}

/** Structural subset of AudioContext used by the bridge (testable). */
export interface BridgeAudioContextLike {
    state: AudioContextState;
    destination: AudioDestinationNode;
    createMediaElementSource(
        element: HTMLAudioElement,
    ): BridgeMediaElementSourceLike;
    resume(): Promise<void>;
    close(): Promise<void>;
}

const createDefaultAudioContext = (): BridgeAudioContextLike | null => {
    if (typeof window === "undefined") {
        return null;
    }
    const AudioContextCtor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AudioContextCtor) {
        return null;
    }
    return new AudioContextCtor() as BridgeAudioContextLike;
};

/**
 * Lazily routes a single audio element through an AudioContext so iOS
 * holds the audio session in standalone PWAs. Set up on the first
 * user-gesture play; `createMediaElementSource` is called at most once
 * per element (calling it twice throws).
 */
export class IosStandaloneAudioContextBridge {
    private context: BridgeAudioContextLike | null = null;
    private bridgedElement: HTMLAudioElement | null = null;
    private readonly createContext: () => BridgeAudioContextLike | null;

    constructor(
        createContext: () => BridgeAudioContextLike | null = createDefaultAudioContext,
    ) {
        this.createContext = createContext;
    }

    /** Whether the bridge currently holds an open context. */
    isActive(): boolean {
        return this.context !== null;
    }

    /**
     * Creates the context and element source on first use; subsequent
     * calls for the same element are no-ops.
     */
    ensureForElement(element: HTMLAudioElement): void {
        if (this.context && this.bridgedElement === element) {
            return;
        }
        if (this.context && this.bridgedElement !== element) {
            sharedFrontendLogger.warn(
                "[NativeAudioEngine][iOSBridge] Bridge already bound to a different element; skipping rebind.",
            );
            return;
        }
        try {
            const context = this.createContext();
            if (!context) {
                return;
            }
            context.createMediaElementSource(element).connect(
                context.destination,
            );
            this.context = context;
            this.bridgedElement = element;
            sharedFrontendLogger.info(
                "[NativeAudioEngine][iOSBridge] AudioContext bridge established for standalone iOS PWA playback.",
            );
        } catch (err) {
            sharedFrontendLogger.error(
                "[NativeAudioEngine][iOSBridge] Failed to establish AudioContext bridge:",
                err,
            );
        }
    }

    /** Resumes a suspended context (call around user-gesture play). */
    resumeIfSuspended(): void {
        if (!this.context || this.context.state !== "suspended") {
            return;
        }
        void this.context.resume().catch((err) => {
            sharedFrontendLogger.warn(
                "[NativeAudioEngine][iOSBridge] Failed to resume AudioContext:",
                err,
            );
        });
    }

    /** Closes the context and releases the element binding. */
    close(): void {
        if (!this.context) {
            return;
        }
        void this.context.close().catch(() => undefined);
        this.context = null;
        this.bridgedElement = null;
    }
}
