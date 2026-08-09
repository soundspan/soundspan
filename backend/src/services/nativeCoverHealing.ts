import path from "path";
import fs from "fs";
import { config } from "../config";
import { safeResolvePath } from "../utils/safeResolvePath";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { coverArtService } from "./coverArt";
import { imageProviderService } from "./imageProvider";
import { deezerService } from "./deezer";
import { normalizeExternalImageUrl } from "./imageProxy";
import { downloadAndStoreImage } from "./imageStorage";

const ALBUM_COVER_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
export const NATIVE_COVER_HEAL_TIMEOUT_MS = 5000;

export const nativeCoverHealInFlight = new Map<string, Promise<string | null>>();

export const getAlbumIdFromNativeCoverPath = (nativePath: string): string | null => {
    const parsed = path.parse(nativePath);
    return parsed.name || null;
};

export const coversBaseDir = (): string =>
    path.resolve(config.music.transcodeCachePath, "../covers");

export const getNativeCoverPathCandidates = (nativePath: string): string[] => {
    const trimmedNativePath = nativePath.replace(/^\/+/, "").trim();
    const candidates = new Set<string>();

    if (trimmedNativePath.length > 0) {
        candidates.add(trimmedNativePath);
        if (!trimmedNativePath.startsWith("albums/")) {
            candidates.add(`albums/${trimmedNativePath}`);
        }
    }

    return Array.from(candidates);
};

export const resolveNativeCoverCacheHit = (
    nativePath: string
): { resolvedNativePath: string; cachePath: string } | null => {
    const coversDir = coversBaseDir();
    const candidates = getNativeCoverPathCandidates(nativePath);
    for (const candidate of candidates) {
        const resolved = safeResolvePath(coversDir, candidate);
        if (resolved && fs.existsSync(resolved)) {
            return {
                resolvedNativePath: candidate,
                cachePath: resolved,
            };
        }
    }
    return null;
};

export const buildNativeCoverProxyRedirectPath = (nativeCoverUrl: string): string =>
    `/api/library/cover-art?url=${encodeURIComponent(nativeCoverUrl)}`;

export const persistHealedAlbumCover = async (
    albumId: string,
    coverUrl: string
): Promise<void> => {
    await prisma.album.update({
        where: { id: albumId },
        data: { coverUrl },
    });

    try {
        await redisClient.setEx(
            `album-cover:${albumId}`,
            ALBUM_COVER_CACHE_TTL_SECONDS,
            coverUrl
        );
    } catch (cacheError) {
        logger.warn(
            `[COVER-ART] Failed to refresh album cover cache for ${albumId}:`,
            cacheError
        );
    }
};

export const tryHealMissingNativeAlbumCover = async (
    nativePath: string
): Promise<string | null> => {
    const albumId = getAlbumIdFromNativeCoverPath(nativePath);
    if (!albumId) return null;

    const inFlight = nativeCoverHealInFlight.get(albumId);
    if (inFlight) {
        return inFlight;
    }

    const healPromise = (async (): Promise<string | null> => {
        const album = await prisma.album.findUnique({
            where: { id: albumId },
            select: {
                id: true,
                title: true,
                rgMbid: true,
                coverUrl: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        if (!album || !album.artist) {
            return null;
        }

        const existingNativeCover = album.coverUrl;
        if (
            typeof existingNativeCover === "string" &&
            existingNativeCover.startsWith("native:")
        ) {
            const existingNativePath = existingNativeCover.replace("native:", "");
            const nativeCacheHit = resolveNativeCoverCacheHit(existingNativePath);
            if (nativeCacheHit) {
                const canonicalNativeCoverUrl =
                    `native:${nativeCacheHit.resolvedNativePath}`;
                if (canonicalNativeCoverUrl !== existingNativeCover) {
                    await persistHealedAlbumCover(album.id, canonicalNativeCoverUrl);
                }
                return buildNativeCoverProxyRedirectPath(
                    canonicalNativeCoverUrl
                );
            }
        }

        const candidateUrls = new Set<string>();
        const addCandidateUrl = (candidate: string | null | undefined) => {
            if (!candidate) return;
            const normalized = normalizeExternalImageUrl(candidate);
            if (normalized) {
                candidateUrls.add(normalized);
            }
        };

        if (
            typeof album.coverUrl === "string" &&
            (album.coverUrl.startsWith("http://") ||
                album.coverUrl.startsWith("https://"))
        ) {
            addCandidateUrl(album.coverUrl);
        }

        const validRgMbid =
            typeof album.rgMbid === "string" &&
            album.rgMbid.length > 0 &&
            !album.rgMbid.startsWith("temp-")
                ? album.rgMbid
                : null;

        if (validRgMbid) {
            try {
                const coverArtArchiveCover =
                    await coverArtService.getCoverArt(validRgMbid);
                addCandidateUrl(coverArtArchiveCover);
            } catch (error) {
                logger.warn(
                    `[COVER-ART] Cover Art Archive recovery failed for ${validRgMbid}:`,
                    error
                );
            }
        }

        try {
            const providerCover = await imageProviderService.getAlbumCover(
                album.artist.name,
                album.title,
                validRgMbid ?? undefined,
                { timeout: NATIVE_COVER_HEAL_TIMEOUT_MS }
            );
            addCandidateUrl(providerCover?.url);
        } catch (error) {
            logger.warn(
                `[COVER-ART] Provider-chain recovery failed for ${album.artist.name} - ${album.title}:`,
                error
            );
        }

        try {
            const deezerCover = await deezerService.getAlbumCover(
                album.artist.name,
                album.title
            );
            addCandidateUrl(deezerCover);
        } catch (error) {
            logger.warn(
                `[COVER-ART] Deezer recovery failed for ${album.artist.name} - ${album.title}:`,
                error
            );
        }

        const orderedCandidateUrls = Array.from(candidateUrls);
        for (const candidateUrl of orderedCandidateUrls) {
            const localCoverPath = await downloadAndStoreImage(
                candidateUrl,
                album.id,
                "album"
            );

            if (!localCoverPath) {
                continue;
            }

            await persistHealedAlbumCover(album.id, localCoverPath);
            return buildNativeCoverProxyRedirectPath(localCoverPath);
        }

        const fallbackExternalUrl = orderedCandidateUrls[0];
        if (fallbackExternalUrl) {
            await persistHealedAlbumCover(album.id, fallbackExternalUrl);
            return fallbackExternalUrl;
        }

        return null;
    })()
        .finally(() => {
            nativeCoverHealInFlight.delete(albumId);
        });

    nativeCoverHealInFlight.set(albumId, healPromise);
    return healPromise;
};
