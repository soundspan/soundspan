export interface ResolvedDownloadJobMetadata {
    metadata: any;
    artistName: string | undefined;
    albumTitle: string | undefined;
    artistMbid: string | undefined;
    normalizedArtistName: string;
    normalizedAlbumTitle: string;
}

/**
 * Resolve commonly used download-job metadata fields with existing fallback behavior.
 */
export function resolveDownloadJobMetadata(
    metadata: unknown
): ResolvedDownloadJobMetadata {
    const resolvedMetadata = (metadata as any) || {};
    const artistName = resolvedMetadata?.artistName as string | undefined;
    const albumTitle = resolvedMetadata?.albumTitle as string | undefined;
    const artistMbid = resolvedMetadata?.artistMbid as string | undefined;

    return {
        metadata: resolvedMetadata,
        artistName,
        albumTitle,
        artistMbid,
        normalizedArtistName: (artistName || "").toLowerCase().trim(),
        normalizedAlbumTitle: (albumTitle || "").toLowerCase().trim(),
    };
}
