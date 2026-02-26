import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * useYtMusicTopTracks — enriches unowned artist top-tracks with
 * YouTube Music streaming data (streamSource + youtubeVideoId).
 *
 * This is the artist-page counterpart of album/useYtMusicGapFill.
 * It uses the same global status cache so we don't re-check on every
 * page navigation, and a single batch match request for performance.
 */

import { useEffect, useState, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";

// Re-use the global status cache from album gap-fill
import { invalidateYtMusicStatusCache } from "@/features/album/hooks/useYtMusicGapFill";
export { invalidateYtMusicStatusCache };

interface YtMusicMatch {
    videoId: string;
    title: string;
    duration: number;
}

// ── Global YT Music status cache (shared with useYtMusicGapFill) ──
// Duplicated here to avoid a circular import – both modules write
// to their own variable but the TTL keeps them in sync.
let _ytStatusCache: { available: boolean; checkedAt: number } | null = null;
const YT_STATUS_CACHE_TTL = 60_000;

async function getYtMusicAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_ytStatusCache && now - _ytStatusCache.checkedAt < YT_STATUS_CACHE_TTL) {
        return _ytStatusCache.available;
    }
    try {
        const status = await api.getYtMusicStatus();
        const available =
            status.enabled && status.available && status.authenticated;
        _ytStatusCache = { available, checkedAt: now };
        return available;
    } catch {
        _ytStatusCache = { available: false, checkedAt: now };
        return false;
    }
}

// ── Global match cache for artist top tracks ──────────────────────
const _artistMatchCache = new Map<string, Record<string, YtMusicMatch>>();

export function useYtMusicTopTracks(artist: Artist | null | undefined) {
    const [matches, setMatches] = useState<Record<string, YtMusicMatch>>({});
    const [loading, setLoading] = useState(false);
    const matchedArtistIdRef = useRef<string | null>(null);
    const [ytMusicAvailable, setYtMusicAvailable] = useState(
        _ytStatusCache?.available ?? false
    );
    const [isStatusResolved, setIsStatusResolved] = useState(
        _ytStatusCache !== null
    );

    // Discovery artists only have mbid, not id — use either as a stable key.
    const artistKey = artist?.id || artist?.mbid || null;

    // Check YTMusic availability (uses global cache)
    useEffect(() => {
        let cancelled = false;
        getYtMusicAvailable().then((available) => {
            if (!cancelled) {
                setYtMusicAvailable(available);
                setIsStatusResolved(true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Identify unowned tracks that need matching
    // Skip any tracks already enriched by TIDAL (TIDAL takes priority)
    const unownedTracks = useMemo(() => {
        if (!ytMusicAvailable || !artist?.topTracks) return [];

        return artist.topTracks.filter(
            (t) =>
                t.streamSource !== "tidal" &&
                (!t.album?.id ||
                    !t.album?.title ||
                    t.album.title === "Unknown Album")
        );
    }, [artist?.topTracks, artistKey, ytMusicAvailable]);

    // Match unowned tracks against YTMusic (single batch call)
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
                const { matches: batchMatches } = await api.matchYtMusicBatch(trackPayload);

                if (cancelled) return;

                const newMatches: Record<string, YtMusicMatch> = {};
                batchMatches.forEach((match, idx) => {
                    if (match && unownedTracks[idx]) {
                        newMatches[unownedTracks[idx].id] = match;
                    }
                });

                _artistMatchCache.set(artistKey!, newMatches);
                setMatches(newMatches);
            } catch (err) {
                sharedFrontendLogger.error("[YTMusic TopTracks] Batch match failed:", err);
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

    // Produce enriched top-tracks with streamSource + youtubeVideoId
    // Preserve any existing TIDAL enrichment — don't overwrite
    const enrichedTopTracks = useMemo((): Track[] | undefined => {
        if (!artist?.topTracks) return undefined;
        if (Object.keys(matches).length === 0) return artist.topTracks;

        return artist.topTracks.map((track) => {
            // Don't overwrite TIDAL-enriched tracks
            if (track.streamSource === "tidal") return track;
            const match = matches[track.id];
            if (match) {
                return {
                    ...track,
                    streamSource: "youtube" as const,
                    youtubeVideoId: match.videoId,
                    // Use YT Music duration if the track doesn't have one
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
        ytMusicAvailable,
        matchCount: Object.keys(matches).length,
    };
}
