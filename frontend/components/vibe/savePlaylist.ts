"use client";

/**
 * savePlaylist — turns an ordered list of vibe-map track ids into a saved
 * playlist. Shared by the three "Save as playlist" affordances (journey,
 * sweep, session-history trail): create the playlist, then add tracks
 * sequentially — order matters, it becomes the playlist's track order — and
 * tolerate individual add failures (a single already-deleted/unanalyzed track
 * shouldn't abort the whole save). Failures are OBSERVABLE, not silent: each
 * failed id is logged and returned in `failedTrackIds`, and callers surface
 * partial saves through `describeSaveResult` (a warning, never an
 * unconditional success toast).
 *
 * All HTTP goes through `@/lib/api` (the api.ts boundary rule); this module
 * only orchestrates two existing endpoints, no new ones.
 */

import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";

const logger = createFrontendLogger("Vibe.savePlaylist");

export interface SaveTracksAsPlaylistResult {
    id: string;
    /** Tracks actually added, in playlist order. */
    added: number;
    /** Deduped track ids whose individual add failed, in attempt order. */
    failedTrackIds: string[];
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
 * deterministic; a failed individual add never aborts the rest — it is
 * logged, collected into `failedTrackIds`, and excluded from `added`.
 */
export async function saveTracksAsPlaylist(
    name: string,
    trackIds: readonly string[],
): Promise<SaveTracksAsPlaylistResult> {
    const deduped = dedupePreserveOrder(trackIds);
    const playlist = await api.createPlaylist(name);
    let added = 0;
    const failedTrackIds: string[] = [];
    for (const trackId of deduped) {
        try {
            await api.addTrackToPlaylist(playlist.id, { trackId });
            added++;
        } catch (error) {
            // Tolerate the failure (the rest of the save continues) but never
            // hide it: collect the id for the caller's partial-save warning.
            failedTrackIds.push(trackId);
            logger.warn("Failed to add track to playlist", {
                playlistId: playlist.id,
                playlistName: name,
                trackId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (failedTrackIds.length > 0) {
        logger.warn("Playlist saved partially", {
            playlistId: playlist.id,
            playlistName: name,
            added,
            failed: failedTrackIds.length,
        });
    }
    return { id: playlist.id, added, failedTrackIds };
}

export interface SaveResultMessage {
    /** "success" = every track landed; "warning" = a partial save. */
    tone: "success" | "warning";
    message: string;
}

/**
 * The one honest toast for a save result: a full save reads as success, a
 * partial save reads as a warning naming how many tracks were skipped.
 * Callers map `tone` onto their toast flavor (e.g. sonner's `toast.success`
 * vs `toast.warning`) instead of unconditionally reporting success.
 */
export function describeSaveResult(
    name: string,
    result: SaveTracksAsPlaylistResult,
): SaveResultMessage {
    const failed = result.failedTrackIds.length;
    if (failed === 0) {
        return {
            tone: "success",
            message: `Saved ${result.added} track${result.added === 1 ? "" : "s"} to ${name}`,
        };
    }
    return {
        tone: "warning",
        message: `Saved ${result.added} of ${result.added + failed} tracks to ${name} — ${failed} track${failed === 1 ? "" : "s"} couldn't be added`,
    };
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
