"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import {
    DEFAULT_LOUDNESS_TARGET_LUFS,
    isAlbumOrderedQueue,
    LOUDNESS_MODES,
    resolveLoudnessGain,
    type LoudnessMode,
} from "@/lib/audio-engine/loudnessGainPolicy";
import { useAudioState } from "@/lib/audio-state-context";
import { isEpisodeQueueItem } from "@/lib/queue-item";
import { USER_SETTINGS_UPDATED_EVENT } from "@/lib/userSettingsEvents";
import {
    startGainTransition,
    type GainTransitionHandle,
} from "./gainTransition";
import { createLoudnessPrefsLoader } from "./loudnessPrefsLoader";

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

/** Bounded retry backoff for the preference snapshot. */
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
 * provides neither). The snapshot loads through a serialized,
 * generation-fenced loader with bounded retries, and refreshes when the
 * settings page announces a save.
 */
function useLoudnessPrefs(): LoudnessPrefs {
    // Mode stays "off" until the stored preference loads, so gain is never
    // applied speculatively.
    const [prefs, setPrefs] = useState<LoudnessPrefs>({
        mode: "off",
        targetLufs: DEFAULT_LOUDNESS_TARGET_LUFS,
    });

    useEffect(() => {
        const loader = createLoudnessPrefsLoader({
            fetchSettings: () =>
                Promise.resolve().then(() => api.getSettings?.()),
            fetchFeatures: () =>
                Promise.resolve().then(() => api.getFeatures?.()),
            extractMode: extractLoudnessMode,
            extractTarget: extractTargetLufs,
            retryDelaysMs: PREFS_RETRY_DELAYS_MS,
            onSnapshot: ({ mode, targetLufs }) => {
                setPrefs((prev) => {
                    const next = {
                        mode: (mode as LoudnessMode | null) ?? prev.mode,
                        targetLufs: targetLufs ?? prev.targetLufs,
                    };
                    return next.mode === prev.mode &&
                        next.targetLufs === prev.targetLufs
                        ? prev
                        : next;
                });
            },
        });
        loader.start();
        if (typeof window === "undefined") {
            return loader.dispose;
        }
        window.addEventListener(USER_SETTINGS_UPDATED_EVENT, loader.reload);
        return () => {
            loader.dispose();
            window.removeEventListener(
                USER_SETTINGS_UPDATED_EVENT,
                loader.reload,
            );
        };
    }, []);

    return prefs;
}

type AudioStateSlice = Pick<
    ReturnType<typeof useAudioState>,
    "currentTrack" | "playbackType" | "queue" | "isShuffle"
>;

interface GainSyncInput extends AudioStateSlice {
    prefs: LoudnessPrefs;
    loudnessGainFactorRef: MutableRefObject<number>;
    applyCurrentOutputState: () => void;
    transitionRef: MutableRefObject<GainTransitionHandle | null>;
    lastTrackIdRef: MutableRefObject<string | null>;
}

/**
 * Recomputes the gain decision and applies it: immediately when the track
 * changed (the content changes anyway), through a short ramp for a
 * mid-track mode/target/queue-context change so the volume never jumps.
 */
function syncLoudnessGain(input: GainSyncInput): void {
    // A queue containing podcast episodes is never an album context.
    const trackItems = input.queue.filter((item) => !isEpisodeQueueItem(item));
    const isTrack = input.playbackType === "track";
    const decision = resolveLoudnessGain({
        mode: input.prefs.mode,
        targetLufs: input.prefs.targetLufs,
        isAlbumContext:
            trackItems.length === input.queue.length &&
            isAlbumOrderedQueue(trackItems, input.isShuffle),
        track: isTrack ? input.currentTrack : null,
    });
    const trackId = isTrack ? (input.currentTrack?.id ?? null) : null;
    const trackChanged = trackId !== input.lastTrackIdRef.current;
    input.lastTrackIdRef.current = trackId;

    input.transitionRef.current?.cancel();
    input.transitionRef.current = null;
    const previous = input.loudnessGainFactorRef.current;
    if (previous === decision.gainFactor) return;

    if (trackChanged || typeof window === "undefined") {
        input.loudnessGainFactorRef.current = decision.gainFactor;
        input.applyCurrentOutputState();
        return;
    }
    input.transitionRef.current = startGainTransition({
        from: previous,
        to: decision.gainFactor,
        setGain: (value) => {
            input.loudnessGainFactorRef.current = value;
        },
        applyOutputState: input.applyCurrentOutputState,
    });
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
    const prefs = useLoudnessPrefs();
    const transitionRef = useRef<GainTransitionHandle | null>(null);
    const lastTrackIdRef = useRef<string | null>(null);

    useEffect(() => {
        syncLoudnessGain({
            prefs,
            currentTrack,
            playbackType,
            queue,
            isShuffle,
            loudnessGainFactorRef,
            applyCurrentOutputState,
            transitionRef,
            lastTrackIdRef,
        });
    }, [
        prefs,
        currentTrack,
        playbackType,
        queue,
        isShuffle,
        loudnessGainFactorRef,
        applyCurrentOutputState,
    ]);

    useEffect(
        () => () => {
            transitionRef.current?.cancel();
        },
        [],
    );
}
