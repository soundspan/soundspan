"use client";

/**
 * useJourneyMode — the journey planner's async data + derived view.
 *
 * Owns the mood-anchor list, the journey route fetch (generation-guarded
 * against stale responses), play/save actions, and the ready-to-render
 * `JourneyView`, plus the journey entry points (`canStartJourney` /
 * `startJourney` / `pickDestination`) the orchestrator wires into clicks.
 * Returns a null view outside journey mode. One of the three focused
 * per-mode hooks composed by `useVibeMode`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import type { MapTrack } from "./types";
import { annotateOnMap, journeyTracks, mapTrackToTrack } from "./journeyTracks";
import {
    describeSaveResult,
    formatPlaylistDate,
    saveTracksAsPlaylist,
} from "./savePlaylist";
import type { VibeListItem, VibeResultRow } from "./vibeListItem";
import { DRIFT_STEPS, type ModeAction, type ModeState } from "./vibeModeMachine";
import type { VibeControls } from "./useVibeMode";

export interface JourneyMoodOption {
    mood: string;
    trackCount: number;
}

export interface JourneyView {
    fromId: string;
    fromLabel: string;
    picking: boolean;
    destTrackId: string | null;
    destLabel: string | null;
    moodTarget: string | null;
    steps: number;
    moods: JourneyMoodOption[];
    targetLabel: string | null;
    waypoints: VibeListItem[];
    loading: boolean;
    error: string | null;
    canSubmit: boolean;
    /** Library-calibrated distance quantiles, or null (uncalibrated fallback). */
    quantiles: readonly number[] | null;
    togglePick: () => void;
    chooseMood: (mood: string) => void;
    setSteps: (n: number) => void;
    submit: () => void;
    drift: (mood: string) => void;
    play: () => void;
    /** Save the journey's queue (origin + waypoints, playJourney's own order) as a playlist. */
    save: () => Promise<void>;
    saving: boolean;
    close: () => void;
}

interface JourneyTargetResult {
    trackId?: string;
    mood?: string;
    title?: string;
    label?: string;
}

interface JourneyRoute {
    mode: "track" | "mood";
    target: JourneyTargetResult;
    waypoints: VibeResultRow[];
}

function journeyErrorMessage(e: unknown): string {
    const msg = e instanceof Error ? e.message : "";
    if (/no embedding/i.test(msg)) return "This track has no embedding yet";
    if (/enough embedded tracks/i.test(msg))
        return "Not enough analyzed tracks for this mood";
    return msg || "Couldn't build that journey";
}

export interface UseJourneyModeArgs {
    state: ModeState;
    dispatch: (action: ModeAction) => void;
    trackById: ReadonlyMap<string, MapTrack>;
    currentTrack: Track | null;
    controls: VibeControls;
    quantiles: readonly number[] | null;
    titleOf: (id: string | null) => string;
    exitToExplore: () => void;
}

export interface UseJourneyMode {
    journey: JourneyView | null;
    canStartJourney: boolean;
    startJourney: () => void;
    /**
     * Journey "pick on map": set `id` as the destination (no-op for the
     * journey's own origin — the backend rejects from === to; catching it
     * here means the map doesn't even round-trip).
     */
    pickDestination: (id: string) => void;
}

