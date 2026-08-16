import { logger } from "../../utils/logger";
import { normalizeArtistName } from "../../utils/artistNormalization";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { shuffleArray } from "../../utils/shuffle";
import { discoveryBatchLogger, discoverySeeding } from "../discovery";
import { discoveryTrackFileSnapshot, discoverWeeklyPrisma } from "./state";
import { getTierFromSimilarity } from "./helpers";
import { LidarrCleanupService } from "./lidarrCleanup";

/** Owns final playlist creation and post-scan reconciliation. */
export class PlaylistPersistenceService extends LidarrCleanupService {
    /**
     * Build final playlist after scan completes (atomic transaction)
     */
    async buildFinalPlaylist(batchId: string) {
        logger.debug(`\n Building final playlist for batch ${batchId}...`);

        const batch = await discoverWeeklyPrisma.discoveryBatch.findUnique({
            where: { id: batchId },
        });

        if (!batch) {
            logger.debug(`   Batch not found`);
            return;
        }

        // Get completed download jobs
        const completedJobs = await discoverWeeklyPrisma.downloadJob.findMany({
            where: {
                discoveryBatchId: batchId,
                status: "completed",
            },
        });

        logger.debug(`   Found ${completedJobs.length} completed downloads`);
        await discoveryBatchLogger.info(
            batchId,
            `Building playlist from ${completedJobs.length} completed downloads`,
        );

        // Build search criteria from completed jobs - use MBID (primary) + artist/album name (fallback)
        const searchCriteria = completedJobs
            .map((j) => {
                const metadata = j.metadata as any;
                return {
                    artistName: metadata?.artistName || "",
                    albumTitle: metadata?.albumTitle || "",
                    albumMbid: metadata?.albumMbid || j.targetMbid || "",
                };
            })
            .filter((c) => c.artistName && c.albumTitle);

        logger.debug(
            `   Searching for tracks using MBID (primary) + name fallback:`,
        );
        for (const c of searchCriteria) {
            logger.debug(
                `     - "${c.albumTitle}" by "${c.artistName}" (MBID: ${
                    c.albumMbid || "none"
                })`,
            );
        }

        // Find tracks - try MBID first (most accurate), then fall back to name matching
        let allTracks: any[] = [];
        for (const criteria of searchCriteria) {
            let tracks: any[] = [];

            // PRIMARY: Search by rgMbid (most accurate)
            if (criteria.albumMbid) {
                tracks = await discoverWeeklyPrisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        album: { rgMbid: criteria.albumMbid },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [MBID] Found ${tracks.length} tracks for "${criteria.albumTitle}"`,
                    );
                }
            }

            // FALLBACK: Search by artist name + album title (case-insensitive)
            if (tracks.length === 0) {
                tracks = await discoverWeeklyPrisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        album: {
                            title: {
                                equals: criteria.albumTitle,
                                mode: "insensitive",
                            },
                            artist: {
                                name: {
                                    equals: criteria.artistName,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [NAME] Found ${tracks.length} tracks for "${criteria.albumTitle}"`,
                    );
                }
            }

            // FALLBACK 2: Normalized name search (handles Unicode/special chars)
            if (tracks.length === 0) {
                // Normalize for comparison
                const normalizeStr = (s: string) =>
                    s
                        .toLowerCase()
                        .normalize("NFKD") // Decompose Unicode
                        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
                        .replace(/[^\w\s]/g, " ") // Replace punctuation with space
                        .replace(/\s+/g, " ") // Normalize whitespace
                        .trim();

                const normalizedAlbum = normalizeStr(criteria.albumTitle);
                const normalizedArtist = normalizeStr(criteria.artistName);

                // Get all albums from this artist (by normalized name)
                const artistAlbums = await discoverWeeklyPrisma.album.findMany({
                    where: {
                        artist: {
                            name: {
                                mode: "insensitive",
                                contains: normalizedArtist.split(" ")[0],
                            },
                        },
                    },
                    include: { artist: true, tracks: true },
                });

                // Find matching album by normalized title
                for (const album of artistAlbums) {
                    if (
                        normalizeStr(album.title) === normalizedAlbum ||
                        normalizeStr(album.title).includes(normalizedAlbum) ||
                        normalizedAlbum.includes(normalizeStr(album.title))
                    ) {
                        tracks = album.tracks.map((t: any) => ({
                            ...t,
                            album: { ...album, artist: album.artist },
                        }));
                        if (tracks.length > 0) {
                            logger.debug(
                                `     [NORMALIZED] Found ${tracks.length} tracks for "${criteria.albumTitle}"`,
                            );
                            break;
                        }
                    }
                }
            }

