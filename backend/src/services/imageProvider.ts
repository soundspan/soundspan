/**
 * Image Provider Service
 *
 * Preserves the legacy image-provider API while delegating artist images and
 * album covers to the canonical metadata facade.
 */

import { resolveAlbumCover } from "./metadata/albumCoverResolver";
import { resolveArtistImage } from "./metadata/artistImageResolver";

/** Legacy image search controls retained for caller compatibility. */
export interface ImageSearchOptions {
    preferredSize?: "small" | "medium" | "large" | "extralarge" | "mega";
    timeout?: number;
}

/** Image URL and provider provenance returned to legacy callers. */
export interface ImageResult {
    url: string;
    source:
        | "wikidata"
        | "coverartarchive"
        | "deezer"
        | "fanart"
        | "musicbrainz"
        | "lastfm"
        | "spotify";
    size?: string;
}

/**
 * Represents the ImageProviderService class.
 */
export class ImageProviderService {
    /**
     * Get an artist image through the canonical metadata facade.
     */
    async getArtistImage(
        artistName: string,
        mbid?: string,
        _options: ImageSearchOptions = {},
    ): Promise<ImageResult | null> {
        return resolveArtistImage({ artistName, mbid });
    }

    /** Get an album cover through the canonical metadata facade. */
    async getAlbumCover(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        _options: ImageSearchOptions = {},
    ): Promise<ImageResult | null> {
        return resolveAlbumCover({ artistName, albumTitle, rgMbid });
    }
}

export const imageProviderService = new ImageProviderService();
