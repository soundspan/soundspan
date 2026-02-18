/**
 * Discovery Album Lifecycle Module
 *
 * Handles lifecycle management for discovery albums:
 * - Moving liked albums to permanent library
 * - Deleting rejected/active albums from DB and Lidarr
 * - Processing albums before new discovery generation
 */

import axios from 'axios';
import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { updateArtistCounts } from '../artistCountsService';

export interface DiscoveryAlbumInfo {
    id: string;
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

export class DiscoveryAlbumLifecycle {
    /**
     * Moves a LIKED discovery album to the permanent LIBRARY.
     * Updates album location, creates OwnedAlbum record, updates artist counts.
     */
    async moveLikedAlbumToLibrary(album: DiscoveryAlbumInfo): Promise<void> {
        const dbAlbum = await prisma.album.findFirst({
            where: { rgMbid: album.rgMbid },
            include: { artist: true },
        });

        if (dbAlbum) {
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: 'LIBRARY' },
            });

            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: dbAlbum.artistId,
                        rgMbid: dbAlbum.rgMbid,
                    },
                },
                create: {
                    artistId: dbAlbum.artistId,
                    rgMbid: dbAlbum.rgMbid,
                    source: 'discover_liked',
                },
                update: {},
            });

            await updateArtistCounts(dbAlbum.artistId);

            logger.debug(
                `[DiscoveryLifecycle] Moved to library: ${album.artistName} - ${album.albumTitle}`
            );
        }

        await prisma.discoveryAlbum.update({
            where: { id: album.id },
            data: { status: 'MOVED' },
        });
    }

    /**
     * Deletes a rejected/active discovery album.
     * Removes from Lidarr (if enabled), deletes tracks and album from DB,
     * deletes discovery tracks, marks as DELETED.
     */
    async deleteRejectedAlbum(
        album: DiscoveryAlbumInfo,
        settings: LidarrSettings
    ): Promise<void> {
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey &&
            album.lidarrAlbumId
        ) {
            try {
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                    {
                        params: { deleteFiles: true },
                        headers: { 'X-Api-Key': settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );
            } catch (lidarrError: any) {
                if (lidarrError.response?.status !== 404) {
                    logger.debug(
                        `[DiscoveryLifecycle] Lidarr delete failed: ${lidarrError.message}`
                    );
                }
            }
        }

        const dbAlbum = await prisma.album.findFirst({
            where: { rgMbid: album.rgMbid },
        });

        if (dbAlbum) {
            await prisma.track.deleteMany({
                where: { albumId: dbAlbum.id },
            });
            await prisma.album.delete({ where: { id: dbAlbum.id } });
        }

        await prisma.discoveryTrack.deleteMany({
            where: { discoveryAlbumId: album.id },
        });

        await prisma.discoveryAlbum.update({
            where: { id: album.id },
            data: { status: 'DELETED' },
        });

        logger.debug(
            `[DiscoveryLifecycle] Deleted: ${album.artistName} - ${album.albumTitle}`
        );
    }

    /**
     * Processes all previous discovery albums before generating new ones.
     * - LIKED albums are moved to library
     * - ACTIVE albums are deleted
     * - Cleans up unavailable albums for user
     */
    async processBeforeGeneration(
        userId: string,
        settings: LidarrSettings
    ): Promise<{ moved: number; deleted: number }> {
        logger.debug(`[DiscoveryLifecycle] Processing previous discovery albums...`);

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ['ACTIVE', 'LIKED'] },
            },
        });

        if (discoveryAlbums.length === 0) {
            logger.debug(`[DiscoveryLifecycle] No previous discovery albums to process`);
            await prisma.unavailableAlbum.deleteMany({ where: { userId } });
            return { moved: 0, deleted: 0 };
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === 'LIKED');
        const activeAlbums = discoveryAlbums.filter((a) => a.status === 'ACTIVE');

        logger.debug(
            `[DiscoveryLifecycle] Found ${likedAlbums.length} liked albums to keep`
        );
        logger.debug(
            `[DiscoveryLifecycle] Found ${activeAlbums.length} non-liked albums to remove`
        );

        let moved = 0;
        let deleted = 0;

        for (const album of likedAlbums) {
            try {
                await this.moveLikedAlbumToLibrary({
                    id: album.id,
                    rgMbid: album.rgMbid,
                    artistName: album.artistName,
                    albumTitle: album.albumTitle,
                    lidarrAlbumId: album.lidarrAlbumId,
                });
                moved++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to move ${album.albumTitle}: ${error.message}`
                );
            }
        }

        for (const album of activeAlbums) {
            try {
                await this.deleteRejectedAlbum(
                    {
                        id: album.id,
                        rgMbid: album.rgMbid,
                        artistName: album.artistName,
                        albumTitle: album.albumTitle,
                        lidarrAlbumId: album.lidarrAlbumId,
                    },
                    settings
                );
                deleted++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to delete ${album.albumTitle}: ${error.message}`
                );
            }
        }

        await prisma.unavailableAlbum.deleteMany({ where: { userId } });

        logger.debug(`[DiscoveryLifecycle] Previous discovery cleanup complete`);

        return { moved, deleted };
    }
}

export const discoveryAlbumLifecycle = new DiscoveryAlbumLifecycle();
