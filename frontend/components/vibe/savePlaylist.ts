"use client";

/**
 * savePlaylist — turns an ordered list of vibe-map track ids into a saved
 * playlist. Shared by the three "Save as playlist" affordances (journey,
 * sweep, session-history trail): create the playlist, then add tracks
 * sequentially — order matters, it becomes the playlist's track order — and
 * tolerate individual add failures (a single already-deleted/unanalyzed track
 * shouldn't abort the whole save).
 *
 * All HTTP goes through `@/lib/api` (the api.ts boundary rule); this module
 * only orchestrates two existing endpoints, no new ones.
 */

import { api } from "@/lib/api";

export interface SaveTracksAsPlaylistResult {
    id: string;
    added: number;
}

/** Dedupe `ids`, preserving the order of each id's first occurrence. */
export function dedupePreserveOrder(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Create a playlist named `name` and add `trackIds` to it in order (dedupe
 * first — playlist order is the caller's intended listening order). Adds run
 * sequentially, not in parallel, so the resulting playlist order is
 * deterministic; a failed individual add is swallowed and simply not counted
 * in `added`, so one bad track never aborts the rest.
 */
export async function saveTracksAsPlaylist(
    name: string,
    trackIds: readonly string[]
): Promise<SaveTracksAsPlaylistResult> {
    const deduped = dedupePreserveOrder(trackIds);
    const playlist = await api.createPlaylist(name);
    let added = 0;
    for (const trackId of deduped) {
        try {
            await api.addTrackToPlaylist(playlist.id, { trackId });
            added++;
        } catch {
            // Tolerate individual add failures — count successes only.
        }
    }
    return { id: playlist.id, added };
}

const MONTH_LABELS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
] as const;

/**
 * Format a date as "MMM D" (e.g. "Jul 15", no zero-padding) for default
 * playlist names — deliberately not `toLocaleDateString` so the format is
 * locale-independent and unit-testable without an ICU dependency.
 */
export function formatPlaylistDate(date: Date = new Date()): string {
    return `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}`;
}