            if (tracks.length === 0) {
                logger.debug(
                    `     [MISS] No tracks found for "${criteria.albumTitle}" by "${criteria.artistName}"`,
                );
            }

            allTracks.push(...tracks);
        }

        // Remove duplicates (same track ID)
        const uniqueTracks = Array.from(
            new Map(allTracks.map((t) => [t.id, t])).values(),
        );
        allTracks = uniqueTracks;

        logger.debug(
            `   Found ${allTracks.length} tracks from imported albums`,
        );

        if (allTracks.length === 0) {
            logger.debug(
                `   No tracks found after scan - albums may not have imported yet`,
            );
            await discoverWeeklyPrisma.discoveryBatch.update({
                where: { id: batchId },
                data: {
                    status: "failed",
                    errorMessage: "No tracks found after scan",
                    completedAt: new Date(),
                },
            });
            await discoveryBatchLogger.error(
                batchId,
                "No tracks found after scan",
            );
            return;
        }

        // Group tracks by album ID and pick ONE random track per album
        const tracksByAlbum = new Map<string, typeof allTracks>();
        for (const track of allTracks) {
            const albumId = track.album.id;
            if (!tracksByAlbum.has(albumId)) {
                tracksByAlbum.set(albumId, []);
            }
            tracksByAlbum.get(albumId)!.push(track);
        }

        // Select 1 random track from each album
        const onePerAlbum: typeof allTracks = [];
        for (const [albumId, tracks] of tracksByAlbum) {
            const randomTrack =
                tracks[Math.floor(Math.random() * tracks.length)];
            onePerAlbum.push(randomTrack);
        }

        const availableAlbums = onePerAlbum.length;
        const anchorCount = Math.ceil(availableAlbums * 0.2); // Add 20% anchors on top

        logger.debug(
            `   Unique albums available: ${availableAlbums} (from ${allTracks.length} total tracks)`,
        );
        logger.debug(
            `   Target composition: ${availableAlbums} discovery + ${anchorCount} anchors = ${
                availableAlbums + anchorCount
            } total`,
        );

        // Shuffle the unique album tracks
        const shuffled = shuffleArray(onePerAlbum);

        // Step 1: Get ALL discovery tracks (1 per album) - no limit!
        let discoverySelected = [...shuffled];
        logger.debug(
            `   Discovery tracks: ${discoverySelected.length} (ALL available, 1 per album)`,
        );

        // Step 2: ALWAYS add library anchor tracks (20%)
        // Get seed artists for this user
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);
        const seedArtistNames = seeds.slice(0, 10).map((s) => s.name);
        const seedArtistMbids = seeds
            .slice(0, 10)
            .map((s) => s.mbid)
            .filter(Boolean) as string[];

        let libraryAnchors: any[] = [];
        // Get existing track IDs to avoid duplicates
        const existingTrackIds = new Set(discoverySelected.map((t) => t.id));

        // First, try to find library tracks from seed artists (by name or mbid)
        // Also exclude albums already used in discovery
        const usedAlbumIds = new Set(discoverySelected.map((t) => t.album.id));

        if (seedArtistNames.length > 0 || seedArtistMbids.length > 0) {
            const libraryTracks = await discoverWeeklyPrisma.track.findMany({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    ...TRACK_BROWSE_WHERE,
                    album: {
                        artist: {
                            OR: [
                                {
                                    normalizedName: {
                                        in: seedArtistNames.map((n) =>
                                            normalizeArtistName(n),
                                        ),
                                    },
                                },
                                ...(seedArtistMbids.length > 0
                                    ? [{ mbid: { in: seedArtistMbids } }]
                                    : []),
                            ],
                        },
                        location: { in: ["LIBRARY", "FEDERATED"] },
                        id: { notIn: Array.from(usedAlbumIds) }, // Exclude albums already in discovery
                    },
                    id: { notIn: Array.from(existingTrackIds) },
                },
                include: {
                    album: { include: { artist: true } },
                },
                take: anchorCount * 10, // Get extra for 1-per-album selection
            });

            logger.debug(
                `   Found ${libraryTracks.length} candidate library tracks from ${seedArtistNames.length} seed artists`,
            );

            if (libraryTracks.length > 0) {
                // Group by album and pick 1 per album
                const anchorsByAlbum = new Map<
                    string,
                    (typeof libraryTracks)[0]
                >();
                for (const track of libraryTracks) {
                    if (
                        !anchorsByAlbum.has(track.album.id) &&
                        !usedAlbumIds.has(track.album.id)
                    ) {
                        anchorsByAlbum.set(track.album.id, track);
                    }
                }

                // Shuffle and take what we need
                const uniqueAnchors = shuffleArray(
                    Array.from(anchorsByAlbum.values()),
                );
                libraryAnchors = uniqueAnchors.slice(0, anchorCount);

                // Mark these as library anchors and track used albums
                for (const track of libraryAnchors) {
                    (track as any).isLibraryAnchor = true;
                    usedAlbumIds.add(track.album.id);
                }
            }
        }

        // GUARANTEE: If we don't have enough anchors from seed artists, use ANY popular library tracks
        if (libraryAnchors.length < anchorCount) {
            const needed = anchorCount - libraryAnchors.length;
            logger.debug(
                `   Only ${libraryAnchors.length}/${anchorCount} anchors from seeds, adding ${needed} from popular library tracks`,
            );

            // Get track IDs we already have (discovery + current anchors)
            const usedTrackIds = new Set([
                ...existingTrackIds,
                ...libraryAnchors.map((t) => t.id),
            ]);

            // Find popular library tracks (from artists with most plays or albums)
            // Exclude albums already used
            const popularLibraryTracks =
                await discoverWeeklyPrisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        album: {
                            location: { in: ["LIBRARY", "FEDERATED"] },
                            id: { notIn: Array.from(usedAlbumIds) }, // 1 per album
                        },
                        id: { notIn: Array.from(usedTrackIds) },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                    orderBy: {
                        // Order by album's artist name for variety, or you could add play count
                        album: { artist: { name: "asc" } },
                    },
                    take: needed * 10, // Get extra for 1-per-album selection
                });

            if (popularLibraryTracks.length > 0) {
                // Group by album and pick 1 per album
                const popByAlbum = new Map<
                    string,
                    (typeof popularLibraryTracks)[0]
                >();
                for (const track of popularLibraryTracks) {
                    if (
                        !popByAlbum.has(track.album.id) &&
                        !usedAlbumIds.has(track.album.id)
                    ) {
                        popByAlbum.set(track.album.id, track);
                    }
                }

                const shuffledPopular = shuffleArray(
                    Array.from(popByAlbum.values()),
                );
                const additionalAnchors = shuffledPopular.slice(0, needed);

                for (const track of additionalAnchors) {
                    (track as any).isLibraryAnchor = true;
                    usedAlbumIds.add(track.album.id);
                }

                libraryAnchors = [...libraryAnchors, ...additionalAnchors];
                logger.debug(
                    `   Added ${additionalAnchors.length} popular library tracks as anchors (1 per album)`,
                );
            } else {
                logger.debug(
                    `   No additional library tracks available for anchors`,
                );
            }
        }

        logger.debug(
            `   Library anchors: ${libraryAnchors.length}/${anchorCount}`,
        );

        // Combine ALL discovery tracks with anchors
        let selected = [...discoverySelected, ...libraryAnchors];

        // Shuffle the final selection to mix anchors with discovery
        selected = shuffleArray(selected);

        await discoveryBatchLogger.info(
            batchId,
            `Playlist built: ${discoverySelected.length} discovery + ${libraryAnchors.length} anchors = ${selected.length} total`,
        );

        // Log final result
        const target = batch.targetSongCount; // For logging purposes only
        if (selected.length < target) {
            logger.debug(
                `   NOTE: Got ${selected.length} tracks (target was ${target}, including ALL successful downloads)`,
            );
            await discoveryBatchLogger.info(
                batchId,
                `Got ${selected.length} tracks (target was ${target})`,
            );
        } else {
            logger.debug(
                `   SUCCESS: Got ${selected.length} tracks (${discoverySelected.length} discovery + ${libraryAnchors.length} anchors)`,
            );
        }

        // Create discovery records in transaction
        let result: { albumCount: number; trackCount: number } | null = null;
        try {
            result = await discoverWeeklyPrisma.$transaction(async (tx) => {
                const createdAlbums = new Map<string, string>();
                let trackCount = 0;

                for (const track of selected) {
                    // Use album ID as the key for deduplication (not MBID)
                    const albumKey = track.album.id;
                    let discoveryAlbumId = createdAlbums.get(albumKey);

                    if (!discoveryAlbumId) {
                        // Find the job for this album by artist+album name (case-insensitive)
                        const job = completedJobs.find((j) => {
                            const metadata = j.metadata as any;
                            const jobArtist = (metadata?.artistName || "")
                                .toLowerCase()
                                .trim();
                            const jobAlbum = (metadata?.albumTitle || "")
                                .toLowerCase()
                                .trim();
                            const trackArtist = track.album.artist.name
                                .toLowerCase()
                                .trim();
                            const trackAlbum = track.album.title
                                .toLowerCase()
                                .trim();
                            return (
                                jobArtist === trackArtist &&
                                jobAlbum === trackAlbum
                            );
                        });

                        const metadata = job?.metadata as any;

                        // Use upsert to handle regeneration (records may already exist)
                        // IMPORTANT: Use the tier from metadata directly, don't recalculate!
                        // This preserves "wildcard" and other tiers that don't match their similarity
                        const storedTier =
                            metadata?.tier ||
                            getTierFromSimilarity(metadata?.similarity || 0.5);
                        const storedSimilarity = metadata?.similarity || 0.5;

                        // Debug: Log if job wasn't matched
                        if (!job) {
                            logger.debug(
                                `   [WARN] No job match for: ${track.album.artist.name} - ${track.album.title}`,
                            );
                            logger.debug(
                                `     Available jobs: ${completedJobs
                                    .map(
                                        (j) =>
                                            `${
                                                (j.metadata as any)?.artistName
                                            } - ${
                                                (j.metadata as any)?.albumTitle
                                            }`,
                                    )
                                    .slice(0, 5)
                                    .join(", ")}...`,
                            );
                        } else {
                            logger.debug(
                                `   ✓ Job matched: ${
                                    track.album.artist.name
                                } - ${
                                    track.album.title
                                } (tier: ${storedTier}, similarity: ${(
                                    storedSimilarity * 100
                                ).toFixed(0)}%)`,
                            );
                        }

                        const discoveryAlbum = await tx.discoveryAlbum.upsert({
                            where: {
                                userId_weekStartDate_rgMbid: {
                                    userId: batch.userId,
                                    weekStartDate: batch.weekStart,
                                    rgMbid: track.album.rgMbid,
                                },
                            },
                            create: {
                                userId: batch.userId,
                                rgMbid: track.album.rgMbid,
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                            update: {
                                // Refresh data on regeneration
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                downloadedAt: new Date(),
                                status: "ACTIVE", // Reset to active on regeneration
                            },
                        });

                        discoveryAlbumId = discoveryAlbum.id;
                        createdAlbums.set(albumKey, discoveryAlbumId);

                        // Add to exclusion list (if user has exclusions enabled)
                        const userConfig =
                            await tx.userDiscoverConfig.findUnique({
                                where: { userId: batch.userId },
                            });
                        const exclusionMonths =
                            userConfig?.exclusionMonths ?? 6;

                        if (exclusionMonths > 0) {
                            const expiresAt = new Date();
                            expiresAt.setMonth(
                                expiresAt.getMonth() + exclusionMonths,
                            );

                            await tx.discoverExclusion.upsert({
                                where: {
                                    userId_albumMbid: {
                                        userId: batch.userId,
                                        albumMbid: track.album.rgMbid,
                                    },
                                },
                                create: {
                                    userId: batch.userId,
                                    albumMbid: track.album.rgMbid,
                                    artistName: track.album.artist.name,
                                    albumTitle: track.album.title,
                                    expiresAt,
                                },
                                update: {
                                    lastSuggestedAt: new Date(),
                                    expiresAt,
                                },
                            });
                        }
                    }

                    await tx.discoveryTrack.create({
                        data: {
                            discoveryAlbumId,
                            trackId: track.id,
                            ...discoveryTrackFileSnapshot(track),
                        },
                    });

                    trackCount++;
                }

                // Mark batch complete
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "completed",
                        finalSongCount: trackCount,
                        completedAt: new Date(),
                    },
                });

                return { albumCount: createdAlbums.size, trackCount };
            });
        } catch (txError: any) {
            logger.error(`   ERROR: Transaction failed:`, txError.message);
            logger.error(`   Stack:`, txError.stack);
            await discoveryBatchLogger.error(
                batchId,
                `Transaction failed: ${txError.message}`,
            );
        }

        if (result) {
            logger.debug(
                `   Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`,
            );
            await discoveryBatchLogger.info(
                batchId,
                `Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`,
            );
        } else {
            logger.error(
                `   ERROR: Transaction returned null - no records created`,
            );
            await discoveryBatchLogger.error(
                batchId,
                "Transaction failed - no records created",
            );
        }

        // ALWAYS cleanup failed artists from Lidarr (even if playlist creation failed)
        // This prevents accumulating unused artists in Lidarr over time
        await this.cleanupFailedArtists(batchId);

        // Also cleanup any orphaned Lidarr queue items from this batch
        await this.cleanupOrphanedLidarrQueue(batchId);
    }

    /**
     * Reconcile Discovery Weekly tracks after library scans
     * Backfills Discovery Weekly playlists with tracks from albums that downloaded after initial playlist creation
     *
     * Similar to Spotify Import's reconcilePendingTracks(), but for Discovery Weekly:
     * - Finds completed batches from last 7 days
     * - Checks if their downloaded albums are in the library
     * - Creates DiscoveryAlbum + DiscoveryTrack records for missing albums
     */
    async reconcileDiscoveryTracks(): Promise<{
        batchesChecked: number;
        tracksAdded: number;
    }> {
        logger.debug(
            `\n[Discovery Weekly] Reconciling tracks across completed batches...`,
        );

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Find completed batches from last 7 days
        const completedBatches =
            await discoverWeeklyPrisma.discoveryBatch.findMany({
                where: {
                    status: "completed",
                    completedAt: { gte: sevenDaysAgo },
                },
                orderBy: { completedAt: "desc" },
            });

        if (completedBatches.length === 0) {
            logger.debug(`   No completed batches in last 7 days to reconcile`);
            return { batchesChecked: 0, tracksAdded: 0 };
        }

        logger.debug(
            `   Found ${completedBatches.length} completed batch(es) from last 7 days`,
        );

        let totalTracksAdded = 0;
        let batchesChecked = 0;

        for (const batch of completedBatches) {
            logger.debug(`   Checking batch ${batch.id}...`);
            batchesChecked++;

            // Get completed download jobs for this batch
            const completedJobs =
                await discoverWeeklyPrisma.downloadJob.findMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: "completed",
                    },
                });

            if (completedJobs.length === 0) {
                logger.debug(`     No completed jobs in batch ${batch.id}`);
                continue;
            }

            logger.debug(
                `     Found ${completedJobs.length} completed download job(s)`,
            );

            // Check each completed job to see if it has corresponding DiscoveryAlbum records
            for (const job of completedJobs) {
                const metadata = job.metadata as any;
                const albumMbid = metadata?.albumMbid || job.targetMbid;
                const artistName = metadata?.artistName;
                const albumTitle = metadata?.albumTitle;

                if (!albumMbid) {
                    logger.debug(`     Skipping job ${job.id} - no album MBID`);
                    continue;
                }

                // Check if this album already has DiscoveryAlbum record
                const existingDiscoveryAlbum =
                    await discoverWeeklyPrisma.discoveryAlbum.findFirst({
                        where: {
                            userId: batch.userId,
                            weekStartDate: batch.weekStart,
                            rgMbid: albumMbid,
                        },
                    });

                if (existingDiscoveryAlbum) {
                    // Already has discovery record, skip
                    continue;
                }

                logger.debug(
                    `     Album "${albumTitle}" by "${artistName}" missing from Discovery - checking library...`,
                );

                // PRIMARY: Search by rgMbid (most accurate)
                let tracks: any[] = [];
                tracks = await discoverWeeklyPrisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        album: { rgMbid: albumMbid },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `       [MBID] Found ${tracks.length} tracks in library`,
                    );
                }

                // FALLBACK: Search by artist name + album title (case-insensitive)
                if (tracks.length === 0 && artistName && albumTitle) {
                    logger.debug(
                        `       [NAME] Trying name-based search: "${artistName}" - "${albumTitle}"`,
                    );
                    tracks = await discoverWeeklyPrisma.track.findMany({
                        where: {
                            ...TRACK_VISIBLE_WHERE,
                            ...TRACK_BROWSE_WHERE,
                            album: {
                                title: {
                                    equals: albumTitle,
                                    mode: "insensitive",
                                },
                                artist: {
                                    name: {
                                        equals: artistName,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                        include: {
                            album: { include: { artist: true } },
                        },
                    });
                    if (tracks.length > 0) {
                        logger.debug(
                            `       [NAME] Found ${tracks.length} tracks in library`,
                        );
                    }
                }

                if (tracks.length === 0) {
                    logger.debug(
                        `       No tracks found in library - album may not have imported yet`,
                    );
                    continue;
                }

                // Album is in library! Create DiscoveryAlbum + DiscoveryTrack records
                const album = tracks[0].album;
                const similarity = metadata?.similarity || 0.5;
                const tier =
                    metadata?.tier || getTierFromSimilarity(similarity);

                logger.debug(
                    `       ✓ Creating Discovery records for ${tracks.length} track(s)...`,
                );

                try {
                    await discoverWeeklyPrisma.$transaction(async (tx) => {
                        // Create DiscoveryAlbum
                        const discoveryAlbum = await tx.discoveryAlbum.create({
                            data: {
                                userId: batch.userId,
                                rgMbid: album.rgMbid,
                                artistName: album.artist.name,
                                artistMbid: album.artist.mbid,
                                albumTitle: album.title,
                                lidarrAlbumId: job.lidarrAlbumId,
                                similarity,
                                tier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                        });

                        // Create DiscoveryTrack for each track
                        for (const track of tracks) {
                            // Check if track already exists (prevent duplicates)
                            const existingTrack =
                                await tx.discoveryTrack.findFirst({
                                    where: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                    },
                                });

                            if (!existingTrack) {
                                await tx.discoveryTrack.create({
                                    data: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                        ...discoveryTrackFileSnapshot(track),
                                    },
                                });
                                totalTracksAdded++;
                            }
                        }
                    });

                    logger.debug(
                        `       ✓ Added ${tracks.length} track(s) to Discovery Weekly`,
                    );
                } catch (error: any) {
                    logger.error(
                        `       ✗ Failed to create Discovery records: ${error.message}`,
                    );
                }
            }
        }

        logger.debug(
            `   Reconciliation complete: ${totalTracksAdded} tracks added across ${batchesChecked} batches`,
        );

        return {
            batchesChecked,
            tracksAdded: totalTracksAdded,
        };
    }
}
