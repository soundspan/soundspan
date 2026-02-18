import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { imageProviderService } from "./imageProvider";
import { musicBrainzService } from "./musicbrainz";
import { rateLimiter } from "./rateLimiter";

const COVER_ART_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;
const COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const COVER_ART_TIMEOUT_MS = 5000;

interface CoverArtLookupResult {
    coverUrl: string | null;
    notFound: boolean;
}

interface ReleaseGroupLookupContext {
    artistName: string;
    albumTitle: string;
}

class CoverArtService {
    private readonly baseUrl = "https://coverartarchive.org";
    private readonly inFlightRequests = new Map<string, Promise<string | null>>();

    async getCoverArt(rgMbid: string): Promise<string | null> {
        const normalizedMbid = rgMbid.trim();
        if (!normalizedMbid) return null;
        if (normalizedMbid.toLowerCase().startsWith("temp-")) {
            // Temporary IDs are local placeholders, not real MusicBrainz IDs.
            return null;
        }
        const cacheKey = `caa:${normalizedMbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") return null; // Cached negative result
            if (cached) return cached;
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        const inFlight = this.inFlightRequests.get(cacheKey);
        if (inFlight) {
            return inFlight;
        }

        const requestPromise = this.fetchAndCacheCoverArt(normalizedMbid, cacheKey)
            .finally(() => {
                this.inFlightRequests.delete(cacheKey);
            });
        this.inFlightRequests.set(cacheKey, requestPromise);
        return requestPromise;
    }

    private async fetchAndCacheCoverArt(
        rgMbid: string,
        cacheKey: string
    ): Promise<string | null> {
        const coverArtResult = await this.fetchFromCoverArtArchive(rgMbid);
        if (coverArtResult.coverUrl) {
            await this.cacheCoverUrl(cacheKey, coverArtResult.coverUrl);
            return coverArtResult.coverUrl;
        }

        const releaseGroupContext = await this.resolveReleaseGroupContext(rgMbid);
        if (releaseGroupContext) {
            const fallbackCover = await this.fetchFromFallbackProviders(
                releaseGroupContext,
                rgMbid
            );
            if (fallbackCover) {
                await this.cacheCoverUrl(cacheKey, fallbackCover);
                return fallbackCover;
            }
        }

        if (coverArtResult.notFound) {
            await this.cacheNotFound(cacheKey);
        }
        return null;
    }

    private async fetchFromCoverArtArchive(
        rgMbid: string
    ): Promise<CoverArtLookupResult> {
        try {
            // Use rate limiter to prevent overwhelming Cover Art Archive
            const response = await rateLimiter.execute("coverart", () =>
                axios.get(`${this.baseUrl}/release-group/${rgMbid}`, {
                    timeout: COVER_ART_TIMEOUT_MS,
                })
            );

            const images = Array.isArray(response.data?.images)
                ? response.data.images
                : [];
            const frontImage =
                images.find((img: any) => img.front) || images[0];

            if (frontImage) {
                return {
                    coverUrl: frontImage.thumbnails?.large || frontImage.image,
                    notFound: false,
                };
            }

            return { coverUrl: null, notFound: true };
        } catch (error: any) {
            if (error.response?.status === 404) {
                return { coverUrl: null, notFound: true };
            }
            logger.error(`Cover art error for ${rgMbid}:`, error.message);
            return { coverUrl: null, notFound: false };
        }
    }

    private async resolveReleaseGroupContext(
        rgMbid: string
    ): Promise<ReleaseGroupLookupContext | null> {
        try {
            const releaseGroup = await musicBrainzService.getReleaseGroup(rgMbid);
            if (!releaseGroup || typeof releaseGroup.title !== "string") {
                return null;
            }

            const artistCredits = Array.isArray(releaseGroup["artist-credit"])
                ? releaseGroup["artist-credit"]
                : [];
            const artistName = musicBrainzService.extractPrimaryArtist(artistCredits);
            if (!artistName || artistName === "Unknown Artist") {
                return null;
            }

            return {
                artistName,
                albumTitle: releaseGroup.title,
            };
        } catch (err) {
            logger.warn(
                `[CoverArt] Failed to resolve release-group metadata for ${rgMbid}:`,
                err
            );
            return null;
        }
    }

    private async fetchFromFallbackProviders(
        context: ReleaseGroupLookupContext,
        rgMbid: string
    ): Promise<string | null> {
        try {
            const fallback = await imageProviderService.getAlbumCover(
                context.artistName,
                context.albumTitle,
                rgMbid,
                { timeout: COVER_ART_TIMEOUT_MS }
            );
            return fallback?.url ?? null;
        } catch (err) {
            logger.warn(
                `[CoverArt] Fallback providers failed for ${context.artistName} - ${context.albumTitle}:`,
                err
            );
            return null;
        }
    }

    private async cacheCoverUrl(cacheKey: string, coverUrl: string): Promise<void> {
        try {
            await redisClient.setEx(
                cacheKey,
                COVER_ART_CACHE_TTL_SECONDS,
                coverUrl
            );
        } catch (err) {
            logger.warn("Redis set error:", err);
        }
    }

    private async cacheNotFound(cacheKey: string): Promise<void> {
        try {
            await redisClient.setEx(
                cacheKey,
                COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS,
                "NOT_FOUND"
            );
        } catch {
            // Ignore cache failures for negative lookups
        }
    }
}

export const coverArtService = new CoverArtService();
