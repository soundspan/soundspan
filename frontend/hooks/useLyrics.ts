import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface LyricsData {
    syncedLyrics: string | null;
    plainLyrics: string | null;
    source: string;
    synced: boolean;
}

export interface LyricsLookupMetadata {
    artist?: string;
    title?: string;
    album?: string;
    duration?: number;
}

const FALLBACK_LYRICS: LyricsData = {
    syncedLyrics: null,
    plainLyrics: null,
    source: "none",
    synced: false,
};

export const LYRICS_QUERY_STALE_TIME = 1000 * 60 * 60 * 24 * 7; // 7 days
export const LYRICS_QUERY_GC_TIME = 1000 * 60 * 60 * 24 * 30; // 30 days

export const lyricsQueryKeys = {
    lyrics: (trackId: string, metadata?: LyricsLookupMetadata) =>
        [
            "lyrics",
            trackId,
            metadata?.artist || "",
            metadata?.title || "",
            metadata?.album || "",
            typeof metadata?.duration === "number" && metadata.duration > 0
                ? Math.round(metadata.duration)
                : 0,
        ] as const,
};

export async function fetchLyrics(
    trackId: string,
    metadata?: LyricsLookupMetadata
): Promise<LyricsData> {
    try {
        return await new Promise<LyricsData>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Lyrics request timed out"));
            }, 15000);

            api.getLyrics(trackId, metadata)
                .then((data) => {
                    clearTimeout(timeout);
                    resolve(data);
                })
                .catch((error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    } catch (error) {
        console.warn(`[Lyrics] Falling back to empty lyrics for track ${trackId}:`, error);
        return FALLBACK_LYRICS;
    }
}

/**
 * Hook to fetch lyrics for a track.
 * Lyrics are cached aggressively since they rarely change.
 *
 * @param trackId - The track ID to fetch lyrics for
 * @returns Query result with lyrics data
 */
export function useLyrics(
    trackId: string | undefined,
    metadata?: LyricsLookupMetadata
) {
    return useQuery<LyricsData>({
        queryKey: lyricsQueryKeys.lyrics(trackId || "", metadata),
        queryFn: async () => {
            if (!trackId) throw new Error("No track ID");
            return fetchLyrics(trackId, metadata);
        },
        enabled: !!trackId,
        staleTime: LYRICS_QUERY_STALE_TIME,
        gcTime: LYRICS_QUERY_GC_TIME,
        retry: 0,
    });
}
