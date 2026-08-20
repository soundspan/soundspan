import type { Request, Response } from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "../../../config";
import { lidarrService } from "../../../services/lidarr";
import { deleteDiscoveryAlbumCatalogEntry } from "../../../services/discoveryAlbumCatalogCleanup";
import {
    DISCOVERY_LIKED_OWNERSHIP_SOURCE,
    promoteAlbumOwnership,
} from "../../../services/albumOwnershipPromotion";
import {
    DiscoveryCatalogResolutionError,
    resolveDiscoveryCatalogAlbum,
    retryDiscoveryLinkDrift,
} from "../../../services/discoveryCatalogAlbum";
import { cleanupOrphanedLibraryEntities } from "../../../services/libraryOrphanCleanup";
import {
    discoveryAlbumOrphanRetentionGuardWhere,
    discoveryAlbumTracksOrphanRetentionGuardWhere,
    findUnlinkedLikedDiscoveryRgMbids,
    providerTrackRetentionCutoff,
} from "../../../services/providerTrackRetention";
import { prisma } from "../../../utils/db";
import { TRACK_VISIBLE_WHERE } from "../../../utils/librarySorting";
import { logger } from "../../../utils/logger";
import { safeResolvePath } from "../../../utils/safeResolvePath";
import { getSystemSettings } from "../../../utils/systemSettings";
import { scanQueue } from "../../../workers/queues";
import { sendClearPlaylistFailure } from "../shared";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

interface LegacyCleanupAlbum {
    id: string;
    catalogAlbumId?: string | null;
    albumTitle: string;
    artistName: string;
    rgMbid: string;
}

async function deleteLegacyCatalogAlbum(
    album: LegacyCleanupAlbum,
): ReturnType<typeof deleteDiscoveryAlbumCatalogEntry> {
    return deleteDiscoveryAlbumCatalogEntry(album);
}

async function moveLegacyLikedAlbum(album: LegacyCleanupAlbum) {
    return retryDiscoveryLinkDrift(() =>
        prisma.$transaction(async (transaction) => {
            const resolution = await resolveDiscoveryCatalogAlbum(
                transaction,
                album,
                { expectedStatuses: ["LIKED"] },
            );
            if (!resolution) {
                throw new DiscoveryCatalogResolutionError(
                    "Discovery album disappeared during legacy promotion",
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
                    "Legacy discovery move claim failed after row locking",
                );
            }
            return catalogAlbum;
        }),
    );
}

