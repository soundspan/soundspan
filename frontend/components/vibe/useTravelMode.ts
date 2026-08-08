"use client";

/** Async neighbor data and derived compass view for travel mode. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { MapTrack } from "./types";
import {
    compassNeighbors, enrichFromMap, DEFAULT_COMPASS_COUNT,
    type CompassCandidate, type CompassDirection,
} from "./travelCompass";
import { waypointToTrack } from "./journeyTracks";
import type { ModeAction, ModeState } from "./vibeModeMachine";
import type { VibeControls } from "./useVibeMode";

const SIMILAR_LIMIT = 24;

export interface VibeFeatures {
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    arousal: number | null;
}

export interface TravelView {
    currentId: string;
    currentTitle: string;
    breadcrumbTitles: Array<{ id: string; title: string }>;
    direction: CompassDirection;
    onMapNeighbors: CompassCandidate[];
    offMapNeighbors: CompassCandidate[];
    loading: boolean;
    error: string | null;
    quantiles: readonly number[] | null;
    originFeatures: VibeFeatures | null;
    setDirection: (direction: CompassDirection) => void;
    navigate: (id: string) => void;
    queue: (id: string) => void;
    close: () => void;
}

export interface UseTravelModeArgs {
    state: ModeState;
    dispatch: (action: ModeAction) => void;
    trackById: ReadonlyMap<string, MapTrack>;
    controls: VibeControls;
    quantiles: readonly number[] | null;
    titleOf: (id: string | null) => string;
    exitToExplore: () => void;
}

interface NeighborState {
    originId: string;
    list: CompassCandidate[];
    sourceFeatures: VibeFeatures | null;
}

type SimilarTrack = Awaited<ReturnType<typeof api.getVibeSimilarTracks>>["tracks"][number];

function toCompassCandidate(track: SimilarTrack): CompassCandidate {
    return {
        id: track.id, title: track.title, album: track.album, artist: track.artist,
        similarity: Math.max(0, 1 - track.distance / 2), distance: track.distance,
        energy: track.audioFeatures?.energy ?? null,
        valence: track.audioFeatures?.valence ?? null,
        danceability: track.audioFeatures?.danceability ?? null,
        arousal: track.audioFeatures?.arousal ?? null, moods: null,
    };
}

function useNeighborRequest(currentId: string | null, inTravel: boolean) {
    const [neighbors, setNeighbors] = useState<NeighborState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!inTravel) {
            setNeighbors(null);
            setError(null);
            setLoading(false);
        }
    }, [inTravel]);
    useEffect(() => {
        if (!currentId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.getVibeSimilarTracks(currentId, SIMILAR_LIMIT)
            .then((response) => {
                if (!cancelled) setNeighbors({
                    originId: currentId,
                    sourceFeatures: response.sourceFeatures ?? null,
                    list: response.tracks.map(toCompassCandidate),
                });
            })
            .catch(() => {
                if (!cancelled) setError("Couldn't load nearby vibes");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [currentId]);
    return { neighbors, loading, error };
}

function originFeatures(
    origin: MapTrack | undefined,
    neighbors: NeighborState | null,
    currentId: string | null
): VibeFeatures | null {
    if (!origin) return null;
    const source = neighbors?.originId === currentId ? neighbors.sourceFeatures : null;
    return { energy: origin.energy, valence: origin.valence,
        danceability: source?.danceability ?? null, arousal: source?.arousal ?? null };
}

function useTravelDerivations(args: UseTravelModeArgs, currentId: string | null,
    neighbors: NeighborState | null) {
    const enriched = useMemo(() => neighbors?.originId === currentId
        ? enrichFromMap(neighbors.list, args.trackById) : [],
    [neighbors, currentId, args.trackById]);
    const origin = currentId ? args.trackById.get(currentId) : undefined;
    const shown = useMemo(() => origin && args.state.mode === "travel"
        ? compassNeighbors(origin, enriched, args.state.direction, DEFAULT_COMPASS_COUNT) : [],
    [origin, enriched, args.state]);
    const onMap = useMemo(() => shown.filter((item) => args.trackById.has(item.id)),
        [shown, args.trackById]);
    const offMap = useMemo(() => shown.filter((item) => !args.trackById.has(item.id)),
        [shown, args.trackById]);
    const byId = useMemo(() => new Map(shown.map((item) => [item.id, item])), [shown]);
    return { onMap, offMap, byId,
        features: originFeatures(origin, neighbors, currentId) };
}

function useTravelActions(args: UseTravelModeArgs,
    byId: ReadonlyMap<string, CompassCandidate>) {
    const navigate = useCallback((id: string) => {
        const candidate = byId.get(id);
        if (candidate) args.controls.playTrack(waypointToTrack(candidate));
        if (args.trackById.has(id)) args.dispatch({ type: "TRAVEL_TO", id });
    }, [byId, args]);
    const queue = useCallback((id: string) => {
        const candidate = byId.get(id);
        if (candidate) args.controls.addToQueue(waypointToTrack(candidate));
    }, [byId, args.controls]);
    return { navigate, queue };
}

/** Derive the travel panel view, returning null outside travel mode. */
export function useTravelMode(args: UseTravelModeArgs): TravelView | null {
    const currentId = args.state.mode === "travel" ? args.state.currentId : null;
    const request = useNeighborRequest(currentId, args.state.mode === "travel");
    const derived = useTravelDerivations(args, currentId, request.neighbors);
    const actions = useTravelActions(args, derived.byId);
    if (args.state.mode !== "travel") return null;
    return {
        currentId: args.state.currentId,
        currentTitle: args.titleOf(args.state.currentId),
        breadcrumbTitles: args.state.breadcrumb.map((id) => ({ id, title: args.titleOf(id) })),
        direction: args.state.direction,
        onMapNeighbors: derived.onMap, offMapNeighbors: derived.offMap,
        loading: request.loading, error: request.error, quantiles: args.quantiles,
        originFeatures: derived.features,
        setDirection: (direction) => args.dispatch({ type: "SET_DIRECTION", direction }),
        navigate: actions.navigate, queue: actions.queue, close: args.exitToExplore,
    };
}
