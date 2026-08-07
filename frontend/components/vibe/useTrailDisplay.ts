"use client";

/**
 * useTrailDisplay — the session trail's display state + actions.
 *
 * Wraps `useSessionTrail` (the stored recently-played list) with everything
 * the map renders and the trail popover drives: the on/fade/off display mode
 * (persisted per session), the periodic re-fade tick, the drawn trail points
 * (recent tail only, projected through `posOf`), and the clear / save-as-
 * playlist actions. A partial playlist save surfaces as a warning toast via
 * `describeSaveResult`, never unconditional success.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    fadeAlphaForAge,
    readStoredTrailMode,
    sessionStorageSafe,
    useSessionTrail,
    writeStoredTrailMode,
    type TrailMode,
} from "./useSessionTrail";
import {
    describeSaveResult,
    formatPlaylistDate,
    saveTracksAsPlaylist,
} from "./savePlaylist";

/** Session-trail segments drawn (recent only — 50 stored points is spaghetti). */
export const TRAIL_DRAW_LIMIT = 12;
/** Recompute "fade" trail-mode opacity on this cadence while mounted. */
const TRAIL_FADE_RECOMPUTE_MS = 60_000;

export interface TrailPoint {
    x: number;
    y: number;
    alpha: number;
}

const EMPTY_TRAIL: TrailPoint[] = [];

export interface UseTrailDisplay {
    /** Ordered stored ids (oldest → newest) — the save-as-playlist source. */
    trailIds: string[];
    trailMode: TrailMode;
    setTrailMode: (mode: TrailMode) => void;
    /** The drawn tail (recent, on-map, fade-alpha'd) in world coordinates. */
    trailPoints: TrailPoint[];
    clearTrail: () => void;
    saveTrail: () => Promise<void>;
    trailSaving: boolean;
}

export interface UseTrailDisplayArgs {
    /** Live position resolver from useMapLayout. */
    posOf: (id: string) => { x: number; y: number } | null;
}

export function useTrailDisplay({ posOf }: UseTrailDisplayArgs): UseTrailDisplay {
    const { trailIds, entries, clear } = useSessionTrail();

    // Trail display mode (on / fade / off), persisted across the session.
    const [trailMode, setTrailModeState] = useState<TrailMode>(() =>
        readStoredTrailMode(sessionStorageSafe())
    );
    const setTrailMode = useCallback((mode: TrailMode) => {
        setTrailModeState(mode);
        writeStoredTrailMode(sessionStorageSafe(), mode);
    }, []);

    const clearTrail = useCallback(() => {
        clear();
        toast.success("Trail cleared");
    }, [clear]);

    // Save the full stored trail (all entries, oldest -> newest — not just
    // the drawn tail, which is capped at TRAIL_DRAW_LIMIT for legibility) as
    // a playlist.
    const [trailSaving, setTrailSaving] = useState(false);
    const saveTrail = useCallback(async () => {
        if (trailIds.length === 0) return;
        setTrailSaving(true);
        try {
            const name = `Vibe history — ${formatPlaylistDate()}`;
            const result = await saveTracksAsPlaylist(name, trailIds);
            const outcome = describeSaveResult(name, result);
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setTrailSaving(false);
        }
    }, [trailIds]);

    // "Fade" mode ages trail entries out over time even when nothing else
    // changes — recompute periodically while it's the active mode (and the
    // map is mounted) so a segment keeps fading instead of only updating on
    // the next track change.
    const [trailFadeTick, setTrailFadeTick] = useState(0);
    useEffect(() => {
        if (trailMode !== "fade") return;
        const id = setInterval(
            () => setTrailFadeTick((t) => t + 1),
            TRAIL_FADE_RECOMPUTE_MS
        );
        return () => clearInterval(id);
    }, [trailMode]);

    const trailPoints = useMemo(() => {
        if (trailMode === "off") return EMPTY_TRAIL;
        const now = Date.now();
        const pts: TrailPoint[] = [];
        for (const entry of entries.slice(-TRAIL_DRAW_LIMIT)) {
            const p = posOf(entry.trackId);
            if (!p) continue;
            const alpha =
                trailMode === "fade" ? fadeAlphaForAge(now - entry.at) : 1;
            if (alpha <= 0) continue; // fully aged out — drop from the drawn set
            pts.push({ x: p.x, y: p.y, alpha });
        }
        return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trailFadeTick is intentionally unused in the body: it exists purely to force this memo to recompute every 60s while "fade" mode ages trail entries out.
    }, [entries, posOf, trailMode, trailFadeTick]);

    return {
        trailIds,
        trailMode,
        setTrailMode,
        trailPoints,
        clearTrail,
        saveTrail,
        trailSaving,
    };
}
