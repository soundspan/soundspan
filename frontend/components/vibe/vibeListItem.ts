/**
 * vibeListItem — shared list-row shapes for the vibe panels.
 *
 * `VibeResultRow` is the `/vibe` payload item every list endpoint (journey
 * waypoints, alchemy results) returns; `VibeListItem` is that row annotated
 * with map presence + sequence for panel rendering. Kept in their own module
 * so `useJourneyMode` / `useAlchemyMode` / `MapDecorations` can share them
 * without importing each other.
 */

import type { WithOnMap } from "./journeyTracks";

/** A raw `/vibe` list payload row ({id,title,album,artist} + distances). */
export interface VibeResultRow {
    id: string;
    title: string;
    distance: number;
    similarity: number;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

/** A `/vibe` list item ({id,title,album,artist}) tagged with map presence. */
export type VibeListItem = WithOnMap<VibeResultRow> & { seq: number };
