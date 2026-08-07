"use client";

/**
 * useMapSweep — sweep-to-queue state + actions for the vibe map.
 *
 * The pointer becomes a brush (shift+drag on mouse, or the armed brush
 * toggle on touch) and visible dots along the stroke are collected in
 * first-touch order via the pure `sweepCollect` geometry. This hook owns the
 * whole sweep lifecycle: the armed toggle, the live in-stroke scratchpad
 * (a ref — state carries render copies), the frozen result chip, and the
 * chip's Play / Queue / Save actions. `useMapGestures` drives
 * `begin`/`extend`/`finish`/`discard` from raw pointer events; the container
 * renders `live` (stroke polyline + glow) and `result` (the chip).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { MapTrack } from "./types";
import type { Viewport } from "./mapViewport";
import { collectHits, sampleSegment, type SweepPoint } from "./sweepCollect";
import { mapTrackToTrack } from "./journeyTracks";
import {
    describeSaveResult,
    formatPlaylistDate,
    saveTracksAsPlaylist,
} from "./savePlaylist";
import type { VibeControls } from "./useVibeMode";

/** Live sweep-gesture scratchpad (a ref — state carries render copies). */
interface SweepScratch {
    seen: Set<string>;
    ids: string[];
    stroke: SweepPoint[];
    last: SweepPoint;
}

export interface SweepLive {
    stroke: SweepPoint[];
    ids: string[];
}

export interface UseMapSweep {
    /** The touch-path brush toggle (mouse users just hold shift). */
    brushArmed: boolean;
    toggleBrush: () => void;
    /** The in-progress stroke (render copies), or null. */
    live: SweepLive | null;
    /** The frozen post-stroke result feeding the action chip, or null. */
    result: { ids: string[] } | null;
    /** True while the result chip is showing. */
    chipOpen: boolean;
    /** Whether a pointer-down with these modifiers should start a sweep. */
    eligible: (mods: { shiftKey: boolean }) => boolean;
    /** True while a stroke is being drawn. */
    active: () => boolean;
    /** Start a stroke at `cursor` (container-relative px). */
    begin: (cursor: SweepPoint) => void;
    /** Extend the stroke to `cursor`, collecting along the sampled segment. */
    extend: (cursor: SweepPoint) => void;
    /**
     * End the stroke. A real drag with catches freezes into the result chip
     * (returns true — the pointer-up is consumed); a stationary tap returns
     * false so the caller falls through to click semantics.
     */
    finish: (wasClick: boolean) => boolean;
    /** Abandon a live stroke (pinch start, pointer cancel). */
    discard: () => void;
    dismissResult: () => void;
    /** Dot ids to glow while a stroke is live or its chip is open. */
    highlight: ReadonlySet<string> | null;
    play: () => void;
    queue: () => void;
    save: () => Promise<void>;
    saving: boolean;
}

export interface UseMapSweepArgs {
    /** Index-aligned track list (parallel to `positions`/`mask`). */
    tracks: readonly MapTrack[];
    /** Flat [x0,y0,...] world positions (the live layout buffer). */
    positions: Float32Array;
    /** Visibility mask — filtered-out dots are never collected. */
    mask: Uint8Array;
    /** Live viewport ref (reads during a stroke must not re-subscribe). */
    viewportRef: React.RefObject<Viewport | null>;
    trackById: ReadonlyMap<string, MapTrack>;
    controls: Pick<VibeControls, "playTracks" | "addToQueue">;
}

