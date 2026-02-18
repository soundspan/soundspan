/**
 * useYtMusicGapFill — enriches unowned album tracks with YouTube Music
 * streaming data (streamSource + youtubeVideoId).
 *
 * When the user has YouTube Music connected, this hook matches unowned
 * tracks against YTMusic and marks them as streamable so the player
 * can stream them via the backend proxy instead of showing a 30s preview.
 *
 * Performance: uses a single batch match request instead of N individual
 * calls, and caches matches globally so revisiting an album is instant.
 */

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { api } from "@/lib/api";
import type { Album, Track } from "../types";
import type { AlbumSource } from "../types";

interface YtMusicMatch {
    videoId: string;
    title: string;
    duration: number;
}

// ── Global YT Music status cache ──────────────────────────────────
// Shared across all hook instances so we don't re-fetch on every
// album/artist page navigation. Expires after 60 seconds.
let _ytStatusCache: { available: boolean; checkedAt: number } | null = null;
const YT_STATUS_CACHE_TTL = 60_000; // 60 seconds

async function getYtMusicAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_ytStatusCache && now - _ytStatusCache.checkedAt < YT_STATUS_CACHE_TTL) {
        return _ytStatusCache.available;
    }
    try {
        const status = await api.getYtMusicStatus();
        const available = status.enabled && status.available && status.authenticated;
        _ytStatusCache = { available, checkedAt: now };
        return available;
    } catch {
        _ytStatusCache = { available: false, checkedAt: now };
        return false;
    }
}

/** Invalidate the cached status (e.g. after auth changes). */
export function invalidateYtMusicStatusCache() {
    _ytStatusCache = null;
}

// ── Global match cache ────────────────────────────────────────────
// Persists matches across hook instances / page navigations so
// revisiting an album doesn't trigger another round-trip.
// Keyed by albumId → track matches.
const _matchCache = new Map<string, Record<string, YtMusicMatch>>();

export function useYtMusicGapFill(
    album: Album | null | undefined,
    source: AlbumSource | null
) {
    const [matches, setMatches] = useState<Record<string, YtMusicMatch>>({});
    const [loading, setLoading] = useState(false);
    const matchedAlbumIdRef = useRef<string | null>(null);
    const [ytMusicAvailable, setYtMusicAvailable] = useState(
        // Optimistically use cached value to avoid flash
        _ytStatusCache?.available ?? false
    );

    // Check YTMusic status once (uses global cache)
    useEffect(() => {
        let cancelled = false;
        getYtMusicAvailable().then((available) => {
            if (!cancelled) setYtMusicAvailable(available);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Find unowned tracks that need matching
    // Skip any tracks already enriched by TIDAL (TIDAL takes priority)
    const unownedTracks = useMemo(() => {
        if (!album?.tracks || !ytMusicAvailable) return [];

        // For discovery albums, ALL tracks need matching (minus TIDAL-enriched ones)
        if (source === "discovery") {
            return album.tracks.filter((t) => t.streamSource !== "tidal");
        }

        // For library albums, only tracks without a local file need matching
        // (also skip any already enriched by TIDAL — TIDAL takes priority)
        return album.tracks.filter(
            (t) =>
                t.streamSource !== "tidal" &&
                !t.filePath
        );
    }, [album?.tracks, album?.id, source, ytMusicAvailable]);

    // Match unowned tracks against YTMusic (single batch call)
    useEffect(() => {
        if (!unownedTracks.length || !album?.id) return;
        // Don't re-match if we already matched this album
        if (matchedAlbumIdRef.current === album.id) return;

        // Check global cache first — instant on revisit
        const cached = _matchCache.get(album.id);
        if (cached) {
            matchedAlbumIdRef.current = album.id;
            setMatches(cached);
            return;
        }

        let cancelled = false;
        matchedAlbumIdRef.current = album.id;
        setLoading(true);

        const matchTracks = async () => {
            // Build batch request — one entry per unowned track
            const trackPayload = unownedTracks.map((track) => ({
                artist: track.artist?.name || album?.artist?.name || "",
                title: track.title,
                albumTitle: album?.title,
                duration:
                    typeof track.duration === "number" && track.duration > 0
                        ? track.duration
                        : undefined,
                isrc: track.isrc || undefined,
            }));

            try {
                // Single batch call — sidecar runs all searches concurrently
                const { matches: batchMatches } = await api.matchYtMusicBatch(trackPayload);

                if (cancelled) return;

                const newMatches: Record<string, YtMusicMatch> = {};
                batchMatches.forEach((match, idx) => {
                    if (match && unownedTracks[idx]) {
                        newMatches[unownedTracks[idx].id] = match;
                    }
                });

                // Store in global cache for instant revisits
                _matchCache.set(album.id, newMatches);
                setMatches(newMatches);
            } catch (err) {
                console.error("[YTMusic Gap-Fill] Batch match failed:", err);
            }

            if (!cancelled) setLoading(false);
        };

        matchTracks();

        return () => {
            cancelled = true;
        };
    }, [unownedTracks, album?.id, album?.title, album?.artist?.name]);

    // Produce enriched tracks with streamSource + youtubeVideoId
    // Preserve any existing TIDAL enrichment — don't overwrite
    const enrichedTracks = useMemo((): Track[] | undefined => {
        if (!album?.tracks) return undefined;
        if (Object.keys(matches).length === 0) return album.tracks;

        return album.tracks.map((track) => {
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
    }, [album?.tracks, matches]);

    // Reset when album changes
    const reset = useCallback(() => {
        matchedAlbumIdRef.current = null;
        setMatches({});
    }, []);

    return {
        enrichedTracks,
        isMatching: loading,
        ytMusicAvailable,
        matchCount: Object.keys(matches).length,
        reset,
    };
}
