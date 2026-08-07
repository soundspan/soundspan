"use client";

/**
 * useMapLayout — SINGLE SOURCE OF POSITIONS for the vibe map.
 *
 * Owns the natural (raw UMAP) vs spread (rank-redistributed) layout toggle,
 * its sessionStorage persistence, and the rAF morph between the two buffers.
 * Once tracks are loaded, the returned `positions` (a flat, index-aligned
 * Float32Array) is the only place any consumer reads a track's on-map
 * coordinates from — never `track.x`/`track.y` directly. `posOf(id)`
 * resolves by id (via `indexById`) for consumers that only have an id
 * (beacon, trail, decorations); the canvas and hit-test read by index.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapTrack } from "./types";
import {
    buildPositions,
    computeSpreadPositions,
    lerpPositions,
} from "./mapLayout";
import {
    readStoredString,
    sessionStorageSafe,
    writeStoredString,
} from "./useSessionTrail";
import { useLatest } from "./useLatest";
import { easeInOutCubic } from "./useMapCamera";

export type LayoutMode = "natural" | "spread";
export const LAYOUT_STORAGE_KEY = "vibe:layout-mode";
const LAYOUT_ANIM_MS = 400;

export function readStoredLayoutMode(): LayoutMode {
    return readStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY) === "spread"
        ? "spread"
        : "natural";
}

export interface UseMapLayout {
    /** The live, index-aligned [x0,y0,x1,y1,...] buffer every renderer reads. */
    positions: Float32Array;
    layoutMode: LayoutMode;
    toggleLayoutMode: () => void;
    /** Track id → buffer index. */
    indexById: ReadonlyMap<string, number>;
    /** Live position resolver — the single source id-based consumers read through. */
    posOf: (id: string) => { x: number; y: number } | null;
}

export interface UseMapLayoutArgs {
    tracks: readonly MapTrack[];
    reducedMotion: boolean;
}

export function useMapLayout({
    tracks,
    reducedMotion,
}: UseMapLayoutArgs): UseMapLayout {
    const naturalPositions = useMemo(() => buildPositions(tracks), [tracks]);
    const spreadPositions = useMemo(
        () => computeSpreadPositions(tracks),
        [tracks]
    );

    const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayoutMode);
    const layoutModeRef = useLatest(layoutMode);

    const [rawPositions, setRawPositions] = useState<Float32Array>(
        () => new Float32Array(0)
    );
    const layoutRafRef = useRef<number | null>(null);
    const layoutBuffersRef = useRef<[Float32Array, Float32Array]>([
        new Float32Array(0),
        new Float32Array(0),
    ]);
    const layoutFlipRef = useRef(0);

    // Hard-snap to the current mode's buffer whenever the track list changes
    // (initial load / reload) — no animation. Toggling layoutMode itself is
    // handled by toggleLayoutMode's own rAF loop, so this intentionally does
    // NOT depend on layoutMode (only on tracks / the buffers derived from it).
    useEffect(() => {
        if (layoutRafRef.current != null) {
            cancelAnimationFrame(layoutRafRef.current);
            layoutRafRef.current = null;
        }
        setRawPositions(
            layoutModeRef.current === "spread" ? spreadPositions : naturalPositions
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutModeRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this effect only re-snaps on a track-list/positions change, not a layout toggle.
    }, [tracks, naturalPositions, spreadPositions]);

    useEffect(() => {
        return () => {
            if (layoutRafRef.current != null) {
                cancelAnimationFrame(layoutRafRef.current);
            }
        };
    }, []);

    // Guard against the one-render gap between `tracks` changing and the
    // snap effect committing: fall back to the (always correctly-sized)
    // natural buffer rather than ever exposing a mismatched positions array.
    const positions =
        rawPositions.length === tracks.length * 2 ? rawPositions : naturalPositions;

    const toggleLayoutMode = useCallback(() => {
        const next: LayoutMode = layoutMode === "spread" ? "natural" : "spread";
        const from = positions;
        const to = next === "spread" ? spreadPositions : naturalPositions;

        setLayoutMode(next);
        writeStoredString(sessionStorageSafe(), LAYOUT_STORAGE_KEY, next);

        if (layoutRafRef.current != null) {
            cancelAnimationFrame(layoutRafRef.current);
            layoutRafRef.current = null;
        }

        // Reduced motion: snap straight to the target buffer in a single
        // setState — no rAF loop, no interpolation.
        if (reducedMotion) {
            setRawPositions(to);
            return;
        }

        if (layoutBuffersRef.current[0].length !== to.length) {
            layoutBuffersRef.current = [
                new Float32Array(to.length),
                new Float32Array(to.length),
            ];
        }

        const start =
            typeof performance !== "undefined" ? performance.now() : Date.now();
        const tick = (now: number) => {
            const elapsed = now - start;
            const t = Math.min(1, elapsed / LAYOUT_ANIM_MS);
            const eased = easeInOutCubic(t);
            const outBuf = layoutBuffersRef.current[layoutFlipRef.current % 2];
            layoutFlipRef.current += 1;
            setRawPositions(lerpPositions(from, to, eased, outBuf));
            if (t < 1) {
                layoutRafRef.current = requestAnimationFrame(tick);
            } else {
                layoutRafRef.current = null;
            }
        };
        layoutRafRef.current = requestAnimationFrame(tick);
    }, [layoutMode, positions, spreadPositions, naturalPositions, reducedMotion]);

    const indexById = useMemo(() => {
        const m = new Map<string, number>();
        for (let i = 0; i < tracks.length; i++) m.set(tracks[i].id, i);
        return m;
    }, [tracks]);

    const posOf = useCallback(
        (id: string): { x: number; y: number } | null => {
            const idx = indexById.get(id);
            if (idx == null) return null;
            return { x: positions[idx * 2], y: positions[idx * 2 + 1] };
        },
        [indexById, positions]
    );

    return { positions, layoutMode, toggleLayoutMode, indexById, posOf };
}
