"use client";

/**
 * useTravelMode — the travel constellation's async data + derived view.
 *
 * Owns the similar-neighbours fetch for the current travel origin, the
 * map-enrichment + compass filtering derivations, and the ready-to-render
 * `TravelView`. Returns null outside travel mode. One of the three focused
 * per-mode hooks composed by `useVibeMode` (the mode transitions themselves
 * live in `vibeModeMachine`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { MapTrack } from "./types";
import {
    compassNeighbors,
    enrichFromMap,
    DEFAULT_COMPASS_COUNT,
    type CompassCandidate,
    type CompassDirection,
} from "./travelCompass";
import { waypointToTrack } from "./journeyTracks";
import type { ModeAction, ModeState } from "./vibeModeMachine";
import type { VibeControls } from "./useVibeMode";

const SIMILAR_LIMIT = 24;

/** The four audio features the Travel explainability breakdown compares. */
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
    /** Library-calibrated distance quantiles, or null (uncalibrated fallback). */
    quantiles: readonly number[] | null;
    /** The current origin's own audio features, for the explainability breakdown. */
    originFeatures: VibeFeatures | null;
    setDirection: (d: CompassDirection) => void;
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

export function useTravelMode({
    state,
    dispatch,
    trackById,
    controls,
    quantiles,
    titleOf,
    exitToExplore,
}: UseTravelModeArgs): TravelView | null {
    // Neighbours are tagged with the origin they were fetched for, and every
    // consumer derives [] unless the tag matches the CURRENT travel origin.
    // This is what kills the "strings stay behind" bug: navigating to a new
    // node instantly hides the old node's constellation (no frame ever draws
    // edges from the new origin to the old origin's neighbours), without any
    // clear-before-fetch effect-ordering games.
    const [rawNeighbors, setRawNeighbors] = useState<{
        originId: string;
        list: CompassCandidate[];
        /** The origin's own danceability/arousal, from the /similar response. */
        sourceFeatures: VibeFeatures | null;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Mode exclusivity: leaving travel drops its overlay state.
    const inTravel = state.mode === "travel";
    useEffect(() => {
        if (!inTravel) {
            setRawNeighbors(null);
            setError(null);
        }
    }, [inTravel]);

    // Fetch similar tracks for the current origin.
    const travelCurrentId = state.mode === "travel" ? state.currentId : null;
    useEffect(() => {
        if (!travelCurrentId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.getVibeSimilarTracks(travelCurrentId, SIMILAR_LIMIT)
            .then((res) => {
                if (cancelled) return;
                setRawNeighbors({
                    originId: travelCurrentId,
                    sourceFeatures: res.sourceFeatures ?? null,
                    list: res.tracks.map((t) => ({
                        id: t.id,
                        title: t.title,
                        album: t.album,
                        artist: t.artist,
                        // client type omits similarity; derive from cosine distance.
                        similarity: Math.max(0, 1 - t.distance / 2),
                        distance: t.distance,
                        energy: t.audioFeatures?.energy ?? null,
                        valence: t.audioFeatures?.valence ?? null,
                        danceability: t.audioFeatures?.danceability ?? null,
                        arousal: t.audioFeatures?.arousal ?? null,
                        moods: null,
                    })),
                });
            })
            .catch(() => {
                if (!cancelled) setError("Couldn't load nearby vibes");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [travelCurrentId]);

    // --- derivations --------------------------------------------------------
    const enrichedNeighbors = useMemo(() => {
        if (!rawNeighbors || rawNeighbors.originId !== travelCurrentId) return [];
        return enrichFromMap(rawNeighbors.list, trackById);
    }, [rawNeighbors, travelCurrentId, trackById]);

    const travelOrigin =
        travelCurrentId != null ? trackById.get(travelCurrentId) : undefined;

    // Origin features for the explainability breakdown: energy/valence come
    // from the map projection (always present for an on-map origin);
    // danceability/arousal aren't in the map payload, so they come from the
    // /similar fetch's sourceFeatures — guarded to the matching origin so a
    // stale fetch for a previous node never mislabels the new one's features.
    const originFeatures: VibeFeatures | null = useMemo(() => {
        if (!travelOrigin) return null;
        const sourceFeatures =
            rawNeighbors && rawNeighbors.originId === travelCurrentId
                ? rawNeighbors.sourceFeatures
                : null;
        return {
            energy: travelOrigin.energy,
            valence: travelOrigin.valence,
            danceability: sourceFeatures?.danceability ?? null,
            arousal: sourceFeatures?.arousal ?? null,
        };
    }, [travelOrigin, rawNeighbors, travelCurrentId]);

    const shownNeighbors = useMemo(() => {
        if (!travelOrigin || state.mode !== "travel") return [];
        return compassNeighbors(
            travelOrigin,
            enrichedNeighbors,
            state.direction,
            DEFAULT_COMPASS_COUNT
        );
    }, [travelOrigin, enrichedNeighbors, state]);

    const onMapNeighbors = useMemo(
        () => shownNeighbors.filter((n) => trackById.has(n.id)),
        [shownNeighbors, trackById]
    );
    const offMapNeighbors = useMemo(
        () => shownNeighbors.filter((n) => !trackById.has(n.id)),
        [shownNeighbors, trackById]
    );

    // Lookup by id over the full (on-map + off-map) shown neighbours, so
    // navigate/queue can build a playable Track from the candidate payload
    // itself even when the neighbour isn't plotted on this map sample.
    const shownNeighborById = useMemo(() => {
        const m = new Map<string, CompassCandidate>();
        for (const n of shownNeighbors) m.set(n.id, n);
        return m;
    }, [shownNeighbors]);

    const navigate = useCallback(
        (id: string) => {
            const candidate = shownNeighborById.get(id);
            if (candidate) controls.playTrack(waypointToTrack(candidate));
            // Only move `currentId` (and trigger the neighbours refetch) when the
            // target is actually on the map — off-map neighbours play/queue but
            // never become the new travel origin.
            if (trackById.has(id)) dispatch({ type: "TRAVEL_TO", id });
        },
        [shownNeighborById, trackById, controls, dispatch]
    );

    const queue = useCallback(
        (id: string) => {
            const candidate = shownNeighborById.get(id);
            if (candidate) controls.addToQueue(waypointToTrack(candidate));
        },
        [shownNeighborById, controls]
    );

    if (state.mode !== "travel") return null;
    return {
        currentId: state.currentId,
        currentTitle: titleOf(state.currentId),
        breadcrumbTitles: state.breadcrumb.map((id) => ({
            id,
            title: titleOf(id),
        })),
        direction: state.direction,
        onMapNeighbors,
        offMapNeighbors,
        loading,
        error,
        quantiles,
        originFeatures,
        setDirection: (d) => dispatch({ type: "SET_DIRECTION", direction: d }),
        navigate,
        queue,
        close: exitToExplore,
    };
}
