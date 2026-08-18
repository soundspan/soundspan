import type { Request, Response } from "express";
import { lidarrService } from "../../../services/lidarr";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../routeErrorResponse";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

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

        // Find the discovery album
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "ACTIVE",
            },
        });

        if (!discoveryAlbum) {
            return res
                .status(404)
                .json({ error: "Album not in active discovery" });
        }

        // Mark as liked (entire album will be kept)
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "LIKED",
                likedAt: new Date(),
            },
        });

        // Remove discovery tag from the artist in Lidarr
        // This prevents the artist from being deleted during cleanup
        logger.debug(
            `   Removing discovery tag from artist: ${discoveryAlbum.artistName}`,
        );

        // If artistMbid is a temp ID, we need to search Lidarr by artist name instead
        if (
            discoveryAlbum.artistMbid &&
            !discoveryAlbum.artistMbid.startsWith("temp-")
        ) {
            await lidarrService.removeDiscoveryTagByMbid(
                discoveryAlbum.artistMbid,
            );
        } else {
            // Search Lidarr for the artist by name and remove tag
            try {
                const lidarrArtists = await lidarrService.getArtists();
                const lidarrArtist = lidarrArtists.find(
                    (a) =>
                        a.artistName.toLowerCase() ===
                        discoveryAlbum.artistName.toLowerCase(),
                );

                if (lidarrArtist) {
                    const tagId = await lidarrService.getOrCreateDiscoveryTag();
                    if (tagId && lidarrArtist.tags?.includes(tagId)) {
                        await lidarrService.removeTagsFromArtist(
                            lidarrArtist.id,
                            [tagId],
                        );
                        logger.debug(
                            `   Removed discovery tag from ${lidarrArtist.artistName} (found by name)`,
                        );
                    }
                } else {
                    logger.debug(
                        `   Artist ${discoveryAlbum.artistName} not found in Lidarr (may have been removed)`,
                    );
                }
            } catch (e: any) {
                logger.debug(`   Failed to remove discovery tag: ${e.message}`);
            }
        }

        // Find the actual Album record and create OwnedAlbum so it appears in library immediately
        // Match by artist name + album title since rgMbid may differ between DiscoveryAlbum and scanned Album
        const dbAlbum = await prisma.album.findFirst({
            where: {
                OR: [
                    { rgMbid: albumId },
                    {
                        title: {
                            equals: discoveryAlbum.albumTitle,
                            mode: "insensitive",
                        },
                        artist: {
                            name: {
                                equals: discoveryAlbum.artistName,
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            },
            include: { artist: true },
        });

        if (dbAlbum) {
            // Update album location to LIBRARY so it appears in owned view
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: "LIBRARY" },
            });

            // Create OwnedAlbum record if doesn't exist (makes it appear in "Owned" filter)
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
                    source: "discovery_liked",
                },
                update: {
                    source: "discovery_liked",
                },
            });
            logger.debug(
                ` Added liked album to library: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`,
            );
        } else {
            logger.debug(
                `   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`,
            );
        }

        // Retroactively mark all plays from this album as DISCOVERY_KEPT
        // Note: This requires getting tracks from the album first
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY",
                },
                data: {
                    source: "DISCOVERY_KEPT",
                },
            });
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

        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "LIKED",
            },
        });

        if (!discoveryAlbum) {
            return sendRouteError(res, 404, "Album not liked");
        }

        // Revert status back to ACTIVE
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "ACTIVE",
                likedAt: null,
            },
        });

        // Remove OwnedAlbum record if it was from discovery_liked
        await prisma.ownedAlbum.deleteMany({
            where: {
                rgMbid: albumId,
                source: "discovery_liked",
            },
        });

        // Revert plays back to DISCOVERY source
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY_KEPT",
                },
                data: {
                    source: "DISCOVERY",
                },
            });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error("Unlike discovery album error:", error);
        sendInternalRouteError(res, "Failed to unlike album");
    }
}
