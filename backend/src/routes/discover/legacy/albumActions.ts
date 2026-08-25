import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { lidarrService } from "../../../services/lidarr";
import {
    DISCOVERY_LIKED_OWNERSHIP_SOURCE,
    promoteAlbumOwnership,
} from "../../../services/albumOwnershipPromotion";
import {
    DiscoveryCatalogResolutionError,
    resolveDiscoveryCatalogAlbum,
    retryDiscoveryLinkDrift,
} from "../../../services/discoveryCatalogAlbum";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../../utils/routeErrorResponse";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

type LegacyDiscoveryAlbum = NonNullable<
    Awaited<ReturnType<typeof prisma.discoveryAlbum.findFirst>>
> & { catalogAlbumId?: string | null };

class DiscoveryCatalogAlbumMissingError extends Error {}

async function updateDiscoveryPlays(
    transaction: Prisma.TransactionClient,
    discoveryAlbumId: string,
    userId: string,
    from: "DISCOVERY" | "DISCOVERY_KEPT",
    to: "DISCOVERY" | "DISCOVERY_KEPT",
): Promise<void> {
    const tracks = await transaction.discoveryTrack.findMany({
        where: { discoveryAlbumId },
        select: { trackId: true },
    });
    const trackIds = tracks.flatMap((track) =>
        track.trackId === null ? [] : [track.trackId],
    );
    if (trackIds.length === 0) return;
    await transaction.play.updateMany({
        where: { userId, trackId: { in: trackIds }, source: from },
        data: { source: to },
    });
}

async function commitLegacyLike(userId: string, albumId: string) {
    try {
        return await retryDiscoveryLinkDrift(() =>
            prisma.$transaction(async (transaction) => {
                const discoveryAlbum =
                    await transaction.discoveryAlbum.findFirst({
                        where: { userId, rgMbid: albumId, status: "ACTIVE" },
                    });
                if (!discoveryAlbum) return null;
                const resolution = await resolveDiscoveryCatalogAlbum(
                    transaction,
                    discoveryAlbum,
                    { expectedStatuses: ["ACTIVE"] },
                );
                const dbAlbum = resolution?.catalogAlbum;
                if (!dbAlbum) {
                    throw new DiscoveryCatalogAlbumMissingError();
                }
                const liked = await transaction.discoveryAlbum.updateMany({
                    where: { id: discoveryAlbum.id, status: "ACTIVE" },
                    data: {
                        status: "LIKED",
                        likedAt: new Date(),
                    },
                });
                if (liked.count !== 1) {
                    throw new DiscoveryCatalogResolutionError(
                        "Discovery like claim failed after row locking",
                    );
                }
                await promoteAlbumOwnership(
                    transaction,
                    dbAlbum,
                    DISCOVERY_LIKED_OWNERSHIP_SOURCE,
                );
                await updateDiscoveryPlays(
                    transaction,
                    discoveryAlbum.id,
                    userId,
                    "DISCOVERY",
                    "DISCOVERY_KEPT",
                );
                return { discoveryAlbum, dbAlbum };
            }),
        );
    } catch (error: unknown) {
        if (
            error instanceof DiscoveryCatalogAlbumMissingError ||
            error instanceof DiscoveryCatalogResolutionError
        ) {
            return null;
        }
        throw error;
    }
}

async function removeLegacyDiscoveryTag(
    discoveryAlbum: LegacyDiscoveryAlbum,
): Promise<void> {
    try {
        if (
            discoveryAlbum.artistMbid &&
            !discoveryAlbum.artistMbid.startsWith("temp-")
        ) {
            await lidarrService.removeDiscoveryTagByMbid(
                discoveryAlbum.artistMbid,
            );
            return;
        }
        const artists = await lidarrService.getArtists();
        const artist = artists.find(
            (candidate) =>
                candidate.artistName.toLowerCase() ===
                discoveryAlbum.artistName.toLowerCase(),
        );
        if (!artist) return;
        const tagId = await lidarrService.getOrCreateDiscoveryTag();
        if (tagId && artist.tags?.includes(tagId)) {
            await lidarrService.removeTagsFromArtist(artist.id, [tagId]);
        }
    } catch (error: unknown) {
        logger.debug(
            `Failed to remove discovery tag for ${discoveryAlbum.artistName}: ${toErrorMessage(error)}`,
        );
    }
}

async function commitLegacyUnlike(
    userId: string,
    albumId: string,
): Promise<boolean> {
    try {
        return await retryDiscoveryLinkDrift(() =>
            prisma.$transaction(async (transaction) => {
                const discoveryAlbum =
                    await transaction.discoveryAlbum.findFirst({
                        where: { userId, rgMbid: albumId, status: "LIKED" },
                    });
                if (!discoveryAlbum) return false;
                const resolution = await resolveDiscoveryCatalogAlbum(
                    transaction,
                    discoveryAlbum,
                    { expectedStatuses: ["LIKED"] },
                );
                if (!resolution) return false;
                const unliked = await transaction.discoveryAlbum.updateMany({
                    where: { id: discoveryAlbum.id, status: "LIKED" },
                    data: { status: "ACTIVE", likedAt: null },
                });
                if (unliked.count !== 1) {
                    throw new DiscoveryCatalogResolutionError(
                        "Discovery unlike claim failed after row locking",
                    );
                }
                const dbAlbum = resolution.catalogAlbum;
                if (dbAlbum) {
                    await transaction.ownedAlbum.deleteMany({
                        where: {
                            artistId: dbAlbum.artistId,
                            rgMbid: dbAlbum.rgMbid,
                            source: DISCOVERY_LIKED_OWNERSHIP_SOURCE,
                        },
                    });
                }
                await updateDiscoveryPlays(
                    transaction,
                    discoveryAlbum.id,
                    userId,
                    "DISCOVERY_KEPT",
                    "DISCOVERY",
                );
                return true;
            }),
        );
    } catch (error: unknown) {
        if (error instanceof DiscoveryCatalogResolutionError) return false;
        throw error;
    }
}

/** Handles frozen legacy discovery album likes. */
export async function handleLegacyLike(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return sendRouteError(res, 400, "albumId required");
        }

        const committed = await commitLegacyLike(userId, albumId);
        if (!committed) {
            return res
                .status(404)
                .json({ error: "Album not in active discovery" });
        }
        const { discoveryAlbum, dbAlbum } = committed;
        logger.debug(
            `   Removing discovery tag from artist: ${discoveryAlbum.artistName}`,
        );
        await removeLegacyDiscoveryTag(discoveryAlbum);
        if (dbAlbum) {
            logger.debug(
                ` Added liked album to library: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`,
            );
        } else {
            logger.debug(
                `   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`,
            );
        }

        res.json({ success: true });
    } catch (error) {
        logger.error("Like discovery album error:", error);
        sendInternalRouteError(res, "Failed to like album");
    }
}

/** Handles frozen legacy discovery album unlikes. */
export async function handleLegacyUnlike(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return sendRouteError(res, 400, "albumId required");
        }

        if (!(await commitLegacyUnlike(userId, albumId))) {
            return sendRouteError(res, 404, "Album not liked");
        }
        res.json({ success: true });
    } catch (error) {
        logger.error("Unlike discovery album error:", error);
        sendInternalRouteError(res, "Failed to unlike album");
    }
}
import { toErrorMessage } from "../../../utils/errors";
