import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
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
import {
    createProviderStatusCacheEntry,
    isProviderStatusCacheFresh,
} from "./providerStatusCache";

interface YtMusicMatch {
    videoId: string;
    title: string;
    duration: number;
}

// ── Global YT Music status cache ──────────────────────────────────
// Shared across all hook instances so we don't re-fetch on every
// album/artist page navigation. Expires after 60 seconds.
let _ytStatusCache: { available: boolean; checkedAt: number } | null = null;
let _ytStatusInFlight: Promise<boolean> | null = null;

async function getYtMusicAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_ytStatusCache && isProviderStatusCacheFresh(_ytStatusCache, now)) {
        return _ytStatusCache.available;
    }
    if (_ytStatusInFlight) {
        return _ytStatusInFlight;
    }

    const loadStatus = async () => {
        try {
            const status = await api.getYtMusicStatus();
            const available = status.enabled && status.available;
            _ytStatusCache = createProviderStatusCacheEntry(available);
            return available;
        } catch {
            _ytStatusCache = createProviderStatusCacheEntry(false);
            return false;
        } finally {
            _ytStatusInFlight = null;
        }
    };

    _ytStatusInFlight = loadStatus();
    try {
        return await _ytStatusInFlight;
    } catch {
        return false;
    }
}

/** Invalidate the cached status (e.g. after auth changes). */
export function invalidateYtMusicStatusCache() {
    _ytStatusCache = null;
    _ytStatusInFlight = null;
}

// ── Global match cache ────────────────────────────────────────────
// Persists matches across hook instances / page navigations so
// revisiting an album doesn't trigger another round-trip.
// Keyed by albumId → track matches.
const _matchCache = new Map<string, Record<string, YtMusicMatch>>();

/**
 * Executes useYtMusicGapFill.
 */
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
    const [isStatusResolved, setIsStatusResolved] = useState(
        _ytStatusCache !== null
    );
    const albumTracks = album?.tracks;

    // Check YTMusic status once (uses global cache)
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

    // Find unowned tracks that need matching
    // Skip any tracks already enriched by TIDAL (TIDAL takes priority)
    const unownedTracks = useMemo(() => {
        if (!albumTracks || !ytMusicAvailable) return [];

        // For discovery albums, ALL tracks need matching (minus TIDAL-enriched ones)
        if (source === "discovery") {
            return albumTracks.filter((t) => t.streamSource !== "tidal");
        }

        // For library albums, only tracks without a local file need matching
        // (also skip any already enriched by TIDAL — TIDAL takes priority)
        return albumTracks.filter(
            (t) =>
                t.streamSource !== "tidal" &&
                !t.filePath
        );
    }, [albumTracks, source, ytMusicAvailable]);

    // Match unowned tracks against YTMusic (single batch call)
    useEffect(() => {
        if (!unownedTracks.length || !album?.id) return;
        // Don't re-match if we already matched this album
        if (matchedAlbumIdRef.current === album.id) return;

        let cancelled = false;
        // Check global cache first — instant on revisit
        const cached = _matchCache.get(album.id);
        if (cached) {
            matchedAlbumIdRef.current = album.id;
            queueMicrotask(() => {
                if (!cancelled) {
                    setMatches(cached);
                }
            });
            return () => {
                cancelled = true;
            };
        }

        matchedAlbumIdRef.current = album.id;
        queueMicrotask(() => {
            if (!cancelled) {
                setLoading(true);
            }
        });

        const matchTracks = async () => {
            const newMatches: Record<string, YtMusicMatch> = {};

            // Step 1: Check persisted mappings (covers all users, survives refresh)
            try {
                const { mappings } = await api.getAlbumMappings(album.id);
                if (cancelled) return;

                for (const mapping of mappings) {
                    if (mapping.trackYtMusic && mapping.trackId) {
                        newMatches[mapping.trackId] = {
                            videoId: mapping.trackYtMusic.videoId,
                            title: mapping.trackYtMusic.title,
                            duration: mapping.trackYtMusic.duration,
                        };
                    }
                }
            } catch {
                // Persisted mappings unavailable — fall through to API call
            }

            if (cancelled) return;

            // Step 2: Find tracks still unmatched after persisted lookup
            const unmatchedTracks = unownedTracks.filter(
                (t) => !newMatches[t.id]
            );

            // Step 3: Call match-batch only for tracks without persisted mappings
            if (unmatchedTracks.length > 0) {
                const trackPayload = unmatchedTracks.map((track) => ({
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
                    const { matches: batchMatches } = await api.matchYtMusicBatch(trackPayload);

                    if (cancelled) return;

                    batchMatches.forEach((match, idx) => {
                        if (match && unmatchedTracks[idx]) {
                            newMatches[unmatchedTracks[idx].id] = match;
                        }
                    });
                } catch (err) {
                    sharedFrontendLogger.error("[YTMusic Gap-Fill] Batch match failed:", err);
                }
            }

            if (!cancelled) {
                // Store in global cache for instant revisits
                _matchCache.set(album.id, newMatches);
                setMatches(newMatches);
                setLoading(false);
            }
        };

        matchTracks();

        return () => {
            cancelled = true;
        };
    }, [unownedTracks, album?.id, album?.title, album?.artist?.name]);

    // Produce enriched tracks with streamSource + youtubeVideoId
    // Preserve any existing TIDAL enrichment — don't overwrite
    const enrichedTracks = useMemo((): Track[] | undefined => {
        if (!albumTracks) return undefined;
        if (Object.keys(matches).length === 0) return albumTracks;

        return albumTracks.map((track) => {
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
    }, [albumTracks, matches]);

    // Reset when album changes
    const reset = useCallback(() => {
        matchedAlbumIdRef.current = null;
        setMatches({});
    }, []);

    const hasQueuedMatchWork =
        !!album?.id &&
        unownedTracks.length > 0 &&
        !loading &&
        !_matchCache.has(album.id);

    return {
        enrichedTracks,
        isMatching: loading || hasQueuedMatchWork,
        isStatusResolved,
        ytMusicAvailable,
        matchCount: Object.keys(matches).length,
        reset,
    };
}
