import type { AudioEngine } from "./types";
import { isTauriEnvironment, needsNativeAudio } from "./tauriDetection";
import { HowlerEngineAdapter } from "./howlerEngineAdapter";
import { warnTauriDeprecationOnce } from "./tauriDeprecation";

/**
 * Create the appropriate audio engine for the current platform.
 *
 * - Tauri + Windows/Android -> TauriNativeEngineAdapter (bypasses Chromium 48kHz cap)
 * - Everything else -> HowlerEngineAdapter (standard web audio)
 *
 * @deprecated The Tauri desktop integration is deprecated and slated for
 * removal (issue #607); this factory goes with it.
 */
export async function createAudioEngine(): Promise<AudioEngine> {
    if (isTauriEnvironment()) {
        const native = await needsNativeAudio();
        if (native) {
            warnTauriDeprecationOnce("native engine upgrade");
            const { TauriNativeEngineAdapter } =
                await import("./tauriNativeEngineAdapter");
            return new TauriNativeEngineAdapter();
        }
    }

    return new HowlerEngineAdapter();
}

/**
 * Synchronous version that returns Howler adapter immediately.
 * Use createAudioEngine() for proper platform detection.
 */
export function createDefaultAudioEngine(): AudioEngine {
    return new HowlerEngineAdapter();
}
