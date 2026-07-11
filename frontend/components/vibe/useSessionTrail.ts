/**
 * useSessionTrail — sessionStorage-backed ordered list of recently played track
 * ids. Appends when `useAudioState().currentTrack.id` changes while mounted,
 * dedupes consecutive repeats, caps at 50.
 *
 * The pure core (append + storage read/write) is exported for unit tests; the
 * hook is the thin React layer. All storage access is SSR/node guarded.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioState } from "@/lib/audio-state-context";

export interface TrailEntry {
    trackId: string;
    /** Epoch ms when appended. */
    at: number;
}

export const TRAIL_STORAGE_KEY = "vibe:session-trail";
export const TRAIL_CAP = 50;

/** Minimal Storage surface so the pure core can be tested with a stub. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/**
 * Pure: append `trackId` unless it duplicates the most recent entry; cap length
 * to `cap` (dropping oldest). Returns the same array reference when unchanged.
 */
export function appendTrailEntry(
    trail: readonly TrailEntry[],
    trackId: string,
    at: number,
    cap: number = TRAIL_CAP
): TrailEntry[] {
    const last = trail[trail.length - 1];
    if (last && last.trackId === trackId) return trail as TrailEntry[];
    const next = [...trail, { trackId, at }];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

export function readStoredTrail(storage: StorageLike | null): TrailEntry[] {
    if (!storage) return [];
    try {
        const raw = storage.getItem(TRAIL_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (e): e is TrailEntry =>
                !!e &&
                typeof (e as TrailEntry).trackId === "string" &&
                typeof (e as TrailEntry).at === "number"
        );
    } catch {
        return [];
    }
}

export function writeStoredTrail(
    storage: StorageLike | null,
    trail: readonly TrailEntry[]
): void {
    if (!storage) return;
    try {
        storage.setItem(TRAIL_STORAGE_KEY, JSON.stringify(trail));
    } catch {
        /* quota / private-mode / SSR — trail is best-effort */
    }
}

/** sessionStorage if available, else null (SSR / node / blocked). */
function sessionStorageSafe(): StorageLike | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

/** Ordered list of recently played track ids (oldest -> newest), cap 50. */
export function useSessionTrail(): string[] {
    const { currentTrack } = useAudioState();
    const [trail, setTrail] = useState<TrailEntry[]>(() =>
        readStoredTrail(sessionStorageSafe())
    );
    const lastId = useRef<string | null>(
        trail.length ? trail[trail.length - 1].trackId : null
    );

    const currentId = currentTrack?.id ?? null;
    useEffect(() => {
        if (!currentId || currentId === lastId.current) return;
        lastId.current = currentId;
        setTrail((prev) => {
            const next = appendTrailEntry(prev, currentId, Date.now());
            writeStoredTrail(sessionStorageSafe(), next);
            return next;
        });
    }, [currentId]);

    return useMemo(() => trail.map((e) => e.trackId), [trail]);
}