export function useJourneyMode({
    state,
    dispatch,
    trackById,
    currentTrack,
    controls,
    quantiles,
    titleOf,
    exitToExplore,
}: UseJourneyModeArgs): UseJourneyMode {
    const [route, setRoute] = useState<JourneyRoute | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [moods, setMoods] = useState<JourneyMoodOption[]>([]);

    const clearResults = useCallback(() => {
        setRoute(null);
        setError(null);
    }, []);

    // Generation counter for the route fetch: bumped on every new request AND
    // on mode teardown, so a stale response (e.g. Esc + re-enter before the
    // in-flight request lands) can't apply its result.
    const gen = useRef(0);

    // Mode exclusivity: leaving journey drops its overlay state.
    const inJourney = state.mode === "journey";
    useEffect(() => {
        if (!inJourney) {
            clearResults();
            gen.current++;
        }
    }, [inJourney, clearResults]);

    // Load mood anchors once on entry.
    useEffect(() => {
        if (!inJourney || moods.length > 0) return;
        let cancelled = false;
        api.getVibeMoods()
            .then((m) => {
                if (!cancelled) setMoods(m);
            })
            .catch(() => {
                /* moods list is best-effort; pick-on-map still works */
            });
        return () => {
            cancelled = true;
        };
    }, [inJourney, moods.length]);

    const waypointItems: VibeListItem[] = useMemo(
        () => annotateOnMap(route?.waypoints ?? [], trackById),
        [route, trackById]
    );

    // --- entry points -------------------------------------------------------
    const currentTrackId = currentTrack?.id ?? null;
    const travelCurrentForJourney =
        state.mode === "travel" ? state.currentId : null;
    // Disabled while alchemy is active (a half-built blend must not be
    // silently destroyed by starting a journey) — VibeMap surfaces this via
    // `vibe.mode === "alchemy"` for the "Close alchemy (Esc) first" hint.
    const inAlchemy = state.mode === "alchemy";
    const canStartJourney =
        !inAlchemy && !!(travelCurrentForJourney || currentTrackId);
    const startJourney = useCallback(() => {
        const fromId = travelCurrentForJourney ?? currentTrackId;
        if (!fromId) return;
        // Re-entering journey (already in journey mode, picking a new fromId)
        // does NOT change `state.mode`, so the mode-teardown effect above
        // never fires for it — clear the previous route/error and invalidate
        // the generation here too, or a stale route stays displayed for the
        // new origin.
        clearResults();
        gen.current++;
        dispatch({ type: "ENTER_JOURNEY", fromId });
    }, [travelCurrentForJourney, currentTrackId, clearResults, dispatch]);

    const pickDestination = useCallback(
        (id: string) => {
            if (state.mode !== "journey") return;
            if (id === state.fromId) return;
            dispatch({ type: "SET_DEST", id });
            clearResults();
        },
        [state, dispatch, clearResults]
    );

    // --- route fetch --------------------------------------------------------
    const runJourney = useCallback(
        async (
            fromId: string,
            toTrackId: string | undefined,
            mood: string | undefined,
            steps: number
        ) => {
            const g = ++gen.current;
            setLoading(true);
            setError(null);
            setRoute(null);
            try {
                const res = await api.getVibeJourney({
                    fromTrackId: fromId,
                    toTrackId,
                    mood,
                    steps,
                });
                if (g !== gen.current) return; // superseded — drop it
                setRoute(res as JourneyRoute);
            } catch (e) {
                if (g === gen.current) setError(journeyErrorMessage(e));
            } finally {
                if (g === gen.current) setLoading(false);
            }
        },
        []
    );

    const submit = useCallback(() => {
        if (state.mode !== "journey") return;
        const { fromId, destTrackId, moodTarget, steps } = state;
        if (!destTrackId && !moodTarget) return;
        void runJourney(
            fromId,
            destTrackId ?? undefined,
            moodTarget ?? undefined,
            steps
        );
    }, [state, runJourney]);

    const drift = useCallback(
        (mood: string) => {
            if (state.mode !== "journey") return;
            dispatch({ type: "SET_MOOD_TARGET", mood });
            dispatch({ type: "SET_STEPS", steps: DRIFT_STEPS });
            void runJourney(state.fromId, undefined, mood, DRIFT_STEPS);
        },
        [state, dispatch, runJourney]
    );

    // --- play / save --------------------------------------------------------
    const journeyFromTrack = useCallback(
        (fromId: string): Track | null => {
            const m = trackById.get(fromId);
            if (m) return mapTrackToTrack(m);
            if (currentTrack && currentTrack.id === fromId) return currentTrack;
            return null;
        },
        [trackById, currentTrack]
    );

    const play = useCallback(() => {
        if (state.mode !== "journey" || !route) return;
        const queue = journeyTracks(
            journeyFromTrack(state.fromId),
            route.waypoints
        );
        if (queue.length) controls.playTracks(queue, 0, true);
    }, [state, route, journeyFromTrack, controls]);

    /**
     * Save the journey's queue as a playlist — the exact same track list
     * `play` queues (origin prepended unless it's already the first
     * waypoint), reused via `journeyTracks` rather than re-derived. A
     * partial save surfaces as a warning toast (never unconditional
     * success) via `describeSaveResult`.
     */
    const save = useCallback(async () => {
        if (state.mode !== "journey" || !route) return;
        const queue = journeyTracks(
            journeyFromTrack(state.fromId),
            route.waypoints
        );
        if (queue.length === 0) return;
        const label = route.target?.label ?? route.target?.title ?? "Journey";
        const name = `Journey to ${label} — ${formatPlaylistDate()}`;
        setSaving(true);
        try {
            const result = await saveTracksAsPlaylist(
                name,
                queue.map((t) => t.id)
            );
            const outcome = describeSaveResult(name, result);
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setSaving(false);
        }
    }, [state, route, journeyFromTrack]);

    const journey: JourneyView | null =
        state.mode === "journey"
            ? {
                  fromId: state.fromId,
                  fromLabel: titleOf(state.fromId),
                  picking: state.picking,
                  destTrackId: state.destTrackId,
                  destLabel: state.destTrackId
                      ? titleOf(state.destTrackId)
                      : null,
                  moodTarget: state.moodTarget,
                  steps: state.steps,
                  moods,
                  targetLabel:
                      route?.target?.label ?? route?.target?.title ?? null,
                  waypoints: waypointItems,
                  loading,
                  error,
                  canSubmit: !!(state.destTrackId || state.moodTarget),
                  quantiles,
                  togglePick: () => dispatch({ type: "TOGGLE_PICK" }),
                  chooseMood: (mood) => {
                      dispatch({ type: "SET_MOOD_TARGET", mood });
                      // Pairs with every other destination-mutating dispatch
                      // (SET_DEST in pickDestination) — without this, picking
                      // a new mood leaves the previous target's route
                      // displayed.
                      clearResults();
                  },
                  setSteps: (n) => dispatch({ type: "SET_STEPS", steps: n }),
                  submit,
                  drift,
                  play,
                  save,
                  saving,
                  close: exitToExplore,
              }
            : null;

    return { journey, canStartJourney, startJourney, pickDestination };
}
