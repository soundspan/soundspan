/**
 * Image Provider Service
 *
 * Preserves the legacy image-provider API. Artist images delegate to the
 * metadata facade; album covers retain their existing provider ladder.
 */

import { logger } from "../utils/logger";
import axios from "axios";
import { rateLimiter } from "./rateLimiter";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
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
    private readonly FANART_API_KEY = config.fanart.apiKey;
    private readonly FANART_API_URL = "https://webservice.fanart.tv/v3";
    private fanartSettingsWarningShown = false;

    private async resolveFanartApiKey(): Promise<string | undefined> {
        if (!config.secretsDbOnly) {
            return this.FANART_API_KEY;
        }

        try {
            const settings = await getSystemSettings();
            if (settings?.fanartEnabled && settings?.fanartApiKey) {
                return settings.fanartApiKey;
            }
            this.warnFanartKeyUnavailable("key unavailable in system settings");
        } catch {
            this.warnFanartKeyUnavailable("system settings unreadable");
        }
        return undefined;
    }

    private warnFanartKeyUnavailable(reason: string): void {
        if (this.fanartSettingsWarningShown) {
            return;
        }
        logger.warn(`SECRETS_DB_ONLY: Fanart.tv ${reason} (no .env fallback)`);
        this.fanartSettingsWarningShown = true;
    }

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

    /**
     * Get album cover from multiple sources with fallback chain
     */
    async getAlbumCover(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        options: ImageSearchOptions = {},
    ): Promise<ImageResult | null> {
        const { timeout = 5000 } = options;

        logger.debug(
            `[IMAGE] Searching for album cover: ${artistName} - ${albumTitle}`,
        );

        // Try Deezer first (most reliable)
        try {
            const deezerCover = await this.getAlbumCoverFromDeezer(
                artistName,
                albumTitle,
                timeout,
            );
            if (deezerCover) {
                logger.debug(`  Found cover from Deezer`);
                return deezerCover;
            }
        } catch (error) {
            logger.debug(
                `    Deezer failed: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`,
            );
        }

        // Try MusicBrainz Cover Art Archive if we have MBID
        if (rgMbid) {
            try {
                const mbCover = await this.getAlbumCoverFromMusicBrainz(
                    rgMbid,
                    timeout,
                );
                if (mbCover) {
                    logger.debug(`  Found cover from MusicBrainz`);
                    return mbCover;
                }
            } catch (error) {
                logger.debug(
                    `MusicBrainz failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`,
                );
            }
        }

        // Try Fanart.tv if we have API key and MBID
        if ((await this.resolveFanartApiKey()) && rgMbid) {
            try {
                const fanartCover = await this.getAlbumCoverFromFanart(
                    rgMbid,
                    timeout,
                );
                if (fanartCover) {
                    logger.debug(`  Found cover from Fanart.tv`);
                    return fanartCover;
                }
            } catch (error) {
                logger.debug(
                    `Fanart.tv failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`,
                );
            }
        }

        logger.debug(` No album cover found from any source`);
        return null;
    }

    /**
     * Search Deezer for album cover
     */
    private async getAlbumCoverFromDeezer(
        artistName: string,
        albumTitle: string,
        _timeout: number,
    ): Promise<ImageResult | null> {
        // Delegate to deezerService which has better matching logic:
        // title variant generation, multi-query search with scoring, and 24h Redis caching.
        // Dynamic import to avoid circular dependency (imageProvider ← coverArt ← deezer).
        const { deezerService } = await import("./deezer");
        const coverUrl = await deezerService.getAlbumCover(
            artistName,
            albumTitle,
        );
        if (coverUrl) {
            return { url: coverUrl, source: "deezer", size: "xl" };
        }
        return null;
    }

    /**
     * Get album cover from Fanart.tv
     */
    private async getAlbumCoverFromFanart(
        rgMbid: string,
        timeout: number,
    ): Promise<ImageResult | null> {
        const fanartApiKey = await this.resolveFanartApiKey();
        if (!fanartApiKey) {
            return null;
        }

        const response = await rateLimiter.execute("fanart", () =>
            axios.get(`${this.FANART_API_URL}/music/albums/${rgMbid}`, {
                params: { api_key: fanartApiKey },
                timeout,
            }),
        );

        // Prefer albumcover, fall back to cdart
        const covers =
            response.data.albums?.[rgMbid]?.albumcover ||
            response.data.albums?.[rgMbid]?.cdart;

        if (covers && covers.length > 0) {
            return {
                url: covers[0].url,
                source: "fanart",
            };
        }

        return null;
    }

    /**
     * Get album cover from MusicBrainz Cover Art Archive
     */
    private async getAlbumCoverFromMusicBrainz(
        rgMbid: string,
        timeout: number,
    ): Promise<ImageResult | null> {
        try {
            const response = await rateLimiter.execute("coverart", () =>
                axios.get(
                    `https://coverartarchive.org/release-group/${rgMbid}`,
                    {
                        timeout,
                        validateStatus: (status) => status === 200,
                    },
                ),
            );

            if (response.data.images && response.data.images.length > 0) {
                // Find front cover
                const frontCover =
                    response.data.images.find(
                        (img: any) => img.front === true,
                    ) || response.data.images[0];

                return {
                    url: frontCover.image,
                    source: "musicbrainz",
                };
            }
        } catch (error) {
            // 404 is expected if no cover art exists
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return null;
            }
            throw error;
        }

        return null;
    }
}

export const imageProviderService = new ImageProviderService();
