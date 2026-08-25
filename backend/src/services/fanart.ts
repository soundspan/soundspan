import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { getSystemSettings } from "../utils/systemSettings";
import { BRAND_USER_AGENT } from "../config/brand";
import { config } from "../config";

type ArtistImagePreference = "background" | "square";

/** Options for selecting an artist image from Fanart.tv image sets. */
export interface FanartArtistImageOptions {
    preference?: ArtistImagePreference;
}

type FanartArtistImageKind =
    | "artistbackground"
    | "artistthumb"
    | "musicbanner"
    | "hdmusiclogo";

const BACKGROUND_FIRST: readonly FanartArtistImageKind[] = [
    "artistbackground",
    "artistthumb",
    "hdmusiclogo",
];
const SQUARE_FIRST: readonly FanartArtistImageKind[] = [
    "artistthumb",
    "musicbanner",
    "hdmusiclogo",
];

function selectArtistImage(
    data: Record<string, unknown>,
    preference: ArtistImagePreference,
): { kind: FanartArtistImageKind; url: string } | null {
    const order = preference === "square" ? SQUARE_FIRST : BACKGROUND_FIRST;
    for (let index = 0; index < order.length; index += 1) {
        const kind = order[index];
        const images = data[kind];
        if (!Array.isArray(images) || images.length === 0) continue;
        const url = (images[0] as { url?: unknown })?.url;
        if (typeof url === "string" && url.length > 0) return { kind, url };
    }
    return null;
}

function expandArtistImageUrl(
    mbid: string,
    image: { kind: FanartArtistImageKind; url: string },
): string {
    if (image.url.startsWith("http")) return image.url;
    return `https://assets.fanart.tv/fanart/music/${mbid}/${image.kind}/${image.url}`;
}

/**
 * Fanart.tv API Service
 *
 * Provides high-quality artist images, album covers, and backgrounds
 * API Docs: https://fanart.tv/api-docs/music-api/
 *
 * Free tier: 2 requests/second
 * API key: Get one at https://fanart.tv/get-an-api-key/
 */
class FanartService {
    private client: AxiosInstance;
    private apiKey: string | null = null;
    private initialized: boolean = false;
    private noKeyWarningShown: boolean = false;

    constructor() {
        this.client = axios.create({
            baseURL: "https://webservice.fanart.tv/v3",
            timeout: 10000,
            headers: {
                "User-Agent": BRAND_USER_AGENT,
            },
        });
    }

    /**
     * Ensure service is initialized with API key from database or .env
     */
    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            // Try to get from database first
            const settings = await getSystemSettings();
            if (settings?.fanartEnabled && settings?.fanartApiKey) {
                this.apiKey = settings.fanartApiKey;
                logger.debug("Fanart.tv configured from database");
                this.initialized = true;
                return;
            }
        } catch (error) {
            if (config.secretsDbOnly) {
                logger.warn(
                    "SECRETS_DB_ONLY: system settings unreadable; Fanart.tv key unavailable (no .env fallback)",
                );
                this.initialized = true;
                return;
            }
            // Silently continue to check .env
        }

        if (config.secretsDbOnly) {
            if (!this.noKeyWarningShown) {
                logger.warn(
                    "SECRETS_DB_ONLY: Fanart.tv key unavailable in system settings (no .env fallback)",
                );
                this.noKeyWarningShown = true;
            }
            this.initialized = true;
            return;
        }

        // Fallback to .env
        if (config.fanart.apiKey) {
            this.apiKey = config.fanart.apiKey;
            logger.debug("Fanart.tv configured from .env");
        }
        // Note: Not logging "not configured" here - it's optional and logs are spammy
        this.initialized = true;
    }

    /**
     * Get artist images (background, thumbnail, logo)
     * Returns the highest quality artist image available
     */
    async getArtistImage(
        mbid: string,
        options: FanartArtistImageOptions = {},
    ): Promise<string | null> {
        await this.ensureInitialized();

        // Early exit if no API key - don't log every time (reduces log spam)
        if (!this.apiKey) {
            return null;
        }

        // Check cache first
        const preference = options.preference ?? "background";
        const cacheKey =
            preference === "square"
                ? `fanart:artist:square:${mbid}`
                : `fanart:artist:${mbid}`;
        try {
            if (redisClient.isOpen) {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    logger.debug(`  Fanart.tv: Using cached image`);
                    return cached;
                }
            }
        } catch (error) {
            // Redis errors are non-critical
        }

        try {
            logger.debug(`  Fetching from Fanart.tv...`);
            const response = await this.client.get(`/music/${mbid}`, {
                params: { api_key: this.apiKey },
            });

            const selected = selectArtistImage(response.data, preference);
            const imageUrl = selected
                ? expandArtistImageUrl(mbid, selected)
                : null;

            // Cache for 7 days
            if (imageUrl && redisClient.isOpen) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        7 * 24 * 60 * 60,
                        imageUrl,
                    );
                } catch (error) {
                    // Redis errors are non-critical
                }
            }

            return imageUrl;
        } catch (error: any) {
            if (error.response?.status === 404) {
                logger.debug(`Fanart.tv: No images found`);
            } else {
                logger.error(`   Fanart.tv error:`, error.message);
            }
            return null;
        }
    }

    /**
     * Get album cover art
     */
    async getAlbumCover(mbid: string): Promise<string | null> {
        await this.ensureInitialized();

        if (!this.apiKey) return null;

        const cacheKey = `fanart:album:${mbid}`;
        try {
            if (redisClient.isOpen) {
                const cached = await redisClient.get(cacheKey);
                if (cached) return cached;
            }
        } catch (error) {
            // Redis errors are non-critical
        }

        try {
            const response = await this.client.get(`/music/albums/${mbid}`, {
                params: { api_key: this.apiKey },
            });

            const data = response.data;
            let imageUrl: string | null = null;

            if (data.albums && data.albums[mbid]) {
                const album = data.albums[mbid];
                if (album.albumcover && album.albumcover.length > 0) {
                    imageUrl = album.albumcover[0].url;
                } else if (album.cdart && album.cdart.length > 0) {
                    imageUrl = album.cdart[0].url;
                }
            }

            if (imageUrl && redisClient.isOpen) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        7 * 24 * 60 * 60,
                        imageUrl,
                    );
                } catch (error) {
                    // Redis errors are non-critical
                }
            }

            return imageUrl;
        } catch (error) {
            return null;
        }
    }
}

export const fanartService = new FanartService();
