import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * useTidalTopTracks — enriches unowned artist top-tracks with TIDAL
 * streaming data (streamSource + tidalTrackId).
 *
 * Artist-page counterpart of album/useTidalGapFill.
 * Uses the same global status cache so we don't re-check on every
 * page navigation, and a single batch match request for performance.
 */

import { useEffect, useState, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";

// Re-use the global status cache from album gap-fill
import { invalidateTidalStatusCache } from "@/features/album/hooks/useTidalGapFill";
export { invalidateTidalStatusCache };

interface TidalMatch {
    id: number;
    title: string;
    artist: string;
    duration: number;
    isrc?: string;
}

// ── Global TIDAL status cache (shared with useTidalGapFill) ───────
let _tidalStatusCache: { available: boolean; checkedAt: number } | null = null;
const TIDAL_STATUS_CACHE_TTL = 60_000;

async function getTidalAvailable(): Promise<boolean> {
    const now = Date.now();
    if (
        _tidalStatusCache &&
        now - _tidalStatusCache.checkedAt < TIDAL_STATUS_CACHE_TTL
    ) {
        return _tidalStatusCache.available;
    }
    try {
        const status = await api.getTidalStreamingStatus();
        const available =
            status.enabled && status.available && status.authenticated;
        _tidalStatusCache = { available, checkedAt: now };
        return available;
    } catch {
        _tidalStatusCache = { available: false, checkedAt: now };
        return false;
    }
}

// ── Global match cache for artist top tracks ──────────────────────
const _artistMatchCache = new Map<string, Record<string, TidalMatch>>();

export function useTidalTopTracks(artist: Artist | null | undefined) {
    const [matches, setMatches] = useState<Record<string, TidalMatch>>({});
    const [loading, setLoading] = useState(false);
    const matchedArtistIdRef = useRef<string | null>(null);
    const [tidalAvailable, setTidalAvailable] = useState(
        _tidalStatusCache?.available ?? false
    );
    const [isStatusResolved, setIsStatusResolved] = useState(
        _tidalStatusCache !== null
    );

    // Discovery artists only have mbid, not id — use either as a stable key.
    const artistKey = artist?.id || artist?.mbid || null;

    // Check TIDAL availability (uses global cache)
    useEffect(() => {
        let cancelled = false;
        getTidalAvailable().then((available) => {
            if (!cancelled) {
                setTidalAvailable(available);
                setIsStatusResolved(true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Identify unowned tracks that need matching
    const unownedTracks = useMemo(() => {
        if (!tidalAvailable || !artist?.topTracks) return [];

        return artist.topTracks.filter(
            (t) =>
                !t.album?.id ||
                !t.album?.title ||
                t.album.title === "Unknown Album"
        );
    }, [artist?.topTracks, artistKey, tidalAvailable]);

    // Match unowned tracks against TIDAL (single batch call)
    useEffect(() => {
        if (!unownedTracks.length || !artistKey) return;
        if (matchedArtistIdRef.current === artistKey) return;

        // Check global cache first — instant on revisit
        const cached = _artistMatchCache.get(artistKey);
        if (cached) {
            matchedArtistIdRef.current = artistKey;
            setMatches(cached);
            return;
        }

        let cancelled = false;
        matchedArtistIdRef.current = artistKey;
        setLoading(true);

        const matchTracks = async () => {
            const trackPayload = unownedTracks.map((track) => ({
                artist: track.artist?.name || artist?.name || "",
                title: track.title,
                // No album title for top-tracks
                duration:
                    typeof track.duration === "number" && track.duration > 0
                        ? track.duration
                        : undefined,
                isrc: track.isrc || undefined,
            }));

            try {
                const { matches: batchMatches } =
                    await api.matchTidalBatch(trackPayload);

                if (cancelled) return;

                const newMatches: Record<string, TidalMatch> = {};
                batchMatches.forEach((match, idx) => {
                    if (match && unownedTracks[idx]) {
                        newMatches[unownedTracks[idx].id] = match;
                    }
                });

                _artistMatchCache.set(artistKey!, newMatches);
                setMatches(newMatches);
            } catch (err) {
                sharedFrontendLogger.error("[TIDAL TopTracks] Batch match failed:", err);
                if (!cancelled) {
                    _artistMatchCache.set(artistKey!, {});
                    setMatches({});
                }
            }

            if (!cancelled) setLoading(false);
        };

        matchTracks();

        return () => {
            cancelled = true;
        };
    }, [unownedTracks, artistKey, artist?.name]);

    // Produce enriched top-tracks with streamSource + tidalTrackId
    const enrichedTopTracks = useMemo((): Track[] | undefined => {
        if (!artist?.topTracks) return undefined;
        if (Object.keys(matches).length === 0) return artist.topTracks;

        return artist.topTracks.map((track) => {
            const match = matches[track.id];
            if (match) {
                return {
                    ...track,
                    streamSource: "tidal" as const,
                    tidalTrackId: match.id,
                    duration: track.duration || match.duration,
                };
            }
            return track;
        });
    }, [artist?.topTracks, matches]);

    const hasQueuedMatchWork =
        !!artistKey &&
        unownedTracks.length > 0 &&
        !loading &&
        !_artistMatchCache.has(artistKey);

    return {
        enrichedTopTracks,
        isMatching: loading || hasQueuedMatchWork,
        isStatusResolved,
        tidalAvailable,
        matchCount: Object.keys(matches).length,
    };
}
