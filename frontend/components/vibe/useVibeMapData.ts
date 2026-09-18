"use client";

/**
 * Server state for the VibeMap, owned by React Query, plus the container
 * measurement hook. The query keeps the last ready projection while a
 * build runs (see mapQueryPolicy), so a rebuild never blanks the map.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import {
    isPollExhausted,
    mergeMapAnswer,
    nextPollDelayMs,
    type VibeMapQueryData,
} from "./mapQueryPolicy";
import type { MapRebuildState } from "./mapStatus";
import type { MapDims } from "./mapViewport";
import type { MapTrack } from "./types";

/** Map API state consumed by the controller. */
export interface VibeMapData {
    tracks: MapTrack[];
    trackCount: number;
    /** Songs the map was drawn from; null when the server did not say. */
    embeddedCount: number | null;
    /** ISO timestamp of the build behind `tracks`; null until first load. */
    computedAt: string | null;
    /** True when the server projected a random subset of the library. */
    sampled: boolean;
    loading: boolean;
    building: boolean;
    error: string | null;
    rebuildState: MapRebuildState;
    /** Ask the server for a fresh build; keeps the current dots on screen. */
    rebuild: () => void;
    quantiles: readonly number[] | null;
}

const STALLED_MESSAGE =
    "The map is still being built — try again in a few minutes";
const FAILED_MESSAGE =
    "The last map build failed. It will retry automatically — check back in a few minutes.";
const LOAD_ERROR_MESSAGE = "Failed to load vibe map data";

type LoadView = Pick<VibeMapData, "loading" | "building" | "error">;

/** First-load presentation: with no payload yet, the phase drives the overlay. */
function describeLoad(
    data: VibeMapQueryData | undefined,
    requestFailed: boolean,
): LoadView {
    if (data?.payload) return { loading: false, building: false, error: null };
    if (requestFailed) {
        return { loading: false, building: false, error: LOAD_ERROR_MESSAGE };
    }
    if (data?.phase === "failed") {
        return { loading: false, building: false, error: FAILED_MESSAGE };
    }
    if (data?.phase === "building") {
        if (isPollExhausted(data)) {
            return { loading: false, building: false, error: STALLED_MESSAGE };
        }
        return { loading: true, building: true, error: null };
    }
    return { loading: true, building: false, error: null };
}

/** Rebuild presentation: with a payload on screen, only the chip reports. */
function describeRebuild(
    data: VibeMapQueryData | undefined,
    request: { isPending: boolean; isError: boolean },
): MapRebuildState {
    if (request.isPending) return "requesting";
    if (request.isError) return "error";
    if (!data?.payload) return "idle";
    if (data.phase === "failed") return "failed";
    if (data.phase === "building") {
        return isPollExhausted(data) ? "stalled" : "building";
    }
    return "idle";
}

function useMapQuery() {
    const queryClient = useQueryClient();
    return useQuery({
        queryKey: queryKeys.vibeMap(),
        queryFn: async ({ signal }) =>
            mergeMapAnswer(
                queryClient.getQueryData<VibeMapQueryData>(queryKeys.vibeMap()),
                await api.getVibeMap({ signal }),
            ),
        retry: false,
        refetchInterval: (query) => nextPollDelayMs(query.state.data),
    });
}

function useRebuildRequest() {
    const queryClient = useQueryClient();
    const { mutate, isPending, isError } = useMutation({
        mutationFn: () => api.rebuildVibeMap(),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: queryKeys.vibeMap() }),
    });
    const rebuild = useCallback(() => mutate(), [mutate]);
    return { rebuild, isPending, isError };
}

function useMapTracks(): Omit<VibeMapData, "quantiles"> {
    const query = useMapQuery();
    const request = useRebuildRequest();
    const payload = query.data?.payload ?? null;
    return {
        tracks: payload?.tracks ?? [],
        trackCount: payload?.trackCount ?? 0,
        embeddedCount: payload?.embeddedCount ?? null,
        computedAt: payload?.computedAt ?? null,
        sampled: payload?.sampled === true,
        ...describeLoad(query.data, query.isError),
        rebuildState: describeRebuild(query.data, request),
        rebuild: request.rebuild,
    };
}

function useCalibration(): readonly number[] | null {
    const { data } = useQuery({
        queryKey: queryKeys.vibeCalibration(),
        queryFn: ({ signal }) => api.getVibeCalibration({ signal }),
        retry: false,
    });
    if (!data || data.sampleSize <= 0) return null;
    return data.quantiles;
}

/** Map tracks and best-effort calibration data from the query cache. */
export function useVibeMapData(): VibeMapData {
    return { ...useMapTracks(), quantiles: useCalibration() };
}

/** Measure a map container with ResizeObserver. */
export function useMapDimensions(
    containerRef: RefObject<HTMLElement | null>,
): MapDims {
    const [dims, setDims] = useState<MapDims>({ width: 0, height: 0 });
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => {
            const rect = container.getBoundingClientRect();
            setDims({ width: rect.width, height: rect.height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [containerRef]);
    return dims;
}
