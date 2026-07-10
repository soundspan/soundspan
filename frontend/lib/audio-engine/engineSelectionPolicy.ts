/**
 * Direct-Engine Selection Policy
 *
 * Pure decision module for which engine occupies the hybrid router's
 * direct-playback ("howler") slot, and whether the async Tauri platform
 * upgrade is allowed to replace it later.
 *
 * Selection precedence (GH #42 §10), highest first:
 * 1. Platform pins — Android WebView is pinned to Howler because its
 *    Web Audio mode is the established fix for crackling/popping on
 *    track changes there (see howler-engine.ts).
 * 2. The deployment engine-mode flag (STREAMING_ENGINE_MODE=native).
 *    Native mode also suppresses the Tauri auto-upgrade path entirely.
 * 3. Default — Howler, with the existing Tauri upgrade allowed.
 */

import type { StreamingEngineMode } from "@/lib/audio-engine/types";

/** Engine that should occupy the hybrid router's direct-playback slot. */
export type DirectEngineSlot = "howler" | "native";

/** Why a given direct engine was selected, for logs and tests. */
export type DirectEngineSelectionReason =
    | "android_webview_pin"
    | "native_mode_flag"
    | "default_direct_engine";

export interface DirectEngineSelectionInput {
    /** Resolved STREAMING_ENGINE_MODE flag value. */
    mode: StreamingEngineMode;
    /** Whether the runtime is an Android WebView (crackling-fix pin). */
    isAndroidWebView: boolean;
}

export interface DirectEngineSelectionDecision {
    engine: DirectEngineSlot;
    reason: DirectEngineSelectionReason;
    /**
     * Whether the async Tauri platform detection may hot-swap the direct
     * slot. Must be false whenever native mode is active (GH #42 §10).
     */
    allowTauriUpgrade: boolean;
}

/**
 * Detects an Android WebView user agent (the `wv` token plus `android`).
 * Mirrors the runtime detection used by the Howler engine's crackling fix.
 */
export function detectAndroidWebView(userAgent: string): boolean {
    const normalized = userAgent.toLowerCase();
    return /\bwv\b/.test(normalized) && normalized.includes("android");
}

/**
 * Resolves which engine occupies the direct-playback slot for the
 * current mode and platform. Pure; callers supply platform booleans.
 */
export function resolveDirectEngineSelection(
    input: DirectEngineSelectionInput,
): DirectEngineSelectionDecision {
    if (input.mode === "native") {
        if (input.isAndroidWebView) {
            return {
                engine: "howler",
                reason: "android_webview_pin",
                allowTauriUpgrade: false,
            };
        }
        return {
            engine: "native",
            reason: "native_mode_flag",
            allowTauriUpgrade: false,
        };
    }

    return {
        engine: "howler",
        reason: "default_direct_engine",
        allowTauriUpgrade: true,
    };
}
