"use client";

/**
 * useVibeMode — the F2 interaction orchestrator for the vibe map.
 *
 * A thin composition layer: the mode transitions live in the pure
 * `vibeModeMachine` reducer, and each mode's async data + view derivation
 * lives in its own focused hook (`useTravelMode` / `useJourneyMode` /
 * `useAlchemyMode`). This hook owns only what genuinely spans modes: the
 * shared reducer instance, the dot-click verb routing (with its two ordering
 * constraints — journey-picking intercepts first, ctrl beats shift), the
 * empty-click rule, and the composed public surface VibeMap renders from.
 *
 * Mode exclusivity is enforced by each per-mode hook tearing down its own
 * async state when `state.mode` moves elsewhere. Esc / close always returns
 * to explore.
 */

import { useCallback, useReducer } from "react";
import { toast } from "sonner";
import type { Track } from "@/lib/audio-state-context";
import type { MapTrack } from "./types";
import { mapTrackToTrack } from "./journeyTracks";
import { vibeModeReducer, type ModeState, type VibeMode } from "./vibeModeMachine";
import { useTravelMode, type TravelView } from "./useTravelMode";
import { useJourneyMode, type JourneyView } from "./useJourneyMode";
import { useAlchemyMode, type AlchemyView } from "./useAlchemyMode";

// Stable public surface: panels and tests import these from "./useVibeMode",
// regardless of which focused module now defines them.
export {
    MAX_ALCHEMY_INGREDIENTS,
    MIN_JOURNEY_STEPS,
    MAX_JOURNEY_STEPS,
    MIN_WEIGHT,
    MAX_WEIGHT,
    type VibeMode,
} from "./vibeModeMachine";
export type { TravelView, VibeFeatures } from "./useTravelMode";
export type { JourneyView, JourneyMoodOption } from "./useJourneyMode";
export type { AlchemyView, AlchemyIngredientView } from "./useAlchemyMode";
export type { VibeListItem } from "./vibeListItem";

/** The playback controls the vibe modes drive (a subset of audio-controls). */
export interface VibeControls {
    playTrack: (track: Track) => void;
    playTracks: (
        tracks: Track[],
        startIndex?: number,
        isVibeQueue?: boolean
    ) => void;
    addToQueue: (track: Track, options?: { silent?: boolean }) => void;
}

export interface UseVibeModeArgs {
    trackById: ReadonlyMap<string, MapTrack>;
    currentTrack: Track | null;
    controls: VibeControls;
    /**
     * Library-calibrated distance quantiles (`api.getVibeCalibration`, fetched
     * once by VibeMap), or null before it loads / on a too-small library —
     * threaded into every view so the panels' match percentages can be
     * calibrated without each doing its own fetch.
     */
    quantiles?: readonly number[] | null;
}

export interface UseVibeMode {
    mode: VibeMode;
    onDotClick: (
        id: string,
        mods: { ctrlOrMeta: boolean; shift: boolean }
    ) => void;
    /** A click on clearly-empty canvas: dissolves travel; other modes ignore it. */
    onEmptyClick: () => void;
    exitToExplore: () => void;
    canStartJourney: boolean;
    startJourney: () => void;
    /** Alchemy result ids to glow on the canvas (else null → spotlight owns it). */
    highlightIds: ReadonlySet<string> | null;
    /** Add a track to the alchemy tray (ctrl/⌘-click anywhere, incl. halos). */
    addIngredient: (id: string) => void;
    travel: TravelView | null;
    journey: JourneyView | null;
    alchemy: AlchemyView | null;
}

const INITIAL_STATE: ModeState = { mode: "explore" };

export function useVibeMode({
    trackById,
    currentTrack,
    controls,
    quantiles = null,
}: UseVibeModeArgs): UseVibeMode {
    const [state, dispatch] = useReducer(vibeModeReducer, INITIAL_STATE);

    const exitToExplore = useCallback(() => dispatch({ type: "RESET" }), []);

    const titleOf = useCallback(
        (id: string | null): string => {
            if (!id) return "";
            return (
                trackById.get(id)?.title ??
                (currentTrack?.id === id ? currentTrack.title : id)
            );
        },
        [trackById, currentTrack]
    );

    const travel = useTravelMode({
        state,
        dispatch,
        trackById,
        controls,
        quantiles,
        titleOf,
        exitToExplore,
    });
    const { journey, canStartJourney, startJourney, pickDestination } =
        useJourneyMode({
            state,
            dispatch,
            trackById,
            currentTrack,
            controls,
            quantiles,
            titleOf,
            exitToExplore,
        });
    const { alchemy, addIngredient, highlightIds } = useAlchemyMode({
        state,
        dispatch,
        trackById,
        controls,
        quantiles,
        exitToExplore,
    });

    // Click-away: clicking clearly-empty canvas dissolves a travel
    // constellation (the map idiom for "deselect"). Journey and alchemy keep
    // their form state — an accidental empty click must never clear a
    // half-built route or ingredient tray; those exit via Esc / ✕ only.
    const inTravel = state.mode === "travel";
    const onEmptyClick = useCallback(() => {
        if (inTravel) dispatch({ type: "RESET" });
    }, [inTravel]);

    const onDotClick = useCallback(
        (id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => {
            const t = trackById.get(id);
            if (!t) return;
            // Ordering constraint #1: journey "pick on map" intercepts the
            // next dot for the destination, shift or not. (Picking the
            // journey's own origin is a no-op inside pickDestination.)
            if (state.mode === "journey" && state.picking) {
                pickDestination(id);
                return;
            }
            // Ordering constraint #2: ctrl/alchemy-add beats shift.
            if (mods.ctrlOrMeta) {
                // Journey is a half-built route the user is actively
                // constructing — silently switching it into alchemy would
                // destroy it. Explore/travel ctrl-click still enters alchemy
                // unchanged (a travel constellation is cheap to rebuild).
                if (state.mode === "journey") {
                    toast("Close the journey (Esc) to start blending");
                    return;
                }
                addIngredient(id);
                return;
            }
            // Plain shift-click on a dot always queues the track — never
            // changes playback, never changes mode — in EVERY mode.
            if (mods.shift) {
                controls.addToQueue(mapTrackToTrack(t));
                return;
            }
            switch (state.mode) {
                case "explore":
                    dispatch({ type: "ENTER_TRAVEL", id });
                    controls.playTrack(mapTrackToTrack(t));
                    break;
                case "travel":
                    dispatch({ type: "TRAVEL_TO", id });
                    controls.playTrack(mapTrackToTrack(t));
                    break;
                case "alchemy":
                    addIngredient(id);
                    break;
                case "journey":
                    // plain click while not picking: no-op
                    break;
            }
        },
        [state, trackById, controls, addIngredient, pickDestination]
    );

    return {
        mode: state.mode,
        onDotClick,
        onEmptyClick,
        exitToExplore,
        canStartJourney,
        startJourney,
        highlightIds,
        addIngredient,
        travel,
        journey,
        alchemy,
    };
}
