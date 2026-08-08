"use client";

/** Persistent natural/spread layout with one animated position source. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapTrack } from "./types";
import { buildPositions, computeSpreadPositions, lerpPositions } from "./mapLayout";
import { readStoredString, sessionStorageSafe, writeStoredString } from "./useSessionTrail";
import { useLatest } from "./useLatest";
import { easeInOutCubic } from "./useMapCamera";

export type LayoutMode = "natural" | "spread";
export const LAYOUT_STORAGE_KEY = "vibe:layout-mode";
const LAYOUT_ANIM_MS = 400;

/** Read the persisted layout mode, defaulting safely to the natural layout. */
export function readStoredLayoutMode(): LayoutMode {
    return readStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY) === "spread"
        ? "spread" : "natural";
}

export interface UseMapLayout {
    positions: Float32Array;
    layoutMode: LayoutMode;
    toggleLayoutMode: () => void;
    indexById: ReadonlyMap<string, number>;
    posOf: (id: string) => { x: number; y: number } | null;
}

export interface UseMapLayoutArgs { tracks: readonly MapTrack[]; reducedMotion: boolean }

function animatePositions(
    from: Float32Array,
    to: Float32Array,
    rafRef: React.MutableRefObject<number | null>,
    buffersRef: React.MutableRefObject<[Float32Array, Float32Array]>,
    flipRef: React.MutableRefObject<number>,
    update: (positions: Float32Array) => void
): void {
    if (buffersRef.current[0].length !== to.length) {
        buffersRef.current = [new Float32Array(to.length), new Float32Array(to.length)];
    }
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / LAYOUT_ANIM_MS);
        const output = buffersRef.current[flipRef.current % 2];
        flipRef.current += 1;
        update(lerpPositions(from, to, easeInOutCubic(progress), output));
        rafRef.current = progress < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);
}

function cancelLayoutFrame(ref: React.MutableRefObject<number | null>): void {
    if (ref.current != null) cancelAnimationFrame(ref.current);
    ref.current = null;
}

function usePositionBuffer(args: {
    tracks: readonly MapTrack[];
    natural: Float32Array;
    spread: Float32Array;
    mode: LayoutMode;
    setMode: (mode: LayoutMode) => void;
    reducedMotion: boolean;
}): { positions: Float32Array; toggle: () => void } {
    const [raw, setRaw] = useState<Float32Array>(() => new Float32Array(0));
    const modeRef = useLatest(args.mode);
    const rafRef = useRef<number | null>(null);
    const buffersRef = useRef<[Float32Array, Float32Array]>([
        new Float32Array(0), new Float32Array(0),
    ]);
    const flipRef = useRef<number>(0);
    useEffect(() => {
        cancelLayoutFrame(rafRef);
        setRaw(modeRef.current === "spread" ? args.spread : args.natural);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modeRef and rafRef are stable.
    }, [args.tracks, args.natural, args.spread]);
    useEffect(() => () => cancelLayoutFrame(rafRef), []);
    const positions = raw.length === args.tracks.length * 2 ? raw : args.natural;
    const toggle = useCallback(() => {
        const next: LayoutMode = args.mode === "spread" ? "natural" : "spread";
        const target = next === "spread" ? args.spread : args.natural;
        args.setMode(next);
        writeStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY, next);
        cancelLayoutFrame(rafRef);
        if (args.reducedMotion) setRaw(target);
        else animatePositions(positions, target, rafRef, buffersRef, flipRef, setRaw);
    }, [args, positions]);
    return { positions, toggle };
}

function buildTrackIndex(tracks: readonly MapTrack[]): ReadonlyMap<string, number> {
    const index = new Map<string, number>();
    for (let position = 0; position < tracks.length; position++) {
        index.set(tracks[position].id, position);
    }
    return index;
}

/** Own the current layout buffer and id-based position resolver. */
export function useMapLayout({ tracks, reducedMotion }: UseMapLayoutArgs): UseMapLayout {
    const natural = useMemo(() => buildPositions(tracks), [tracks]);
    const spread = useMemo(() => computeSpreadPositions(tracks), [tracks]);
    const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayoutMode);
    const buffer = usePositionBuffer({
        tracks, natural, spread, mode: layoutMode,
        setMode: setLayoutMode, reducedMotion,
    });
    const indexById = useMemo(() => buildTrackIndex(tracks), [tracks]);
    const posOf = useCallback((id: string) => {
        const index = indexById.get(id);
        return index == null ? null : {
            x: buffer.positions[index * 2], y: buffer.positions[index * 2 + 1],
        };
    }, [indexById, buffer.positions]);
    return { positions: buffer.positions, layoutMode,
        toggleLayoutMode: buffer.toggle, indexById, posOf };
}
