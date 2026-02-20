import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
    LYRICS_QUERY_GC_TIME,
    resolveLyricsQueryStaleTime,
} from "@/lib/lyrics-cache-policy";

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
    return await new Promise<LyricsData>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Lyrics request timed out"));
        }, 20000);

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
        staleTime: (query) =>
            resolveLyricsQueryStaleTime(query.state.data as LyricsData | undefined),
        gcTime: LYRICS_QUERY_GC_TIME,
        retry: 1,
    });
}
