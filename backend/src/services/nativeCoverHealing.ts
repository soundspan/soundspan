import path from "path";
import fs from "fs";
import { config } from "../config";
import { safeResolvePath } from "../utils/safeResolvePath";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { buildFederatedCoverProxyPath } from "../utils/federationCover";
import { normalizeExternalImageUrl } from "./imageProxy";
import { downloadAndStoreImage } from "./imageStorage";
import { resolveAlbumCover } from "./metadata/albumCoverResolver";

const ALBUM_COVER_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const EMBEDDED_COVER_FAILURE_TTL_MS = 10 * 60 * 1000;
const EMBEDDED_COVER_FAILURE_CACHE_MAX = 1_000;
const embeddedCoverFailures = new Map<string, number>();

export const nativeCoverHealInFlight = new Map<
    string,
    Promise<string | null>
>();

export const getAlbumIdFromNativeCoverPath = (
    nativePath: string,
): string | null => {
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
    nativePath: string,
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

export const buildNativeCoverProxyRedirectPath = (
    nativeCoverUrl: string,
): string => `/api/library/cover-art?url=${encodeURIComponent(nativeCoverUrl)}`;

export const persistHealedAlbumCover = async (
    albumId: string,
    coverUrl: string,
): Promise<void> => {
    await prisma.album.update({
        where: { id: albumId },
        data: { coverUrl },
    });

    try {
        await redisClient.setEx(
            `album-cover:${albumId}`,
            ALBUM_COVER_CACHE_TTL_SECONDS,
            coverUrl,
        );
    } catch (cacheError) {
        logger.warn(
            `[COVER-ART] Failed to refresh album cover cache for ${albumId}:`,
            cacheError,
        );
    }
};

async function storeHealedAlbumCover(
    albumId: string,
    coverUrl: string,
): Promise<string | null> {
    const localCoverPath = await downloadAndStoreImage(
        coverUrl,
        albumId,
        "album",
    );
    if (!localCoverPath) return null;
    await persistHealedAlbumCover(albumId, localCoverPath);
    return buildNativeCoverProxyRedirectPath(localCoverPath);
}

async function extractEmbeddedAlbumCover(
    albumId: string,
): Promise<string | null> {
    const now = Date.now();
    const failedUntil = embeddedCoverFailures.get(albumId) ?? 0;
    if (failedUntil > now) return null;
    embeddedCoverFailures.delete(albumId);
    const track = await prisma.track.findFirst({
        where: { albumId, filePath: { not: null }, removedAt: null },
        select: { filePath: true },
        orderBy: { id: "asc" },
    });
    if (!track?.filePath) return null;
    const audioPath = safeResolvePath(config.music.musicPath, track.filePath);
    if (!audioPath) return null;
    const { CoverArtExtractor } = await import("./coverArtExtractor");
    const extractor = new CoverArtExtractor(coversBaseDir());
    const coverPath = await extractor.extractCoverArt(audioPath, albumId);
    if (!coverPath) {
        if (embeddedCoverFailures.size >= EMBEDDED_COVER_FAILURE_CACHE_MAX) {
            const oldest = embeddedCoverFailures.keys().next().value;
            if (oldest) embeddedCoverFailures.delete(oldest);
        }
        embeddedCoverFailures.set(albumId, now + EMBEDDED_COVER_FAILURE_TTL_MS);
        logger.debug("Embedded cover fallback unavailable for album", {
            albumId,
        });
        return null;
    }
    const nativeCoverUrl = `native:${coverPath}`;
    await persistHealedAlbumCover(albumId, nativeCoverUrl);
    return buildNativeCoverProxyRedirectPath(nativeCoverUrl);
}

export const tryHealMissingNativeAlbumCover = async (
    nativePath: string,
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
                location: true,
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
            const existingNativePath = existingNativeCover.replace(
                "native:",
                "",
            );
            const nativeCacheHit =
                resolveNativeCoverCacheHit(existingNativePath);
            if (nativeCacheHit) {
                const canonicalNativeCoverUrl = `native:${nativeCacheHit.resolvedNativePath}`;
                if (canonicalNativeCoverUrl !== existingNativeCover) {
                    await persistHealedAlbumCover(
                        album.id,
                        canonicalNativeCoverUrl,
                    );
                }
                return buildNativeCoverProxyRedirectPath(
                    canonicalNativeCoverUrl,
                );
            }
        }

        if (album.location === "FEDERATED") {
            const persistedExternalCover =
                album.coverUrl?.startsWith("http://") ||
                album.coverUrl?.startsWith("https://")
                    ? normalizeExternalImageUrl(album.coverUrl)
                    : null;
            if (persistedExternalCover) {
                return persistedExternalCover;
            }

            if (existingNativeCover?.startsWith("native:")) {
                await prisma.album.updateMany({
                    where: {
                        id: album.id,
                        coverUrl: existingNativeCover,
                    },
                    data: { coverUrl: null },
                });
            }
            return buildFederatedCoverProxyPath(album.id);
        }

        const candidateUrls = new Set<string>();
        const addCandidateUrl = (candidate: string | null | undefined) => {
            if (!candidate) return;
            const normalized = normalizeExternalImageUrl(candidate);
            if (normalized) {
                candidateUrls.add(normalized);
            }
        };

        let persistedExternalCover: string | null = null;
        if (
            typeof album.coverUrl === "string" &&
            (album.coverUrl.startsWith("http://") ||
                album.coverUrl.startsWith("https://"))
        ) {
            persistedExternalCover = normalizeExternalImageUrl(album.coverUrl);
            if (persistedExternalCover) {
                const storedCover = await storeHealedAlbumCover(
                    album.id,
                    persistedExternalCover,
                );
                if (storedCover) return storedCover;
                candidateUrls.add(persistedExternalCover);
            }
        }

        try {
            const resolution = await resolveAlbumCover({
                artistName: album.artist.name,
                albumTitle: album.title,
                rgMbid: album.rgMbid,
            });
            addCandidateUrl(resolution?.url);
        } catch (error) {
            logger.warn(
                `[COVER-ART] Album-cover recovery failed for ${album.artist.name} - ${album.title}:`,
                error,
            );
        }

        const orderedCandidateUrls = Array.from(candidateUrls);
        for (const candidateUrl of orderedCandidateUrls) {
            if (candidateUrl === persistedExternalCover) continue;
            const storedCover = await storeHealedAlbumCover(
                album.id,
                candidateUrl,
            );
            if (storedCover) return storedCover;
        }

        const fallbackExternalUrl = orderedCandidateUrls[0];
        if (fallbackExternalUrl) {
            await persistHealedAlbumCover(album.id, fallbackExternalUrl);
            return fallbackExternalUrl;
        }

        return extractEmbeddedAlbumCover(album.id);
    })().finally(() => {
        nativeCoverHealInFlight.delete(albumId);
    });

    nativeCoverHealInFlight.set(albumId, healPromise);
    return healPromise;
};
