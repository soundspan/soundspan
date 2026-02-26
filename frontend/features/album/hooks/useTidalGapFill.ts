import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * useTidalGapFill — enriches unowned album tracks with TIDAL
 * streaming data (streamSource + tidalTrackId).
 *
 * Mirrors useYtMusicGapFill from the YouTube Music integration.
 * When a user has connected their TIDAL account, this hook batch-
 * matches unowned tracks against TIDAL so they can be streamed
 * inline instead of just previewed.
 *
 * TIDAL always overrides YouTube when both are available.
 */

import { useEffect, useState, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import type { Track, Album, AlbumSource } from "../types";
import {
    createProviderStatusCacheEntry,
    isProviderStatusCacheFresh,
} from "./providerStatusCache";

interface TidalMatch {
    id: number;
    title: string;
    artist: string;
    duration: number;
    isrc?: string;
}

// ── Global TIDAL status cache (60s TTL) ───────────────────────────
let _tidalStatusCache: { available: boolean; checkedAt: number } | null = null;
let _tidalStatusInFlight: Promise<boolean> | null = null;

async function getTidalAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_tidalStatusCache && isProviderStatusCacheFresh(_tidalStatusCache, now)) {
        return _tidalStatusCache.available;
    }
    if (_tidalStatusInFlight) {
        return _tidalStatusInFlight;
    }

    const loadStatus = async () => {
        try {
            const status = await api.getTidalStreamingStatus();
            const available =
                status.enabled && status.available && status.authenticated;
            _tidalStatusCache = createProviderStatusCacheEntry(available);
            return available;
        } catch {
            _tidalStatusCache = createProviderStatusCacheEntry(false);
            return false;
        } finally {
            _tidalStatusInFlight = null;
        }
    };

    _tidalStatusInFlight = loadStatus();
    try {
        return await _tidalStatusInFlight;
    } catch {
        return false;
    }
}

/**
 * Force-invalidate the global status cache.
 * Call after the user connects/disconnects their TIDAL account.
 */
export function invalidateTidalStatusCache() {
    _tidalStatusCache = null;
    _tidalStatusInFlight = null;
}

// ── Global match cache (keyed by albumId) ─────────────────────────
const _albumMatchCache = new Map<string, Record<string, TidalMatch>>();

export function useTidalGapFill(
    album: Album | null | undefined,
    source?: AlbumSource
) {
    const [matches, setMatches] = useState<Record<string, TidalMatch>>({});
    const [loading, setLoading] = useState(false);
    const matchedAlbumIdRef = useRef<string | null>(null);
    const [tidalAvailable, setTidalAvailable] = useState(
        _tidalStatusCache?.available ?? false
    );
    const [isStatusResolved, setIsStatusResolved] = useState(
        _tidalStatusCache !== null
    );

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
        if (!tidalAvailable || !album?.tracks) return [];

        // For discovery albums, ALL tracks need matching
        if (source === "discovery") return album.tracks;

        // For library albums, only tracks without a local file need matching
        return album.tracks.filter(
            (t) => !t.filePath
        );
    }, [album?.tracks, album?.id, source, tidalAvailable]);

    // Match unowned tracks against TIDAL (single batch call)
    useEffect(() => {
        if (!unownedTracks.length || !album?.id) return;
        if (matchedAlbumIdRef.current === album.id) return;

        // Check global cache first — instant on revisit
        const cached = _albumMatchCache.get(album.id);
        if (cached) {
            matchedAlbumIdRef.current = album.id;
            setMatches(cached);
            return;
        }

        let cancelled = false;
        matchedAlbumIdRef.current = album.id;
        setLoading(true);

        const matchTracks = async () => {
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
                const { matches: batchMatches } =
                    await api.matchTidalBatch(trackPayload);

                if (cancelled) return;

                const newMatches: Record<string, TidalMatch> = {};
                batchMatches.forEach((match, idx) => {
                    if (match && unownedTracks[idx]) {
                        newMatches[unownedTracks[idx].id] = match;
                    }
                });

                _albumMatchCache.set(album.id, newMatches);
                setMatches(newMatches);
            } catch (err) {
                sharedFrontendLogger.error("[TIDAL GapFill] Batch match failed:", err);
                if (!cancelled) {
                    _albumMatchCache.set(album.id, {});
                    setMatches({});
                }
            }

            if (!cancelled) setLoading(false);
        };

        matchTracks();

        return () => {
            cancelled = true;
        };
    }, [unownedTracks, album?.id, album?.title, album?.artist?.name]);

    // Produce enriched tracks with streamSource + tidalTrackId
    const enrichedTracks = useMemo((): Track[] | undefined => {
        if (!album?.tracks) return undefined;
        if (Object.keys(matches).length === 0) return album.tracks;

        return album.tracks.map((track) => {
            const match = matches[track.id];
            if (match) {
                return {
                    ...track,
                    streamSource: "tidal" as const,
                    tidalTrackId: match.id,
                    // Use TIDAL duration if the track doesn't have one
                    duration: track.duration || match.duration,
                };
            }
            return track;
        });
    }, [album?.tracks, matches]);

    const hasQueuedMatchWork =
        !!album?.id &&
        unownedTracks.length > 0 &&
        !loading &&
        !_albumMatchCache.has(album.id);

    return {
        enrichedTracks,
        isMatching: loading || hasQueuedMatchWork,
        isStatusResolved,
        tidalAvailable,
        matchCount: Object.keys(matches).length,
    };
}
