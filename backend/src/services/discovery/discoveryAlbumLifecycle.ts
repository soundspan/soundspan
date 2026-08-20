/**
 * Discovery Album Lifecycle Module
 *
 * Handles lifecycle management for discovery albums:
 * - Moving liked albums to permanent library
 * - Deleting rejected/active albums from DB and Lidarr
 * - Processing albums before new discovery generation
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { updateArtistCounts } from "../artistCountsService";
import {
    DISCOVERY_LIKED_OWNERSHIP_SOURCE,
    promoteAlbumOwnership,
} from "../albumOwnershipPromotion";
import {
    DiscoveryCatalogResolutionError,
    resolveDiscoveryCatalogAlbum,
    retryDiscoveryLinkDrift,
} from "../discoveryCatalogAlbum";
import { deleteDiscoveryAlbumCatalogEntry } from "../discoveryAlbumCatalogCleanup";
import { LidarrHttpClient, LidarrHttpError } from "../lidarr/lidarrHttpClient";

export interface DiscoveryAlbumInfo {
    id: string;
    catalogAlbumId?: string | null;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    lidarrAlbumId?: number | null;
}

export interface LidarrSettings {
    lidarrEnabled?: boolean;
    lidarrUrl?: string;
    lidarrApiKey?: string;
}

/**
 * Represents the DiscoveryAlbumLifecycle class.
 */
export class DiscoveryAlbumLifecycle {
    /**
     * Moves a LIKED discovery album to the permanent LIBRARY.
     * Updates album location, creates OwnedAlbum record, updates artist counts.
     */
    async moveLikedAlbumToLibrary(album: DiscoveryAlbumInfo): Promise<void> {
        const dbAlbum = await retryDiscoveryLinkDrift(() =>
            prisma.$transaction(async (transaction) => {
                const resolution = await resolveDiscoveryCatalogAlbum(
                    transaction,
                    album,
                    { expectedStatuses: ["LIKED"] },
                );
                if (!resolution) {
                    throw new DiscoveryCatalogResolutionError(
                        "Discovery album disappeared during lifecycle promotion",
                    );
                }
                const catalogAlbum = resolution.catalogAlbum;
                if (catalogAlbum) {
                    await promoteAlbumOwnership(
                        transaction,
                        catalogAlbum,
                        DISCOVERY_LIKED_OWNERSHIP_SOURCE,
                    );
                }
                const moved = await transaction.discoveryAlbum.updateMany({
                    where: { id: album.id, status: "LIKED" },
                    data: { status: "MOVED" },
                });
                if (moved.count !== 1) {
                    throw new DiscoveryCatalogResolutionError(
                        "Discovery lifecycle claim failed after row locking",
                    );
                }
                return catalogAlbum;
            }),
        );

        if (dbAlbum) {
            await updateArtistCounts(dbAlbum.artistId);

            logger.debug(
                `[DiscoveryLifecycle] Moved to library: ${album.artistName} - ${album.albumTitle}`,
            );
        }
    }

    /**
     * Deletes a rejected/active discovery album.
     * Removes from Lidarr (if enabled), deletes tracks and album from DB,
     * deletes discovery tracks, marks as DELETED.
     */
    async deleteRejectedAlbum(
        album: DiscoveryAlbumInfo,
        settings: LidarrSettings,
    ): Promise<boolean> {
        const catalogResult = await deleteDiscoveryAlbumCatalogEntry(album);
        if (catalogResult === "retained") {
            logger.debug(
                `[DiscoveryLifecycle] Preserved retained album: ${album.artistName} - ${album.albumTitle}`,
            );
            return false;
        }

        // Catalog deletion commits first. Remote files are best-effort so a
        // retry can still converge discovery links and status after failure.
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey &&
            album.lidarrAlbumId
        ) {
            const client = new LidarrHttpClient({
                baseUrl: settings.lidarrUrl,
                apiKey: settings.lidarrApiKey,
            });
            try {
                await client.delete(`/api/v1/album/${album.lidarrAlbumId}`, {
                    deleteFiles: true,
                });
            } catch (error: unknown) {
                if (
                    error instanceof LidarrHttpError
                        ? error.status !== 404
                        : true
                ) {
                    logger.warn(
                        `[DiscoveryLifecycle] Lidarr delete failed for discoveryAlbum=${album.id}, rgMbid=${album.rgMbid}, lidarrAlbumId=${album.lidarrAlbumId}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        }

        await prisma.discoveryTrack.deleteMany({
            where: { discoveryAlbumId: album.id },
        });

        logger.debug(
            `[DiscoveryLifecycle] Deleted: ${album.artistName} - ${album.albumTitle}`,
        );
        return true;
    }

    /**
     * Processes all previous discovery albums before generating new ones.
     * - LIKED albums are moved to library
     * - ACTIVE albums are deleted
     * - Cleans up unavailable albums for user
     */
    async processBeforeGeneration(
        userId: string,
        settings: LidarrSettings,
    ): Promise<{ moved: number; deleted: number }> {
        logger.debug(
            `[DiscoveryLifecycle] Processing previous discovery albums...`,
        );

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });

        if (discoveryAlbums.length === 0) {
            logger.debug(
                `[DiscoveryLifecycle] No previous discovery albums to process`,
            );
            await prisma.unavailableAlbum.deleteMany({ where: { userId } });
            return { moved: 0, deleted: 0 };
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
        const activeAlbums = discoveryAlbums.filter(
            (a) => a.status === "ACTIVE",
        );

        logger.debug(
            `[DiscoveryLifecycle] Found ${likedAlbums.length} liked albums to keep`,
        );
        logger.debug(
            `[DiscoveryLifecycle] Found ${activeAlbums.length} non-liked albums to remove`,
        );

        let moved = 0;
        let deleted = 0;

        for (const album of likedAlbums) {
            try {
                await this.moveLikedAlbumToLibrary({
                    id: album.id,
                    catalogAlbumId: album.catalogAlbumId,
                    rgMbid: album.rgMbid,
                    artistName: album.artistName,
                    albumTitle: album.albumTitle,
                    lidarrAlbumId: album.lidarrAlbumId,
                });
                moved++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to move ${album.albumTitle}: ${error.message}`,
                );
            }
        }

        for (const album of activeAlbums) {
            try {
                const wasDeleted = await this.deleteRejectedAlbum(
                    {
                        id: album.id,
                        catalogAlbumId: album.catalogAlbumId,
                        rgMbid: album.rgMbid,
                        artistName: album.artistName,
                        albumTitle: album.albumTitle,
                        lidarrAlbumId: album.lidarrAlbumId,
                    },
                    settings,
                );
                if (wasDeleted) deleted++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to delete ${album.albumTitle}: ${error.message}`,
                );
            }
        }

        await prisma.unavailableAlbum.deleteMany({ where: { userId } });

        logger.debug(
            `[DiscoveryLifecycle] Previous discovery cleanup complete`,
        );

        return { moved, deleted };
    }
}

export const discoveryAlbumLifecycle = new DiscoveryAlbumLifecycle();
