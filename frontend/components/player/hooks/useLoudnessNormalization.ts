"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import {
    DEFAULT_LOUDNESS_TARGET_LUFS,
    LOUDNESS_MODES,
    isAlbumOrderedQueue,
    resolveLoudnessGain,
    type LoudnessMode,
} from "@/lib/audio-engine/loudnessGainPolicy";
import { useAudioState } from "@/lib/audio-state-context";
import { isEpisodeQueueItem } from "@/lib/queue-item";
import { USER_SETTINGS_UPDATED_EVENT } from "@/lib/userSettingsEvents";

function parseLoudnessMode(value: unknown): LoudnessMode | null {
    return LOUDNESS_MODES.includes(value as LoudnessMode)
        ? (value as LoudnessMode)
        : null;
}

interface UseLoudnessNormalizationOptions {
    loudnessGainFactorRef: MutableRefObject<number>;
    applyCurrentOutputState: () => void;
}

interface LoudnessPrefs {
    mode: LoudnessMode;
    targetLufs: number;
}

/**
 * Reads the user's loudness mode and the server target directly from the
 * API (deliberately not through react-query or the features context: this
 * hook mounts inside the playback orchestrator, whose component harness
 * provides neither). Refreshes when the settings page announces a save.
 */
function useLoudnessPrefs(): LoudnessPrefs {
    // Mode stays "off" until the stored preference loads, so gain is never
    // applied speculatively.
    const [prefs, setPrefs] = useState<LoudnessPrefs>({
        mode: "off",
        targetLufs: DEFAULT_LOUDNESS_TARGET_LUFS,
    });

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            Promise.resolve()
                .then(() => api.getSettings?.())
                .then((settings) => {
                    if (cancelled || !settings) return;
                    const stored = (settings as { loudnessMode?: unknown })
                        .loudnessMode;
                    const mode = parseLoudnessMode(stored) ?? "auto";
                    setPrefs((prev) =>
                        prev.mode === mode ? prev : { ...prev, mode },
                    );
                })
                .catch(() => undefined);
            Promise.resolve()
                .then(() => api.getFeatures?.())
                .then((features) => {
                    if (cancelled || !features) return;
                    const target = (
                        features as { loudnessTargetLufs?: unknown }
                    ).loudnessTargetLufs;
                    if (typeof target !== "number" || !Number.isFinite(target))
                        return;
                    setPrefs((prev) =>
                        prev.targetLufs === target
                            ? prev
                            : { ...prev, targetLufs: target },
                    );
                })
                .catch(() => undefined);
        };
        load();
        if (typeof window === "undefined") {
            return () => {
                cancelled = true;
            };
        }
        window.addEventListener(USER_SETTINGS_UPDATED_EVENT, load);
        return () => {
            cancelled = true;
            window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, load);
        };
    }, []);

    return prefs;
}

/**
 * Keeps the loudness-normalization gain factor in sync with the current
 * track, the user's mode (Settings → Playback), and the server target
 * (issue #526). The factor is composited with user volume inside
 * applyCurrentOutputState; this hook only recomputes it and re-applies the
 * output state when the applied gain actually changes.
 *
 * Audiobooks and podcasts are never normalized.
 */
export function useLoudnessNormalization({
    loudnessGainFactorRef,
    applyCurrentOutputState,
}: UseLoudnessNormalizationOptions): void {
    const { currentTrack, playbackType, queue, isShuffle } = useAudioState();
    const { mode, targetLufs } = useLoudnessPrefs();

    useEffect(() => {
        // A queue containing podcast episodes is never an album context.
        const trackItems = queue.filter((item) => !isEpisodeQueueItem(item));
        const isAlbumContext =
            trackItems.length === queue.length &&
            isAlbumOrderedQueue(trackItems, isShuffle);
        const decision = resolveLoudnessGain({
            mode,
            targetLufs,
            isAlbumContext,
            track: playbackType === "track" ? currentTrack : null,
        });
        if (loudnessGainFactorRef.current === decision.gainFactor) return;
        loudnessGainFactorRef.current = decision.gainFactor;
        applyCurrentOutputState();
    }, [
        mode,
        targetLufs,
        currentTrack,
        playbackType,
        queue,
        isShuffle,
        loudnessGainFactorRef,
        applyCurrentOutputState,
    ]);
}