export function useMapSweep({
    tracks,
    positions,
    mask,
    viewportRef,
    trackById,
    controls,
}: UseMapSweepArgs): UseMapSweep {
    const [brushArmed, setBrushArmed] = useState(false);
    const [live, setLive] = useState<SweepLive | null>(null);
    const [result, setResult] = useState<{ ids: string[] } | null>(null);
    const [saving, setSaving] = useState(false);
    const scratchRef = useRef<SweepScratch | null>(null);

    const toggleBrush = useCallback(() => setBrushArmed((v) => !v), []);

    // Collect visible dots around one brush sample into the live sweep.
    const collectAt = useCallback(
        (scratch: SweepScratch, cursor: SweepPoint) => {
            const vp = viewportRef.current;
            if (!vp) return;
            collectHits({
                cursor,
                ids: tracks,
                positions,
                mask,
                viewport: vp,
                seen: scratch.seen,
                out: scratch.ids,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- viewportRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [tracks, positions, mask]
    );

    const eligible = useCallback(
        (mods: { shiftKey: boolean }) => brushArmed || mods.shiftKey,
        [brushArmed]
    );

    const active = useCallback(() => scratchRef.current !== null, []);

    const begin = useCallback(
        (cursor: SweepPoint) => {
            const scratch: SweepScratch = {
                seen: new Set(),
                ids: [],
                stroke: [cursor],
                last: cursor,
            };
            collectAt(scratch, cursor);
            scratchRef.current = scratch;
            setLive({ stroke: [...scratch.stroke], ids: [...scratch.ids] });
            setResult(null);
        },
        [collectAt]
    );

    const extend = useCallback(
        (cursor: SweepPoint) => {
            const scratch = scratchRef.current;
            if (!scratch) return;
            // Sampling between the previous and current point keeps a fast
            // flick from skipping over dots.
            for (const pt of sampleSegment(scratch.last, cursor)) {
                collectAt(scratch, pt);
            }
            scratch.last = cursor;
            scratch.stroke.push(cursor);
            setLive({ stroke: [...scratch.stroke], ids: [...scratch.ids] });
        },
        [collectAt]
    );

    const finish = useCallback((wasClick: boolean): boolean => {
        const scratch = scratchRef.current;
        if (!scratch) return false;
        scratchRef.current = null;
        setLive(null);
        if (wasClick) {
            // A stationary shift-click falls through to normal click
            // semantics (shift-click-to-queue) instead of producing an empty
            // sweep.
            return false;
        }
        if (scratch.ids.length > 0) {
            setResult({ ids: [...scratch.ids] });
        }
        return true;
    }, []);

    const discard = useCallback(() => {
        scratchRef.current = null;
        setLive(null);
    }, []);

    const dismissResult = useCallback(() => setResult(null), []);

    // Sweep glow wins the canvas highlight while a stroke is live or its
    // chip is open (no dimming — the sweep is additive, not a filter).
    const sweepIds = live?.ids ?? result?.ids ?? null;
    const highlight = useMemo(
        () => (sweepIds && sweepIds.length > 0 ? new Set(sweepIds) : null),
        [sweepIds]
    );

    // Chip actions. Queueing is silent per track + one summary toast — N
    // per-track toasts would bury the screen.
    const sweptTracks = useCallback(
        (ids: readonly string[]) => {
            const list: MapTrack[] = [];
            for (const id of ids) {
                const t = trackById.get(id);
                if (t) list.push(t);
            }
            return list;
        },
        [trackById]
    );

    const play = useCallback(() => {
        if (!result) return;
        const list = sweptTracks(result.ids).map(mapTrackToTrack);
        if (list.length > 0) controls.playTracks(list, 0, true);
        setResult(null);
    }, [result, sweptTracks, controls]);

    const queue = useCallback(() => {
        if (!result) return;
        const list = sweptTracks(result.ids);
        for (const t of list) {
            controls.addToQueue(mapTrackToTrack(t), { silent: true });
        }
        if (list.length > 0) {
            toast.success(
                `Queued ${list.length} swept track${list.length === 1 ? "" : "s"}`
            );
        }
        setResult(null);
    }, [result, sweptTracks, controls]);

    const save = useCallback(async () => {
        if (!result) return;
        const ids = result.ids;
        if (ids.length === 0) {
            setResult(null);
            return;
        }
        setSaving(true);
        try {
            const name = `Vibe sweep — ${formatPlaylistDate()}`;
            const saved = await saveTracksAsPlaylist(name, ids);
            const outcome = describeSaveResult(name, saved);
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setSaving(false);
            setResult(null);
        }
    }, [result]);

    return {
        brushArmed,
        toggleBrush,
        live,
        result,
        chipOpen: result !== null,
        eligible,
        active,
        begin,
        extend,
        finish,
        discard,
        dismissResult,
        highlight,
        play,
        queue,
        save,
        saving,
    };
}
