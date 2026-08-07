/**
 * journeyTracks — PURE helpers that turn vibe payloads into playable `Track`s.
 *
 * No React, no DOM. Shared by travel, journey and alchemy for building the
 * queue passed to `playTracks`, and by the map for flagging which items are
 * plotted (on-map) vs listed-only (off-map). Unit-testable in isolation.
 *
 * `import type { Track }` is erased at compile time, so this stays a pure module
 * with no runtime dependency on the audio context.
 */

import type { Track } from "@/lib/audio-state-context";
import type { MapTrack } from "./types";
import type { VibeTrackRef } from "./travelCompass";

/**
 * Map a `/vibe` payload item (journey waypoint, alchemy result, travel
 * neighbour — all share `{id,title,album,artist}`) to a playable `Track`.
 * Duration is unknown in these payloads, so it defaults to 0 (the player
 * resolves the real duration on load), matching VibeMap's dot-play shape.
 */
export function waypointToTrack(wp: VibeTrackRef): Track {
    return {
        id: wp.id,
        title: wp.title,
        artist: { name: wp.artist.name, id: wp.artist.id },
        album: {
            title: wp.album.title ?? "",
            id: wp.album.id,
            coverArt: wp.album.coverUrl ?? undefined,
        },
        duration: 0,
    };
}

/** Map a projected `MapTrack` (artist is a bare string) to a playable `Track`. */
export function mapTrackToTrack(t: MapTrack): Track {
    return {
        id: t.id,
        title: t.title,
        artist: { name: t.artist, id: t.artistId },
        album: {
            title: "", // album title is not in the map payload
            id: t.albumId,
            coverArt: t.coverUrl ?? undefined,
        },
        duration: 0,
    };
}

/**
 * Build the ordered queue for "Play journey": the waypoints in order, with the
 * from-track prepended unless it is already the first waypoint (track-mode
 * journeys end at the destination and never include the origin, so the origin
 * is normally missing and gets prepended).
 */
export function journeyTracks(
    fromTrack: Track | null,
    waypoints: readonly VibeTrackRef[]
): Track[] {
    const mapped = waypoints.map(waypointToTrack);
    if (fromTrack && waypoints[0]?.id !== fromTrack.id) {
        return [fromTrack, ...mapped];
    }
    return mapped;
}

/** A vibe item tagged with whether it is plotted on the current map sample. */
export type WithOnMap<T> = T & { onMap: boolean };

/**
 * Flag each item with `onMap` = present in `mapIndex`. Preserves order and the
 * original 1-based sequence via `seq`, so the panel can label off-map waypoints
 * while the map draws only the on-map ones.
 */
export function annotateOnMap<T extends { id: string }>(
    items: readonly T[],
    mapIndex: ReadonlyMap<string, unknown>
): Array<WithOnMap<T> & { seq: number }> {
    return items.map((item, i) => ({
        ...item,
        onMap: mapIndex.has(item.id),
        seq: i + 1,
    }));
}
