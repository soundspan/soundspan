"use client";

/** Sweep-to-queue stroke state and result actions for the vibe map. */

import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { MapTrack } from "./types";
import type { Viewport } from "./mapViewport";
import { collectHits, sampleSegment, type SweepPoint } from "./sweepCollect";
import { mapTrackToTrack } from "./journeyTracks";
import { describeSaveResult, formatPlaylistDate, saveTracksAsPlaylist } from "./savePlaylist";
import type { VibeControls } from "./useVibeMode";

interface SweepScratch {
    seen: Set<string>;
    ids: string[];
    stroke: SweepPoint[];
    last: SweepPoint;
}

export interface SweepLive { stroke: SweepPoint[]; ids: string[] }
/** Frozen collection displayed by the post-sweep action chip. */
export interface SweepResult { ids: string[] }

export interface UseMapSweep {
    brushArmed: boolean;
    toggleBrush: () => void;
    live: SweepLive | null;
    result: SweepResult | null;
    chipOpen: boolean;
    eligible: (mods: { shiftKey: boolean }) => boolean;
    active: () => boolean;
    begin: (cursor: SweepPoint) => void;
    extend: (cursor: SweepPoint) => void;
    finish: (wasClick: boolean) => boolean;
    discard: () => void;
    dismissResult: () => void;
    highlight: ReadonlySet<string> | null;
    play: () => void;
    queue: () => void;
    save: () => Promise<void>;
    saving: boolean;
}

export interface UseMapSweepArgs {
    tracks: readonly MapTrack[];
    positions: Float32Array;
    mask: Uint8Array;
    viewportRef: React.RefObject<Viewport | null>;
    trackById: ReadonlyMap<string, MapTrack>;
    controls: Pick<VibeControls, "playTracks" | "addToQueue">;
}

function collectAt(args: UseMapSweepArgs, scratch: SweepScratch, cursor: SweepPoint): void {
    const viewport = args.viewportRef.current;
    if (!viewport) return;
    collectHits({ cursor, ids: args.tracks, positions: args.positions,
        mask: args.mask, viewport, seen: scratch.seen, out: scratch.ids });
}

interface StrokeState {
    brushArmed: boolean;
    live: SweepLive | null;
    result: SweepResult | null;
    setResult: Dispatch<SetStateAction<SweepResult | null>>;
    toggleBrush: () => void;
    eligible: (mods: { shiftKey: boolean }) => boolean;
    active: () => boolean;
    begin: (cursor: SweepPoint) => void;
    extend: (cursor: SweepPoint) => void;
    finish: (wasClick: boolean) => boolean;
    discard: () => void;
    dismissResult: () => void;
}

function useSweepStroke(args: UseMapSweepArgs): StrokeState {
    const [brushArmed, setBrushArmed] = useState(false);
    const [live, setLive] = useState<SweepLive | null>(null);
    const [result, setResult] = useState<SweepResult | null>(null);
    const scratchRef = useRef<SweepScratch | null>(null);
    const toggleBrush = useCallback(() => setBrushArmed((armed) => !armed), []);
    const eligible = useCallback((mods: { shiftKey: boolean }) =>
        brushArmed || mods.shiftKey, [brushArmed]);
    const active = useCallback(() => scratchRef.current !== null, []);
    const begin = useCallback((cursor: SweepPoint) => {
        const scratch: SweepScratch = {
            seen: new Set(), ids: [], stroke: [cursor], last: cursor,
        };
        collectAt(args, scratch, cursor);
        scratchRef.current = scratch;
        setLive({ stroke: [...scratch.stroke], ids: [...scratch.ids] });
        setResult(null);
    }, [args]);
    const extend = useCallback((cursor: SweepPoint) => {
        const scratch = scratchRef.current;
        if (!scratch) return;
        for (const point of sampleSegment(scratch.last, cursor)) collectAt(args, scratch, point);
        scratch.last = cursor;
        scratch.stroke.push(cursor);
        setLive({ stroke: [...scratch.stroke], ids: [...scratch.ids] });
    }, [args]);
    const finish = useCallback((wasClick: boolean) => {
        const scratch = scratchRef.current;
        if (!scratch) return false;
        scratchRef.current = null;
        setLive(null);
        if (wasClick) return false;
        if (scratch.ids.length > 0) setResult({ ids: [...scratch.ids] });
        return true;
    }, []);
    const discard = useCallback(() => {
        scratchRef.current = null;
        setLive(null);
    }, []);
    const dismissResult = useCallback(() => setResult(null), []);
    return { brushArmed, live, result, setResult, toggleBrush, eligible, active,
        begin, extend, finish, discard, dismissResult };
}

function sweptTracks(ids: readonly string[], tracks: ReadonlyMap<string, MapTrack>): MapTrack[] {
    return ids.flatMap((id) => {
        const track = tracks.get(id);
        return track ? [track] : [];
    });
}

function useSweepPlayback(
    result: SweepResult | null,
    setResult: StrokeState["setResult"],
    args: UseMapSweepArgs
) {
    const play = useCallback(() => {
        if (!result) return;
        const tracks = sweptTracks(result.ids, args.trackById).map(mapTrackToTrack);
        if (tracks.length > 0) args.controls.playTracks(tracks, 0, true);
        setResult(null);
    }, [result, args, setResult]);
    const queue = useCallback(() => {
        if (!result) return;
        const tracks = sweptTracks(result.ids, args.trackById);
        for (const track of tracks) {
            args.controls.addToQueue(mapTrackToTrack(track), { silent: true });
        }
        if (tracks.length > 0) toast.success(
            `Queued ${tracks.length} swept track${tracks.length === 1 ? "" : "s"}`);
        setResult(null);
    }, [result, args, setResult]);
    return { play, queue };
}

function useSweepSave(result: SweepResult | null, setResult: StrokeState["setResult"]) {
    const [saving, setSaving] = useState(false);
    const save = useCallback(async () => {
        if (!result) return;
        if (result.ids.length === 0) {
            setResult(null);
            return;
        }
        setSaving(true);
        try {
            const name = `Vibe sweep — ${formatPlaylistDate()}`;
            const outcome = describeSaveResult(name,
                await saveTracksAsPlaylist(name, result.ids));
            if (outcome.tone === "success") toast.success(outcome.message);
            else toast.warning(outcome.message);
        } catch {
            toast.error("Couldn't save that playlist");
        } finally {
            setSaving(false);
            setResult(null);
        }
    }, [result, setResult]);
    return { saving, save };
}

/** Own the active sweep stroke, frozen result, and result-chip actions. */
export function useMapSweep(args: UseMapSweepArgs): UseMapSweep {
    const stroke = useSweepStroke(args);
    const playback = useSweepPlayback(stroke.result, stroke.setResult, args);
    const save = useSweepSave(stroke.result, stroke.setResult);
    const ids = stroke.live?.ids ?? stroke.result?.ids ?? null;
    const highlight = useMemo(() => ids?.length ? new Set(ids) : null, [ids]);
    return { brushArmed: stroke.brushArmed, toggleBrush: stroke.toggleBrush,
        live: stroke.live, result: stroke.result, chipOpen: stroke.result !== null,
        eligible: stroke.eligible, active: stroke.active, begin: stroke.begin,
        extend: stroke.extend, finish: stroke.finish, discard: stroke.discard,
        dismissResult: stroke.dismissResult, highlight,
        play: playback.play, queue: playback.queue, save: save.save, saving: save.saving };
}
