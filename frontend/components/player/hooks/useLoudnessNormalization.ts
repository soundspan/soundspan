"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import {
    computeGainRampSteps,
    DEFAULT_LOUDNESS_TARGET_LUFS,
    GAIN_RAMP_STEP_MS,
    isAlbumOrderedQueue,
    LOUDNESS_MODES,
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

/** Bounded retry backoff for the initial preference snapshot. */
const PREFS_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

function extractLoudnessMode(settings: unknown): LoudnessMode {
    const stored = (settings as { loudnessMode?: unknown }).loudnessMode;
    return parseLoudnessMode(stored) ?? "auto";
}

function extractTargetLufs(features: unknown): number | null {
    const target = (features as { loudnessTargetLufs?: unknown })
        .loudnessTargetLufs;
    return typeof target === "number" && Number.isFinite(target)
        ? target
        : null;
}

/**
 * Reads the user's loudness mode and the server target directly from the
 * API (deliberately not through react-query or the features context: this
 * hook mounts inside the playback orchestrator, whose component harness
 * provides neither). The two values load as one snapshot, retry with
 * bounded backoff when either request fails, and refresh when the settings
 * page announces a save.
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
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let retriesUsed = 0;

        const load = () => {
            void Promise.allSettled([
                Promise.resolve().then(() => api.getSettings?.()),
                Promise.resolve().then(() => api.getFeatures?.()),
            ]).then(([settingsResult, featuresResult]) => {
                if (cancelled) return;
                const settingsOk =
                    settingsResult.status === "fulfilled" &&
                    Boolean(settingsResult.value);
                const featuresOk =
                    featuresResult.status === "fulfilled" &&
                    Boolean(featuresResult.value);
                const mode = settingsOk
                    ? extractLoudnessMode(settingsResult.value)
                    : null;
                const target = featuresOk
                    ? extractTargetLufs(featuresResult.value)
                    : null;
                setPrefs((prev) => {
                    const next = {
                        mode: mode ?? prev.mode,
                        targetLufs: target ?? prev.targetLufs,
                    };
                    return next.mode === prev.mode &&
                        next.targetLufs === prev.targetLufs
                        ? prev
                        : next;
                });
                const shouldRetry =
                    (!settingsOk || !featuresOk) &&
                    retriesUsed < PREFS_RETRY_DELAYS_MS.length &&
                    typeof window !== "undefined";
                if (shouldRetry) {
                    retryTimer = setTimeout(
                        load,
                        PREFS_RETRY_DELAYS_MS[retriesUsed],
                    );
                    retriesUsed += 1;
                }
            });
        };

        const reload = () => {
            retriesUsed = 0;
            if (retryTimer !== null) clearTimeout(retryTimer);
            load();
        };

        load();
        if (typeof window === "undefined") {
            return () => {
                cancelled = true;
            };
        }
        window.addEventListener(USER_SETTINGS_UPDATED_EVENT, reload);
        return () => {
            cancelled = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, reload);
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
 * A gain change caused by a track change applies immediately (the content
 * changes anyway); a mid-track change (mode, target, or queue context)
 * ramps over a short interval so the volume never jumps audibly.
 *
 * Audiobooks and podcasts are never normalized.
 */
export function useLoudnessNormalization({
    loudnessGainFactorRef,
    applyCurrentOutputState,
}: UseLoudnessNormalizationOptions): void {
    const { currentTrack, playbackType, queue, isShuffle } = useAudioState();
    const { mode, targetLufs } = useLoudnessPrefs();
    const rampTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lastTrackIdRef = useRef<string | null>(null);

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

        const trackId =
            playbackType === "track" ? (currentTrack?.id ?? null) : null;
        const trackChanged = trackId !== lastTrackIdRef.current;
        lastTrackIdRef.current = trackId;

        if (rampTimerRef.current !== null) {
            clearInterval(rampTimerRef.current);
            rampTimerRef.current = null;
        }
        const previous = loudnessGainFactorRef.current;
        if (previous === decision.gainFactor) return;

        if (trackChanged || typeof window === "undefined") {
            loudnessGainFactorRef.current = decision.gainFactor;
            applyCurrentOutputState();
            return;
        }

        const steps = computeGainRampSteps(previous, decision.gainFactor);
        let stepIndex = 0;
        rampTimerRef.current = setInterval(() => {
            loudnessGainFactorRef.current =
                steps[stepIndex] ?? decision.gainFactor;
            applyCurrentOutputState();
            stepIndex += 1;
            if (stepIndex >= steps.length && rampTimerRef.current !== null) {
                clearInterval(rampTimerRef.current);
                rampTimerRef.current = null;
            }
        }, GAIN_RAMP_STEP_MS);
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

    useEffect(
        () => () => {
            if (rampTimerRef.current !== null) {
                clearInterval(rampTimerRef.current);
            }
        },
        [],
    );
}
