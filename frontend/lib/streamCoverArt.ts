import { api } from "@/lib/api";

/**
 * Resolves cover art for a track row. TIDAL and YouTube Music artwork is
 * external, so it goes through each provider's image proxy; everything else
 * goes through the library cover-art route.
 */
export function resolveStreamCoverArtUrl(
    coverArt: string | null | undefined,
    streamSource: string | null | undefined,
    size: number,
): string | null {
    if (!coverArt) {
        return null;
    }
    if (streamSource === "tidal") {
        return api.getTidalBrowseImageUrl(coverArt);
    }
    if (streamSource === "youtube") {
        return api.getBrowseImageUrl(coverArt);
    }
    return api.getCoverArtUrl(coverArt, size);
}
