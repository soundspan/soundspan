/**
 * Pure decisions behind the vibe map query: how a server answer folds into
 * the cached query state, and whether React Query should keep polling.
 *
 * The server answers either with a ready projection or with "building"
 * (optionally "failed", meaning the build is in a retry cooldown). While a
 * build runs we keep the last ready payload so the map never collapses to
 * a spinner during a rebuild.
 */

import type { MapTrack } from "./types";

/** Ready projection payload published by a completed map build. */
export interface VibeMapPayload {
    tracks: MapTrack[];
    trackCount: number;
    /** Browsable embedded tracks when the map was built; absent on older maps. */
    embeddedCount?: number;
    computedAt: string;
    /** True when the server had to project a random subset of the library. */
    sampled?: boolean;
}

/** Server answer: a ready payload, or a build in progress / cooling down. */
export type VibeMapResponse =
    | (VibeMapPayload & { building?: undefined })
    | { building: true; failed?: boolean; retryAt?: string };

/** What the server last said about the map. */
export type VibeMapPhase = "ready" | "building" | "failed";

/** Cached query state: the last ready payload plus the current phase. */
export interface VibeMapQueryData {
    payload: VibeMapPayload | null;
    phase: VibeMapPhase;
    /** Consecutive "building" answers since the last ready one. */
    buildingPolls: number;
    retryAt: string | null;
}

export const BUILDING_POLL_MS = 5000;
/** Ten minutes of five-second polls before we stop and say so. */
export const BUILDING_POLL_LIMIT = 120;

/** Fold one server answer into the previous cached state. */
export function mergeMapAnswer(
    previous: VibeMapQueryData | undefined,
    answer: VibeMapResponse,
): VibeMapQueryData {
    if (!answer.building) {
        return {
            payload: answer,
            phase: "ready",
            buildingPolls: 0,
            retryAt: null,
        };
    }
    const payload = previous?.payload ?? null;
    if (answer.failed) {
        return {
            payload,
            phase: "failed",
            buildingPolls: previous?.buildingPolls ?? 0,
            retryAt: answer.retryAt ?? null,
        };
    }
    return {
        payload,
        phase: "building",
        buildingPolls: (previous?.buildingPolls ?? 0) + 1,
        retryAt: null,
    };
}

/** True once a build has been "in progress" for longer than we will wait. */
export function isPollExhausted(data: VibeMapQueryData | undefined): boolean {
    return (
        data?.phase === "building" && data.buildingPolls > BUILDING_POLL_LIMIT
    );
}

/** Poll delay while a build runs, or false to stop. */
export function nextPollDelayMs(
    data: VibeMapQueryData | undefined,
): number | false {
    if (data?.phase !== "building") return false;
    return isPollExhausted(data) ? false : BUILDING_POLL_MS;
}
