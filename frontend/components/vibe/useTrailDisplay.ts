"use client";

/** Display state and playlist actions layered over the stored session trail. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    fadeAlphaForAge, readStoredTrailMode, sessionStorageSafe, useSessionTrail,
    writeStoredTrailMode, type TrailEntry, type TrailMode,
} from "./useSessionTrail";
import { describeSaveResult, formatPlaylistDate, saveTracksAsPlaylist } from "./savePlaylist";

export const TRAIL_DRAW_LIMIT = 12;
const TRAIL_FADE_RECOMPUTE_MS = 60_000;
const EMPTY_TRAIL: TrailPoint[] = [];

export interface TrailPoint { x: number; y: number; alpha: number }
export interface UseTrailDisplay {
    trailIds: string[];
    trailMode: TrailMode;
    setTrailMode: (mode: TrailMode) => void;
    trailPoints: TrailPoint[];
    clearTrail: () => void;
    saveTrail: () => Promise<void>;
    trailSaving: boolean;
}
export interface UseTrailDisplayArgs {
    posOf: (id: string) => { x: number; y: number } | null;
}

function useTrailModeState(): [TrailMode, (mode: TrailMode) => void] {
    const [mode, setMode] = useState<TrailMode>(() =>
        readStoredTrailMode(sessionStorageSafe()));
    const update = useCallback((next: TrailMode) => {
        setMode(next);
        writeStoredTrailMode(sessionStorageSafe(), next);
    }, []);
    return [mode, update];
}

function useTrailSave(trailIds: readonly string[]) {
    const [saving, setSaving] = useState(false);
    const save = useCallback(async () => {
        if (trailIds.length === 0) return;
        setSaving(true);
        try {
            const name = `Vibe history — ${formatPlaylistDate()}`;
            const result = await saveTracksAsPlaylist(name, trailIds);
            const outcome = describeSaveResult(name, result);
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setSaving(false);
        }
    }, [trailIds]);
    return { saving, save };
}

function useTrailPoints(
    entries: readonly TrailEntry[],
    mode: TrailMode,
    posOf: UseTrailDisplayArgs["posOf"]
): TrailPoint[] {
    const [fadeTick, setFadeTick] = useState(0);
    useEffect(() => {
        if (mode !== "fade") return;
        const id = setInterval(() => setFadeTick((tick) => tick + 1),
            TRAIL_FADE_RECOMPUTE_MS);
        return () => clearInterval(id);
    }, [mode]);
    return useMemo(() => {
        if (mode === "off") return EMPTY_TRAIL;
        const now = Date.now();
        const points: TrailPoint[] = [];
        for (const entry of entries.slice(-TRAIL_DRAW_LIMIT)) {
            const position = posOf(entry.trackId);
            if (!position) continue;
            const alpha = mode === "fade" ? fadeAlphaForAge(now - entry.at) : 1;
            if (alpha > 0) points.push({ ...position, alpha });
        }
        return points;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fadeTick deliberately triggers aging.
    }, [entries, posOf, mode, fadeTick]);
}

/** Compose stored trail data into the map's display and action surface. */
export function useTrailDisplay({ posOf }: UseTrailDisplayArgs): UseTrailDisplay {
    const { trailIds, entries, clear } = useSessionTrail();
    const [trailMode, setTrailMode] = useTrailModeState();
    const save = useTrailSave(trailIds);
    const clearTrail = useCallback(() => {
        clear();
        toast.success("Trail cleared");
    }, [clear]);
    return { trailIds, trailMode, setTrailMode,
        trailPoints: useTrailPoints(entries, trailMode, posOf),
        clearTrail, saveTrail: save.save, trailSaving: save.saving };
}