/** Handles frozen legacy discovery playlist cleanup. */
export async function handleLegacyClear(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        logger.debug(`\n Clearing Discover Weekly playlist for user ${userId}`);

        // Get all discovery albums for this user
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });

        if (discoveryAlbums.length === 0) {
            return res.json({
                success: true,
                message: "No discovery albums to clear",
                likedMoved: 0,
                activeDeleted: 0,
            });
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
        const activeAlbums = discoveryAlbums.filter(
            (a) => a.status === "ACTIVE",
        );

        logger.debug(
            `  Found ${likedAlbums.length} liked albums to move to library`,
        );
        logger.debug(`  Found ${activeAlbums.length} active albums to delete`);

        // Get system settings for Lidarr
        const settings = await getSystemSettings();

        let likedMoved = 0;
        let activeDeleted = 0;

        // Process liked albums - move to library
        if (likedAlbums.length > 0) {
            logger.debug(`\n[LIBRARY] Moving liked albums to library...`);

            for (const album of likedAlbums) {
                try {
                    const dbAlbum = await moveLegacyLikedAlbum(album);

                    if (dbAlbum) {
                        // If Lidarr is enabled, move the album files to main library
                        if (
                            settings.lidarrEnabled &&
                            settings.lidarrUrl &&
                            settings.lidarrApiKey &&
                            album.lidarrAlbumId
                        ) {
                            try {
                                // Get album details from Lidarr
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    },
                                );

                                const artistId = albumResponse.data.artistId;

                                // Get artist details
                                const artistResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    },
                                );

                                // Update artist's root folder path to main library if in discovery
                                if (
                                    artistResponse.data.path?.includes(
                                        "/music/discovery",
                                    )
                                ) {
                                    // Move artist to main library path
                                    await axios.put(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            ...artistResponse.data,
                                            path: artistResponse.data.path.replace(
                                                "/music/discovery",
                                                "/music",
                                            ),
                                            moveFiles: true,
                                        },
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 30000,
                                        },
                                    );
                                    logger.debug(
                                        `    Moved to library: ${album.artistName} - ${album.albumTitle}`,
                                    );
                                }
                            } catch (lidarrError: any) {
                                logger.debug(
                                    `  Lidarr move failed for ${album.albumTitle}: ${lidarrError.message}`,
                                );
                            }
                        }

                        likedMoved++;
                    }
                } catch (error: any) {
                    logger.error(
                        `  ✗ Failed to move ${album.albumTitle}: ${error.message}`,
                    );
                }
            }
        }

        // Process active (non-liked) albums - delete them
        if (activeAlbums.length > 0) {
            logger.debug(`\n[CLEANUP] Deleting non-liked albums...`);

            const checkedArtistIds = new Set<number>();

            for (const album of activeAlbums) {
                try {
                    const catalogResult = await deleteLegacyCatalogAlbum(album);
                    if (catalogResult === "retained") {
                        logger.debug(
                            `  Preserved retained album: ${album.artistName} - ${album.albumTitle}`,
                        );
                        continue;
                    }

                    // Catalog deletion commits first. Remote and local files
                    // are best-effort so retries can converge links and state.
                    // Remove from Lidarr if enabled
                    if (
                        settings.lidarrEnabled &&
                        settings.lidarrUrl &&
                        settings.lidarrApiKey &&
                        album.lidarrAlbumId
                    ) {
                        try {
                            // Get album details to find artist ID
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    },
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e: any) {
                                if (e.response?.status !== 404) throw e;
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                },
                            );
                            logger.debug(
                                `    Deleted from Lidarr: ${album.albumTitle}`,
                            );

                            // Check if artist should be removed too
                            if (artistId && !checkedArtistIds.has(artistId)) {
                                checkedArtistIds.add(artistId);

                                try {
                                    const artistResponse = await axios.get(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 10000,
                                        },
                                    );

                                    const artist = artistResponse.data;
                                    const artistMbid = artist.foreignArtistId;

                                    // Check if artist has any NATIVE library content (real user library)
                                    // This is more reliable than checking Album.location which can be wrong
                                    const hasNativeOwnedAlbums =
                                        await prisma.ownedAlbum.findFirst({
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
                                                status: {
                                                    in: ["LIKED", "MOVED"],
                                                },
                                            },
                                        });

                                    // Only remove artist if they have no native library content and no kept discovery albums
                                    if (
                                        !hasNativeOwnedAlbums &&
                                        !hasKeptDiscoveryAlbums
                                    ) {
                                        await axios.delete(
                                            `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                            {
                                                params: { deleteFiles: true },
                                                headers: {
                                                    "X-Api-Key":
                                                        settings.lidarrApiKey,
                                                },
                                                timeout: 10000,
                                            },
                                        );
                                        logger.debug(
                                            `    Removed artist from Lidarr: ${artist.artistName}`,
                                        );
                                    } else {
                                        logger.debug(
                                            `    Keeping artist in Lidarr: ${artist.artistName} (has library or kept albums)`,
                                        );
                                    }
                                } catch (e: any) {
                                    // Artist might have other albums
                                }
                            }
                        } catch (lidarrError: any) {
                            if (lidarrError.response?.status !== 404) {
                                logger.warn(
                                    `  Lidarr delete failed for discoveryAlbum=${album.id}, rgMbid=${album.rgMbid}, lidarrAlbumId=${album.lidarrAlbumId}: ${lidarrError.message}`,
                                );
                            }
                        }
                    }

                    // FALLBACK: Direct filesystem deletion (in case Lidarr's deleteFiles didn't work)
                    // Try to delete files directly from the discovery folder
                    try {
                        const discoveryPath = path.join(
                            config.music.musicPath,
                            "discovery",
                        );
                        // Try common folder structures: /discovery/Artist/Album or /discovery/Artist - Album
                        const possiblePaths = [
                            safeResolvePath(
                                discoveryPath,
                                path.join(album.artistName, album.albumTitle),
                            ),
                            safeResolvePath(discoveryPath, album.artistName),
                            safeResolvePath(
                                discoveryPath,
                                `${album.artistName} - ${album.albumTitle}`,
                            ),
                        ].filter((candidatePath): candidatePath is string =>
                            Boolean(candidatePath),
                        );

                        for (const albumPath of possiblePaths) {
                            if (fs.existsSync(albumPath)) {
                                fs.rmSync(albumPath, {
                                    recursive: true,
                                    force: true,
                                });
                                logger.debug(
                                    `    Direct deleted: ${albumPath}`,
                                );
                                break; // Stop after first successful delete
                            }
                        }
                    } catch (fsError: any) {
                        logger.warn(
                            `    Filesystem delete failed for discoveryAlbum=${album.id}, rgMbid=${album.rgMbid}, album=${album.albumTitle}: ${fsError.message}`,
                        );
                    }

                    // Delete discovery links only after catalog deletion succeeds.
                    await prisma.discoveryTrack.deleteMany({
                        where: { discoveryAlbumId: album.id },
                    });

                    activeDeleted++;
                } catch (error: any) {
                    logger.error(
                        `  ✗ Failed to delete ${album.albumTitle}: ${error.message}`,
                    );
                }
            }
        }

        // ALSO clean up "extra" downloaded albums that didn't make the final playlist
        // These are in DownloadJob but not in DiscoveryAlbum
        // IMPORTANT: Skip any albums where the artist has LIKED content (even if MBID doesn't match)
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            const completedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "completed",
                },
            });

            // Get all DiscoveryAlbum for this user (including ones we just processed)
            const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany({
                where: { userId },
                select: {
                    rgMbid: true,
                    artistName: true,
                    albumTitle: true,
                    status: true,
                },
            });
            const discoveryMbids = new Set(
                allDiscoveryAlbums.map((da) => da.rgMbid),
            );

            // Build a set of liked artist names (case-insensitive) for extra protection
            const likedArtistNames = new Set(
                allDiscoveryAlbums
                    .filter(
                        (da) => da.status === "LIKED" || da.status === "MOVED",
                    )
                    .map((da) => da.artistName.toLowerCase()),
            );

            // Find completed jobs that didn't make the playlist AND aren't from liked artists
            const extraJobs = completedJobs.filter((job) => {
                // If MBID matches a discovery album, not an "extra"
                if (discoveryMbids.has(job.targetMbid)) return false;

                // If this job's artist has any LIKED albums, don't clean it up
                const metadata = job.metadata as any;
                const artistName = metadata?.artistName?.toLowerCase();
                if (artistName && likedArtistNames.has(artistName)) {
                    logger.debug(
                        `    Skipping ${metadata?.albumTitle} - artist ${metadata?.artistName} has liked albums`,
                    );
                    return false;
                }

                return true;
            });

            if (extraJobs.length > 0) {
                logger.debug(
                    `\n[CLEANUP] Found ${extraJobs.length} extra albums to clean from Lidarr...`,
                );

                for (const job of extraJobs) {
                    const metadata = job.metadata as any;
                    const albumTitle = metadata?.albumTitle || job.subject;
                    const artistName = metadata?.artistName;

                    // Double-check: also check by artist name + album title for LIKED status
                    const isLikedByName = await prisma.discoveryAlbum.findFirst(
                        {
                            where: {
                                userId,
                                artistName: {
                                    equals: artistName,
                                    mode: "insensitive",
                                },
                                albumTitle: {
                                    equals: albumTitle,
                                    mode: "insensitive",
                                },
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        },
                    );

                    if (isLikedByName) {
                        logger.debug(
                            `    Skipping ${albumTitle} - marked as LIKED`,
                        );
                        continue;
                    }

                    if (job.lidarrAlbumId) {
                        try {
                            // Get artist ID before deleting album
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    },
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e) {
                                // Album might not exist
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                },
                            );
                            logger.debug(
                                `    Cleaned up extra album: ${albumTitle}`,
                            );

                            // Check if artist should be removed too
                            if (artistId) {
                                // Check if artist has any liked albums by NAME (more reliable than MBID)
                                const hasLikedByArtistName =
                                    await prisma.discoveryAlbum.findFirst({
                                        where: {
                                            artistName: {
                                                equals: artistName,
                                                mode: "insensitive",
                                            },
                                            status: { in: ["LIKED", "MOVED"] },
                                        },
                                    });

                                if (hasLikedByArtistName) {
                                    logger.debug(
                                        `    Keeping artist: ${artistName} (has liked albums)`,
                                    );
                                    continue;
                                }

                                const artistMbid = metadata?.artistMbid;
                                if (
                                    artistMbid &&
                                    !artistMbid.startsWith("temp-")
                                ) {
                                    // Check if artist has native library content
                                    const hasNativeLibrary =
                                        await prisma.ownedAlbum.findFirst({
                                            where: {
                                                artist: { mbid: artistMbid },
                                                source: "native_scan",
                                            },
                                        });

                                    if (!hasNativeLibrary) {
                                        try {
                                            await axios.delete(
                                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                                {
                                                    params: {
                                                        deleteFiles: true,
                                                    },
                                                    headers: {
                                                        "X-Api-Key":
                                                            settings.lidarrApiKey,
                                                    },
                                                    timeout: 10000,
                                                },
                                            );
                                            logger.debug(
                                                `    Removed extra artist from Lidarr: ${artistName}`,
                                            );
                                        } catch (e) {
                                            // Artist might have other albums
                                        }
                                    }
                                }
                            }
                        } catch (e: any) {
                            // Ignore - might already be removed
                            if (e.response?.status !== 404) {
                                logger.debug(
                                    `    Failed to clean up ${albumTitle}: ${e.message}`,
                                );
                            }
                        }
                    }
                }
            }
        }

        // Clean up unavailable albums for this user
        await prisma.unavailableAlbum.deleteMany({
            where: { userId },
        });

        // === PHASE 1.5: Clean up failed artists from Lidarr ===
        // Get all failed download jobs for this user and remove their artists from Lidarr
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            logger.debug(
                `\n[CLEANUP] Checking for failed artists to remove from Lidarr...`,
            );

            const failedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    status: "failed",
                    discoveryBatchId: { not: null },
                },
            });

            // Group by artist
            const failedArtistMbids = new Set<string>();
            const artistNames = new Map<string, string>();

            for (const job of failedJobs) {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    failedArtistMbids.add(metadata.artistMbid);
                    artistNames.set(
                        metadata.artistMbid,
                        metadata.artistName || "Unknown",
                    );
                }
            }

            // Remove failed artists that don't have native library content
            for (const artistMbid of failedArtistMbids) {
                try {
                    // Check if artist has any NATIVE library content (real user library)
                    const hasNativeOwnedAlbums =
                        await prisma.ownedAlbum.findFirst({
                            where: {
                                artist: { mbid: artistMbid },
                                source: "native_scan",
                            },
                        });

                    if (hasNativeOwnedAlbums) {
                        logger.debug(
                            `   Keeping ${artistNames.get(
                                artistMbid,
                            )} - has native library content`,
                        );
                        continue;
                    }

                    // Check if artist has any LIKED discovery albums
                    const hasLikedDiscovery =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid,
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        });

                    if (hasLikedDiscovery) {
                        logger.debug(
                            `   Keeping ${artistNames.get(
                                artistMbid,
                            )} - has liked discovery albums`,
                        );
                        continue;
                    }

                    // Find and remove from Lidarr
                    const searchResponse = await axios.get(
                        `${settings.lidarrUrl}/api/v1/artist`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        },
                    );

                    const lidarrArtist = searchResponse.data.find(
                        (a: any) => a.foreignArtistId === artistMbid,
                    );

                    if (lidarrArtist) {
                        await axios.delete(
                            `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                            {
                                params: { deleteFiles: true },
                                headers: { "X-Api-Key": settings.lidarrApiKey },
                                timeout: 10000,
                            },
                        );
                        logger.debug(
                            ` Removed failed artist from Lidarr: ${artistNames.get(
                                artistMbid,
                            )}`,
                        );
                    }
                } catch (e: any) {
                    // Ignore errors - artist might already be removed
                }
            }

            // DON'T delete download jobs immediately - scanner needs them to identify discovery albums
            // They will be cleaned up by the data integrity worker after 30 days
            // Only delete FAILED jobs (they won't help with matching anyway)
            await prisma.downloadJob.deleteMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "failed",
                },
            });
        }

        // === PHASE 2: Clean up orphaned discovery records ===
        // These are Album/Track records with location="DISCOVER" that weren't linked to a DiscoveryAlbum
        // This can happen if downloads failed or playlist build failed
        logger.debug(`\n Cleaning up orphaned discovery records...`);
        const retentionCutoff = providerTrackRetentionCutoff(
            new Date(),
            config.workers.providerTrackRetentionDays,
        );
        const unlinkedLikedRgMbids =
            await findUnlinkedLikedDiscoveryRgMbids(prisma);
        const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(
            retentionCutoff,
            unlinkedLikedRgMbids,
        );

        // Find all DISCOVER albums that don't have a corresponding DiscoveryAlbum record
        const orphanedAlbums = await prisma.album.findMany({
            where: {
                location: "DISCOVER",
                ...retentionWhere,
            },
            include: { artist: true, tracks: true },
        });

        for (const orphanAlbum of orphanedAlbums) {
            // Check if there's a DiscoveryAlbum record for this
            // Include MOVED status because liked albums are marked MOVED during clear
            const hasDiscoveryRecord = await prisma.discoveryAlbum.findFirst({
                where: {
                    OR: [
                        { rgMbid: orphanAlbum.rgMbid },
                        {
                            albumTitle: orphanAlbum.title,
                            artistName: orphanAlbum.artist.name,
                        },
                    ],
                    status: { in: ["ACTIVE", "LIKED", "MOVED"] }, // Keep if active, liked, or moved to library
                },
            });

            // Also check if there's an OwnedAlbum record (user liked it)
            const hasOwnedRecord = await prisma.ownedAlbum.findFirst({
                where: {
                    rgMbid: orphanAlbum.rgMbid,
                },
            });

            if (!hasDiscoveryRecord && !hasOwnedRecord) {
                // Delete tracks first
                await prisma.track.deleteMany({
                    where: discoveryAlbumTracksOrphanRetentionGuardWhere(
                        orphanAlbum.id,
                        retentionCutoff,
                        unlinkedLikedRgMbids,
                    ),
                });
                logger.debug(
                    `    Removed tracks from orphaned album: ${orphanAlbum.artist.name} - ${orphanAlbum.title}`,
                );
            }
        }

        const orphanedParents = await cleanupOrphanedLibraryEntities();
        const orphanedAlbumsDeleted = orphanedParents.albumsDeleted;

        if (orphanedAlbumsDeleted > 0) {
            logger.debug(
                `  Cleaned up ${orphanedAlbumsDeleted} orphaned discovery albums`,
            );
        }

        // Clean up orphaned DiscoveryTrack records (tracks whose album was deleted)
        const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
            where: {
                trackId: null, // Track was deleted but DiscoveryTrack record remains
            },
        });

        if (orphanedDiscoveryTracks.count > 0) {
            logger.debug(
                `  Cleaned up ${orphanedDiscoveryTracks.count} orphaned discovery track records`,
            );
        }

        // Clean up old DiscoveryAlbum records that are DELETED or MOVED (older than 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const oldDiscoveryAlbums = await prisma.discoveryAlbum.deleteMany({
            where: {
                userId,
                status: { in: ["DELETED", "MOVED"] },
                downloadedAt: { lt: thirtyDaysAgo },
            },
        });

        if (oldDiscoveryAlbums.count > 0) {
            logger.debug(
                `  Cleaned up ${oldDiscoveryAlbums.count} old discovery album records`,
            );
        }

        // === PHASE 3: Tag-based Lidarr cleanup ===
        // Only remove artists that have the discovery tag
        // This is the ONLY reliable way to identify discovery artists
        // User's pre-existing library is NEVER touched (no tag = safe)
        let lidarrArtistsRemoved = 0;
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            logger.debug(
                `\n[LIDARR CLEANUP] Tag-based cleanup (discovery tag)...`,
            );

            try {
                // Get all artists with the discovery tag
                const discoveryArtists =
                    await lidarrService.getDiscoveryArtists();
                logger.debug(
                    `   Found ${discoveryArtists.length} artists with discovery tag`,
                );

                for (const lidarrArtist of discoveryArtists) {
                    const artistMbid = lidarrArtist.foreignArtistId;
                    const artistName = lidarrArtist.artistName;

                    if (!artistMbid) continue;

                    // Double-check: if artist has LIKED albums, remove tag but don't delete
                    // (This is a safety net - the like endpoint should have already removed the tag)
                    const hasKeptDiscovery =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid: artistMbid,
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        });

                    if (hasKeptDiscovery) {
                        // Remove the tag but keep the artist
                        logger.debug(
                            `   Keeping ${artistName} - has liked albums (removing tag)`,
                        );
                        await lidarrService.removeDiscoveryTagByMbid(
                            artistMbid,
                        );
                        continue;
                    }

                    // Artist has discovery tag AND no liked albums = safe to delete
                    try {
                        const result = await lidarrService.deleteArtistById(
                            lidarrArtist.id,
                            true,
                        );
                        if (result.success) {
                            lidarrArtistsRemoved++;
                            logger.debug(` Removed: ${artistName}`);
                        }
                    } catch (deleteError: any) {
                        logger.debug(
                            ` Failed to remove ${artistName}: ${deleteError.message}`,
                        );
                    }
                }

                logger.debug(
                    `   Tag-based cleanup complete: ${lidarrArtistsRemoved} artists removed`,
                );
            } catch (lidarrError: any) {
                logger.debug(
                    `   Lidarr cleanup failed: ${lidarrError.message}`,
                );
            }
        }

        // === PHASE 4: Trigger library scan to sync database with filesystem ===
        logger.debug(`\n[SCAN] Triggering library scan to sync database...`);
        try {
            await scanQueue.add("scan", {
                userId,
                musicPath: config.music.musicPath,
            });
            logger.debug(`   Library scan queued successfully`);
        } catch (scanError: any) {
            logger.debug(`   Library scan queue failed: ${scanError.message}`);
            // Non-fatal - continue with response
        }

        logger.debug(
            `\nClear complete: ${likedMoved} moved to library, ${activeDeleted} deleted, ${orphanedAlbumsDeleted} orphans cleaned, ${lidarrArtistsRemoved} Lidarr artists removed`,
        );

        res.json({
            success: true,
            message: "Discovery playlist cleared",
            likedMoved,
            activeDeleted,
            orphanedAlbumsDeleted,
            lidarrArtistsRemoved,
        });
    } catch (error: any) {
        sendClearPlaylistFailure(res, error);
    }
}
