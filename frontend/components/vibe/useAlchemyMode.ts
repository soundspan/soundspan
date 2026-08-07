"use client";

/**
 * useAlchemyMode — the alchemy tray's async blend + derived view.
 *
 * Owns the blend fetch (generation-guarded), the result highlight set, the
 * ingredient add entry point, and the ready-to-render `AlchemyView`. Returns
 * a null view outside alchemy mode. One of the three focused per-mode hooks
 * composed by `useVibeMode`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { MapTrack } from "./types";
import { annotateOnMap, waypointToTrack } from "./journeyTracks";
import type { VibeListItem, VibeResultRow } from "./vibeListItem";
import type { ModeAction, ModeState } from "./vibeModeMachine";
import type { VibeControls } from "./useVibeMode";

const BLEND_LIMIT = 20;

export interface AlchemyIngredientView {
    id: string;
    title: string;
    artist: string;
    weight: number;
    onMap: boolean;
}

export interface AlchemyView {
    ingredients: AlchemyIngredientView[];
    results: VibeListItem[];
    loading: boolean;
    error: string | null;
    canBlend: boolean;
    /** Library-calibrated distance quantiles, or null (uncalibrated fallback). */
    quantiles: readonly number[] | null;
    remove: (id: string) => void;
    setWeight: (id: string, w: number) => void;
    blend: () => void;
    play: () => void;
    clear: () => void;
}

export interface UseAlchemyModeArgs {
    state: ModeState;
    dispatch: (action: ModeAction) => void;
    trackById: ReadonlyMap<string, MapTrack>;
    controls: VibeControls;
    quantiles: readonly number[] | null;
    exitToExplore: () => void;
}

export interface UseAlchemyMode {
    alchemy: AlchemyView | null;
    /** Add a track to the alchemy tray (ctrl/⌘-click anywhere, incl. halos). */
    addIngredient: (id: string) => void;
    /** Alchemy result ids to glow on the canvas (else null → spotlight owns it). */
    highlightIds: ReadonlySet<string> | null;
}

export function useAlchemyMode({
    state,
    dispatch,
    trackById,
    controls,
    quantiles,
    exitToExplore,
}: UseAlchemyModeArgs): UseAlchemyMode {
    const [blendRows, setBlendRows] = useState<VibeResultRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const clearResults = useCallback(() => {
        setBlendRows(null);
        setError(null);
    }, []);

    // Generation counter for the blend fetch: bumped on every new request AND
    // on mode teardown, so a stale response can't apply its result.
    const gen = useRef(0);

    // Mode exclusivity: leaving alchemy drops its overlay state.
    const inAlchemy = state.mode === "alchemy";
    useEffect(() => {
        if (!inAlchemy) {
            clearResults();
            gen.current++;
        }
    }, [inAlchemy, clearResults]);

    const addIngredient = useCallback(
        (id: string) => {
            dispatch({ type: "ADD_ALCHEMY", id });
            clearResults();
        },
        [dispatch, clearResults]
    );

    const runBlend = useCallback(() => {
        if (state.mode !== "alchemy" || state.ingredients.length < 2) return;
        const ings = state.ingredients;
        const g = ++gen.current;
        setLoading(true);
        setError(null);
        setBlendRows(null);
        api.vibeAlchemy(
            ings.map((i) => i.id),
            ings.map((i) => i.weight),
            BLEND_LIMIT
        )
            .then((res) => {
                if (g === gen.current) setBlendRows(res.tracks);
            })
            .catch(() => {
                if (g === gen.current)
                    setError("Couldn't blend those tracks");
            })
            .finally(() => {
                if (g === gen.current) setLoading(false);
            });
    }, [state]);

    const play = useCallback(() => {
        if (!blendRows || blendRows.length === 0) return;
        controls.playTracks(blendRows.map(waypointToTrack), 0, true);
    }, [blendRows, controls]);

    const resultItems: VibeListItem[] = useMemo(
        () => annotateOnMap(blendRows ?? [], trackById),
        [blendRows, trackById]
    );

    const resultIds = useMemo(
        () => new Set((blendRows ?? []).map((t) => t.id)),
        [blendRows]
    );

    const alchemy: AlchemyView | null =
        state.mode === "alchemy"
            ? {
                  ingredients: state.ingredients.map((i) => {
                      const t = trackById.get(i.id);
                      return {
                          id: i.id,
                          title: t?.title ?? i.id,
                          artist: t?.artist ?? "",
                          weight: i.weight,
                          onMap: !!t,
                      };
                  }),
                  results: resultItems,
                  loading,
                  error,
                  canBlend: state.ingredients.length >= 2,
                  quantiles,
                  remove: (id) => {
                      dispatch({ type: "REMOVE_ALCHEMY", id });
                      clearResults();
                  },
                  setWeight: (id, w) => {
                      dispatch({ type: "SET_WEIGHT", id, weight: w });
                      clearResults();
                  },
                  blend: runBlend,
                  play,
                  clear: exitToExplore,
              }
            : null;

    return {
        alchemy,
        addIngredient,
        highlightIds:
            state.mode === "alchemy" && resultIds.size > 0 ? resultIds : null,
    };
}
