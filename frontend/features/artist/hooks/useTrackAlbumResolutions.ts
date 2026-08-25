import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TrackAlbumResolution } from "@/lib/api/metadata";
import type { Track } from "../types";

/**
 * Module-level cache so repeat visits (and expand/collapse cycles) never
 * re-resolve the same artist/title pair. `null` records a resolution miss.
 */
const resolutionCache = new Map<string, TrackAlbumResolution | null>();

function cacheKey(artistName: string, title: string): string {
    return `${artistName.toLowerCase()}::${title.toLowerCase()}`;
}

function albumHint(track: Track): string | undefined {
    const title = track.album?.title;
    if (!title || title === "Unknown Album") return undefined;
    return title;
}

async function resolveTrack(
    artistName: string,
    track: Track,
): Promise<TrackAlbumResolution | null> {
    const key = cacheKey(artistName, track.title);
    const cached = resolutionCache.get(key);
    if (cached !== undefined) return cached;

    let resolution: TrackAlbumResolution | null = null;
    try {
        resolution = await api.getTrackAlbum(
            artistName,
            track.title,
            albumHint(track),
        );
    } catch {
        // Misses and transport failures both render as "no album link";
        // the server distinguishes and caches them on its side.
        resolution = null;
    }
    resolutionCache.set(key, resolution);
    return resolution;
}

/**
 * Resolve canonical album identity (rgMbid + title) for tracks that carry no
 * local album id, via the cached `/api/metadata/track-album` ladder. Returns
 * a map keyed by track id containing only successful resolutions.
 */
export function useTrackAlbumResolutions(
    tracks: Track[],
    artistName: string,
): Map<string, TrackAlbumResolution> {
    const [resolutions, setResolutions] = useState<
        Map<string, TrackAlbumResolution>
    >(() => new Map());

    useEffect(() => {
        const targets = tracks.filter((track) => !track.album?.id);
        if (targets.length === 0 || !artistName) return;

        let cancelled = false;
        const run = async () => {
            for (const track of targets) {
                const resolution = await resolveTrack(artistName, track);
                if (cancelled) return;
                if (!resolution) continue;
                setResolutions((prev) => {
                    if (prev.get(track.id) === resolution) return prev;
                    const next = new Map(prev);
                    next.set(track.id, resolution);
                    return next;
                });
            }
        };
        void run();

        return () => {
            cancelled = true;
        };
    }, [tracks, artistName]);

    return resolutions;
}
