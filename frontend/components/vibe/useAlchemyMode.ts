"use client";

/** Async blend data and derived view for alchemy mode. */

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
    quantiles: readonly number[] | null;
    remove: (id: string) => void;
    setWeight: (id: string, weight: number) => void;
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
    addIngredient: (id: string) => void;
    highlightIds: ReadonlySet<string> | null;
}

function useBlendRequest(state: ModeState) {
    const [rows, setRows] = useState<VibeResultRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);
    const clear = useCallback(() => {
        setRows(null);
        setError(null);
    }, []);
    const inAlchemy = state.mode === "alchemy";
    useEffect(() => {
        if (!inAlchemy) {
            clear();
            generation.current++;
            setLoading(false);
        }
    }, [inAlchemy, clear]);
    const run = useCallback(() => {
        if (state.mode !== "alchemy" || state.ingredients.length < 2) return;
        const request = ++generation.current;
        setLoading(true);
        setError(null);
        setRows(null);
        api.vibeAlchemy(state.ingredients.map((item) => item.id),
            state.ingredients.map((item) => item.weight), BLEND_LIMIT)
            .then((response) => {
                if (request === generation.current) setRows(response.tracks);
            })
            .catch(() => {
                if (request === generation.current) setError("Couldn't blend those tracks");
            })
            .finally(() => {
                if (request === generation.current) setLoading(false);
            });
    }, [state]);
    return { rows, loading, error, clear, run };
}

function ingredientViews(state: ModeState,
    trackById: ReadonlyMap<string, MapTrack>): AlchemyIngredientView[] {
    if (state.mode !== "alchemy") return [];
    return state.ingredients.map((ingredient) => {
        const track = trackById.get(ingredient.id);
        return { id: ingredient.id, title: track?.title ?? ingredient.id,
            artist: track?.artist ?? "", weight: ingredient.weight, onMap: !!track };
    });
}

/** Derive the alchemy tray and its result highlight set. */
export function useAlchemyMode(args: UseAlchemyModeArgs): UseAlchemyMode {
    const blend = useBlendRequest(args.state);
    const addIngredient = useCallback((id: string) => {
        args.dispatch({ type: "ADD_ALCHEMY", id });
        blend.clear();
    }, [args.dispatch, blend.clear]);
    const play = useCallback(() => {
        if (blend.rows?.length) {
            args.controls.playTracks(blend.rows.map(waypointToTrack), 0, true);
        }
    }, [blend.rows, args.controls]);
    const results = useMemo(() => annotateOnMap(blend.rows ?? [], args.trackById),
        [blend.rows, args.trackById]);
    const resultIds = useMemo(() => new Set((blend.rows ?? []).map((track) => track.id)),
        [blend.rows]);
    const alchemy = args.state.mode === "alchemy" ? {
        ingredients: ingredientViews(args.state, args.trackById), results,
        loading: blend.loading, error: blend.error,
        canBlend: args.state.ingredients.length >= 2, quantiles: args.quantiles,
        remove: (id: string) => { args.dispatch({ type: "REMOVE_ALCHEMY", id }); blend.clear(); },
        setWeight: (id: string, weight: number) => {
            args.dispatch({ type: "SET_WEIGHT", id, weight }); blend.clear();
        },
        blend: blend.run, play, clear: args.exitToExplore,
    } : null;
    return { alchemy, addIngredient,
        highlightIds: args.state.mode === "alchemy" && resultIds.size ? resultIds : null };
}
