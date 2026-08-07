/**
 * useSessionTrail — sessionStorage-backed ordered list of recently played track
 * ids. Appends when `useAudioState().currentTrack.id` changes while mounted,
 * dedupes consecutive repeats, caps at 50.
 *
 * The pure core (append + storage read/write + the trail-mode/fade-alpha
 * helpers) is exported for unit tests; the hook is the thin React layer. All
 * storage access is SSR/node guarded via `sessionStorageSafe` +
 * `readStoredString`/`writeStoredString` — the shared guard every other
 * vibe-map sessionStorage read/write (layout mode, hint dismissal) also routes
 * through, so there is exactly one try/catch implementation of "sessionStorage
 * might not exist or might throw" in this component tree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// --- Safe storage core ----------------------------------------------------
//
// Shared by every sessionStorage-backed bit of vibe-map state (this trail,
// VibeMap's layout-mode toggle, its hint-dismissal flag, and the trail
// display-mode toggle below) so there is one guarded implementation instead
// of several hand-rolled try/catch blocks scattered across the tree.

/** sessionStorage if available, else null (SSR / node / blocked). */
export function sessionStorageSafe(): StorageLike | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

/** Read a raw string value; null on SSR, a missing key, or a thrown access. */
export function readStoredString(
    storage: StorageLike | null,
    key: string
): string | null {
    if (!storage) return null;
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

/** Write a raw string value; a silent no-op on SSR, quota, or private mode. */
export function writeStoredString(
    storage: StorageLike | null,
    key: string,
    value: string
): void {
    if (!storage) return;
    try {
        storage.setItem(key, value);
    } catch {
        /* quota / private-mode / SSR — best-effort */
    }
}

export function readStoredTrail(storage: StorageLike | null): TrailEntry[] {
    const raw = readStoredString(storage, TRAIL_STORAGE_KEY);
    if (!raw) return [];
    try {
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
    writeStoredString(storage, TRAIL_STORAGE_KEY, JSON.stringify(trail));
}

// --- Trail display mode (on / fade / off) ----------------------------------

/** "on": full trail (existing behaviour). "fade": age-fades and eventually
 *  drops old entries. "off": hidden entirely (beacon + flight plan unaffected). */
export type TrailMode = "on" | "fade" | "off";

export const TRAIL_MODE_STORAGE_KEY = "vibe:trail-mode";
const TRAIL_MODES: readonly TrailMode[] = ["on", "fade", "off"];

/** Reads the persisted trail mode; any missing/unrecognised value -> "on". */
export function readStoredTrailMode(storage: StorageLike | null): TrailMode {
    const raw = readStoredString(storage, TRAIL_MODE_STORAGE_KEY);
    return (TRAIL_MODES as readonly string[]).includes(raw ?? "")
        ? (raw as TrailMode)
        : "on";
}

export function writeStoredTrailMode(
    storage: StorageLike | null,
    mode: TrailMode
): void {
    writeStoredString(storage, TRAIL_MODE_STORAGE_KEY, mode);
}

// --- Age-based fade (trail mode "fade") ------------------------------------

/** Below this age, a "fade" trail entry is drawn at full opacity. */
export const TRAIL_FADE_FULL_MS = 5 * 60 * 1000; // 5 minutes
/** At/beyond this age, a "fade" trail entry is fully transparent (dropped). */
export const TRAIL_FADE_ZERO_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Age (ms) -> opacity multiplier for "fade" mode: 1 while younger than
 * `TRAIL_FADE_FULL_MS`, linearly down to 0 at `TRAIL_FADE_ZERO_MS`, clamped to
 * 0 beyond that (and to 1 for a negative/clock-skewed age).
 */
export function fadeAlphaForAge(ageMs: number): number {
    if (ageMs <= TRAIL_FADE_FULL_MS) return 1;
    if (ageMs >= TRAIL_FADE_ZERO_MS) return 0;
    return (
        1 -
        (ageMs - TRAIL_FADE_FULL_MS) / (TRAIL_FADE_ZERO_MS - TRAIL_FADE_FULL_MS)
    );
}

// --- The hook ---------------------------------------------------------------

export interface UseSessionTrailResult {
    /** Ordered track ids (oldest -> newest), cap 50. */
    trailIds: string[];
    /** Same entries with their `at` epoch-ms append time, for age-based fade. */
    entries: readonly TrailEntry[];
    /**
     * Empty the trail (state + storage). The currently-playing track is
     * re-appended only on its NEXT change — clearing does not immediately
     * re-add whatever is already playing.
     */
    clear: () => void;
}

/** Ordered recently-played track ids (oldest -> newest, cap 50) + clear(). */
export function useSessionTrail(): UseSessionTrailResult {
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

    const clear = useCallback(() => {
        lastId.current = null;
        setTrail([]);
        writeStoredTrail(sessionStorageSafe(), []);
    }, []);

    const trailIds = useMemo(() => trail.map((e) => e.trackId), [trail]);

    return { trailIds, entries: trail, clear };
}
