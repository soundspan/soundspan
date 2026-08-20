import type { Request, Response } from "express";
import axios from "axios";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { getSystemSettings } from "../../../utils/systemSettings";
import { sendRouteError } from "../../routeErrorResponse";
import { sendCleanupLidarrFailure, sendFixTaggingFailure } from "../shared";
import { DISCOVERY_LIKED_OWNERSHIP_SOURCE } from "../../../services/albumOwnershipPromotion";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

/** Handles frozen legacy Lidarr cleanup. */
export async function handleLegacyCleanupLidarr(
    _req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        logger.debug(
            "\n[CLEANUP] Starting Lidarr cleanup of discovery-only artists...",
        );

        const settings = await getSystemSettings();

        if (
            !settings.lidarrEnabled ||
            !settings.lidarrUrl ||
            !settings.lidarrApiKey
        ) {
            return sendRouteError(res, 400, "Lidarr not configured");
        }

        // Get all artists from Lidarr
        const lidarrResponse = await axios.get(
            `${settings.lidarrUrl}/api/v1/artist`,
            {
                headers: { "X-Api-Key": settings.lidarrApiKey },
                timeout: 30000,
            },
        );

        const lidarrArtists = lidarrResponse.data;
        logger.debug(
            `[CLEANUP] Found ${lidarrArtists.length} artists in Lidarr`,
        );

        const artistsRemoved: string[] = [];
        const artistsKept: string[] = [];
        const errors: string[] = [];

        for (const lidarrArtist of lidarrArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            try {
                // Check if this artist has any NATIVE library content (real user library)
                // This is more reliable than checking Album.location which can be wrong
                const hasNativeOwnedAlbums = await prisma.ownedAlbum.findFirst({
                    where: {
                        artist: { mbid: artistMbid },
                        source: "native_scan",
                    },
                });

                // Check if artist has any LIKED/MOVED discovery albums
                const hasKeptDiscoveryAlbums =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            artistMbid: artistMbid,
                            status: { in: ["LIKED", "MOVED"] },
                        },
                    });

                // Check if artist has any ACTIVE discovery albums (current playlist)
                const hasActiveDiscoveryAlbums =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            artistMbid: artistMbid,
                            status: "ACTIVE",
                        },
                    });

                if (hasNativeOwnedAlbums || hasKeptDiscoveryAlbums) {
                    // This artist should stay in Lidarr
                    artistsKept.push(
                        `${artistName} (has native library or kept albums)`,
                    );
                    continue;
                }

                if (hasActiveDiscoveryAlbums) {
                    // This artist has a current discovery album, keep for now
                    artistsKept.push(`${artistName} (has active discovery)`);
                    continue;
                }

                // This artist has no library albums and no active/kept discovery albums
                // They should be removed from Lidarr
                logger.debug(
                    `[CLEANUP] Removing discovery-only artist: ${artistName}`,
                );

                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                    {
                        params: { deleteFiles: true },
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 30000,
                    },
                );

                artistsRemoved.push(artistName);
                logger.debug(`[CLEANUP] Removed: ${artistName}`);
            } catch (error: unknown) {
                const detail =
                    error instanceof Error ? error.message : String(error);
                errors.push(`Failed to process ${artistName}`);
                logger.error(
                    `[CLEANUP] Failed to process ${artistName}: ${detail}`,
                );
            }
        }

        logger.debug(`\n[CLEANUP] Complete:`);
        logger.debug(`   - Removed: ${artistsRemoved.length}`);
        logger.debug(`   - Kept: ${artistsKept.length}`);
        logger.debug(`   - Errors: ${errors.length}`);

        res.json({
            success: true,
            removed: artistsRemoved,
            kept: artistsKept,
            errors,
            summary: {
                removed: artistsRemoved.length,
                kept: artistsKept.length,
                errors: errors.length,
            },
        });
    } catch (error: any) {
        sendCleanupLidarrFailure(res, error);
    }
}

/** Handles frozen legacy tagging repair. */
export async function handleLegacyFixTagging(
    _req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        logger.debug("\n[FIX-TAGGING] Starting album tagging repair...");

        // Get all discovery artists (from DiscoveryAlbum records)
        const discoveryArtists = await prisma.discoveryAlbum.findMany({
            distinct: ["artistMbid"],
            select: { artistMbid: true, artistName: true },
        });

        logger.debug(
            `[FIX-TAGGING] Found ${discoveryArtists.length} artists with discovery records`,
        );

        let albumsFixed = 0;
        let ownedRecordsRemoved = 0;
        const fixedArtists: string[] = [];

        for (const da of discoveryArtists) {
            if (!da.artistMbid) continue;

            // Check if artist has ANY protected content:
            // 1. native_scan = real user library from before discovery
            // 2. discovery_liked = user liked a discovery album (should be kept!)
            const hasProtectedContent = await prisma.ownedAlbum.findFirst({
                where: {
                    artist: { mbid: da.artistMbid },
                    source: {
                        in: ["native_scan", DISCOVERY_LIKED_OWNERSHIP_SOURCE],
                    },
                },
            });

            if (hasProtectedContent) {
                // Artist has protected content - don't touch their albums
                logger.debug(
                    `[FIX-TAGGING] Skipping ${da.artistName} - has protected content (${hasProtectedContent.source})`,
                );
                continue;
            }

            // Also check if artist has any LIKED discovery albums (double-check)
            const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid: da.artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasLikedDiscovery) {
                // User liked albums from this artist - don't touch
                logger.debug(
                    `[FIX-TAGGING] Skipping ${da.artistName} - has LIKED discovery albums`,
                );
                continue;
            }

            // This artist has NO protected content - they're purely an ACTIVE discovery artist
            // Fix any of their albums that are incorrectly tagged as LIBRARY
            const mistaggedAlbums = await prisma.album.findMany({
                where: {
                    artist: { mbid: da.artistMbid },
                    location: "LIBRARY",
                },
            });

            if (mistaggedAlbums.length > 0) {
                // Update all these albums to DISCOVER
                const updated = await prisma.album.updateMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        location: "LIBRARY",
                    },
                    data: { location: "DISCOVER" },
                });

                // Remove incorrect OwnedAlbum records (but not protected ones)
                const removed = await prisma.ownedAlbum.deleteMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        source: {
                            notIn: [
                                "native_scan",
                                DISCOVERY_LIKED_OWNERSHIP_SOURCE,
                            ],
                        },
                    },
                });

                albumsFixed += updated.count;
                ownedRecordsRemoved += removed.count;
                fixedArtists.push(da.artistName);

                logger.debug(
                    `[FIX-TAGGING] Fixed ${updated.count} albums for ${da.artistName}`,
                );
            }
        }

        logger.debug(
            `[FIX-TAGGING] Complete: ${albumsFixed} albums fixed, ${ownedRecordsRemoved} OwnedAlbum records removed`,
        );

        res.json({
            success: true,
            albumsFixed,
            ownedRecordsRemoved,
            fixedArtists,
        });
    } catch (error: any) {
        sendFixTaggingFailure(res, error);
    }
}
