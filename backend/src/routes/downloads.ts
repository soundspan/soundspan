import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import { soulseekService } from "../services/soulseek";
import { tidalService } from "../services/tidal";
import { musicBrainzService } from "../services/musicbrainz";
import { lastFmService } from "../services/lastfm";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { mapInteractiveRelease } from "../services/releaseContracts";
import crypto from "crypto";

const router = Router();

router.use(requireAuthOrToken);

/**
 * GET /downloads/availability
 * Check whether any download service (Lidarr or Soulseek) is configured and enabled.
 * Non-admin endpoint — any authenticated user can check.
 */
router.get("/availability", async (req, res) => {
    try {
        const [lidarrEnabled, soulseekAvailable, tidalAvailable] = await Promise.all([
            lidarrService.isEnabled(),
            soulseekService.isAvailable(),
            tidalService.isAvailable(),
        ]);

        res.json({
            enabled: lidarrEnabled || soulseekAvailable || tidalAvailable,
            lidarr: lidarrEnabled,
            soulseek: soulseekAvailable,
            tidal: tidalAvailable,
        });
    } catch (error: any) {
        logger.error("Download availability check error:", error.message);
        res.status(500).json({ error: "Failed to check download availability" });
    }
});

/**
 * Verify and potentially correct artist name before download
 * Uses multiple sources for canonical name resolution:
 * 1. MusicBrainz (if MBID provided) - most authoritative
 * 2. LastFM correction API - handles aliases and misspellings
 * 3. Original name - fallback
 *
 * @returns Object with verified name and whether correction was applied
 */
async function verifyArtistName(
    artistName: string,
    artistMbid?: string
): Promise<{
    verifiedName: string;
    wasCorrected: boolean;
    source: "musicbrainz" | "lastfm" | "original";
    originalName: string;
}> {
    const originalName = artistName;

    // Strategy 1: If we have MBID, use MusicBrainz as authoritative source
    if (artistMbid) {
        try {
            const mbArtist = await musicBrainzService.getArtist(artistMbid);
            if (mbArtist?.name) {
                return {
                    verifiedName: mbArtist.name,
                    wasCorrected:
                        mbArtist.name.toLowerCase() !==
                        artistName.toLowerCase(),
                    source: "musicbrainz",
                    originalName,
                };
            }
        } catch (error) {
            logger.warn(
                `MusicBrainz lookup failed for MBID ${artistMbid}:`,
                error
            );
        }
    }

    // Strategy 2: Use LastFM correction API
    try {
        const correction = await lastFmService.getArtistCorrection(artistName);
        if (correction?.corrected) {
            logger.debug(
                `[VERIFY] LastFM correction: "${artistName}" → "${correction.canonicalName}"`
            );
            return {
                verifiedName: correction.canonicalName,
                wasCorrected: true,
                source: "lastfm",
                originalName,
            };
        }
    } catch (error) {
        logger.warn(
            `LastFM correction lookup failed for "${artistName}":`,
            error
        );
    }

    // Strategy 3: Return original name
    return {
        verifiedName: artistName,
        wasCorrected: false,
        source: "original",
        originalName,
    };
}

// POST /downloads - Create download job
router.post("/", async (req, res) => {
    try {
        const {
            type,
            mbid,
            subject,
            artistName,
            albumTitle,
            downloadType = "library",
        } = req.body;
        const userId = req.user!.id;

        if (!type || !mbid || !subject) {
            return res.status(400).json({
                error: "Missing required fields: type, mbid, subject",
            });
        }

        if (type !== "artist" && type !== "album") {
            return res
                .status(400)
                .json({ error: "Type must be 'artist' or 'album'" });
        }

        if (downloadType !== "library" && downloadType !== "discovery") {
            return res.status(400).json({
                error: "downloadType must be 'library' or 'discovery'",
            });
        }

        // Check if at least one download service is available
        const settings = await getSystemSettings();
        const [lidarrEnabled, soulseekAvailable, tidalAvailable] = await Promise.all([
            lidarrService.isEnabled(),
            soulseekService.isAvailable(),
            tidalService.isAvailable(),
        ]);

        if (!lidarrEnabled && !soulseekAvailable && !tidalAvailable) {
            return res.status(400).json({
                error: "No download service configured. Please set up Lidarr, Soulseek, or TIDAL.",
            });
        }

        // Determine root folder path based on download type
        const baseMusicPath = settings?.musicPath || config.music.musicPath;
        const rootFolderPath =
            downloadType === "discovery"
                ? `${baseMusicPath}/discovery`
                : baseMusicPath;

        if (type === "artist") {
            // For artist downloads, fetch albums and create individual jobs
            const jobs = await processArtistDownload(
                userId,
                mbid,
                subject,
                rootFolderPath,
                downloadType
            );

            return res.json({
                id: jobs[0]?.id || null,
                status: "processing",
                downloadType,
                rootFolderPath,
                message: `Creating download jobs for ${jobs.length} album(s)...`,
                albumCount: jobs.length,
                jobs: jobs.map((j) => ({ id: j.id, subject: j.subject })),
            });
        }

        // Single album download - verify artist name before proceeding
        // NOTE: Do NOT pass `mbid` here — for album downloads, mbid is a release-group
        // MBID, not an artist MBID. Passing it to getArtist() would cause a 404.
        let verifiedArtistName = artistName;
        if (type === "album" && artistName) {
            const verification = await verifyArtistName(artistName);
            if (verification.wasCorrected) {
                logger.debug(
                    `[DOWNLOAD] Artist name verified: "${artistName}" → "${verification.verifiedName}" (source: ${verification.source})`
                );
                verifiedArtistName = verification.verifiedName;
            }
        }

        // Single album download - use transaction with row-level locking to prevent race conditions
        // This prevents TOCTOU (Time-Of-Check-Time-Of-Use) race condition where two concurrent
        // requests could both pass the "check if exists" step and create duplicate jobs
        const jobResult = await prisma.$transaction(async (tx) => {
            // Check for existing active job with FOR UPDATE SKIP LOCKED
            // FOR UPDATE locks the rows for the duration of the transaction
            // SKIP LOCKED prevents blocking on rows locked by other transactions
            const existingJobs = await tx.$queryRaw<
                Array<{
                    id: string;
                    status: string;
                    subject: string;
                    createdAt: Date;
                }>
            >`
                SELECT id, status, subject, "createdAt"
                FROM "DownloadJob"
                WHERE "targetMbid" = ${mbid}
                AND status IN ('pending', 'processing')
                FOR UPDATE SKIP LOCKED
            `;

            if (existingJobs.length > 0) {
                const existingJob = existingJobs[0];
                logger.debug(
                    `[DOWNLOAD] Job already exists for ${mbid}: ${existingJob.id} (${existingJob.status})`
                );
                return { duplicate: true, job: existingJob };
            }

            // No existing active job found, create new one
            const newJob = await tx.downloadJob.create({
                data: {
                    userId,
                    subject,
                    type,
                    targetMbid: mbid,
                    status: "pending",
                    metadata: {
                        downloadType,
                        rootFolderPath,
                        artistName: verifiedArtistName,
                        albumTitle,
                    },
                },
            });

            return { duplicate: false, job: newJob };
        });

        // Handle duplicate case - return existing job info
        if (jobResult.duplicate) {
            return res.json({
                id: jobResult.job.id,
                status: jobResult.job.status,
                downloadType,
                rootFolderPath,
                message: "Download already in progress",
                duplicate: true,
            });
        }

        const job = jobResult.job;

        logger.debug(
            `[DOWNLOAD] Triggering Lidarr: ${type} "${subject}" -> ${rootFolderPath}`
        );

        // Process in background
        processDownload(
            job.id,
            type,
            mbid,
            subject,
            rootFolderPath,
            verifiedArtistName,
            albumTitle
        ).catch((error) => {
            logger.error(
                `Download processing failed for job ${job.id}:`,
                error
            );
        });

        res.json({
            id: job.id,
            status: job.status,
            downloadType,
            rootFolderPath,
            message: "Download job created. Processing in background.",
        });
    } catch (error: any) {
        // Handle P2002 unique constraint violation - race condition caught by unique index
        // This can happen when two transactions both see empty results from SKIP LOCKED
        // and both attempt to insert, with one winning and the other hitting the unique constraint
        if (error.code === "P2002") {
            const { mbid } = req.body;
            const existingJob = await prisma.downloadJob.findFirst({
                where: {
                    targetMbid: mbid,
                    status: { in: ["pending", "processing"] },
                },
            });
            if (existingJob) {
                return res.json({
                    id: existingJob.id,
                    status: existingJob.status,
                    duplicate: true,
                    message: "Download already in progress",
                });
            }
        }
        logger.error("Create download job error:", error);
        res.status(500).json({ error: "Failed to create download job" });
    }
});

/**
 * Process artist download by creating individual album jobs
 */
async function processArtistDownload(
    userId: string,
    artistMbid: string,
    artistName: string,
    rootFolderPath: string,
    downloadType: string
): Promise<{ id: string; subject: string }[]> {
    logger.debug(`\n Processing artist download: ${artistName}`);
    logger.debug(`   Artist MBID: ${artistMbid}`);

    // Generate a batch ID to group all album downloads
    const batchId = crypto.randomUUID();
    logger.debug(`   Batch ID: ${batchId}`);

    // CRITICAL FIX: Resolve canonical artist name from MusicBrainz
    // Last.fm may return aliases (e.g., "blink" for "blink-182")
    // Lidarr needs the official name to find the correct artist
    let canonicalArtistName = artistName;
    try {
        logger.debug(`   Resolving canonical artist name from MusicBrainz...`);
        const mbArtist = await musicBrainzService.getArtist(artistMbid);
        if (mbArtist && mbArtist.name) {
            canonicalArtistName = mbArtist.name;
            if (canonicalArtistName !== artistName) {
                logger.debug(
                    `   ✓ Canonical name resolved: "${artistName}" → "${canonicalArtistName}"`
                );
            } else {
                logger.debug(
                    `   ✓ Name matches canonical: "${canonicalArtistName}"`
                );
            }
        }
    } catch (mbError: any) {
        logger.warn(`   ⚠ MusicBrainz lookup failed: ${mbError.message}`);
        // Fallback to LastFM correction
        try {
            const correction = await lastFmService.getArtistCorrection(
                artistName
            );
            if (correction?.canonicalName) {
                canonicalArtistName = correction.canonicalName;
                logger.debug(
                    `   ✓ Name resolved via LastFM: "${artistName}" → "${canonicalArtistName}"`
                );
            }
        } catch (lfmError) {
            logger.warn(
                `   ⚠ LastFM correction also failed, using original name`
            );
        }
    }

    try {
        // First, add the artist to Lidarr (this monitors all albums)
        const lidarrArtist = await lidarrService.addArtist(
            artistMbid,
            canonicalArtistName,
            rootFolderPath
        );

        if (!lidarrArtist) {
            logger.debug(`   Failed to add artist to Lidarr`);
            throw new Error("Failed to add artist to Lidarr");
        }

        logger.debug(`   Artist added to Lidarr (ID: ${lidarrArtist.id})`);

        // Fetch albums from MusicBrainz
        const releaseGroups = await musicBrainzService.getReleaseGroups(
            artistMbid,
            ["album", "ep"],
            100
        );

        logger.debug(
            `   Found ${releaseGroups.length} albums/EPs from MusicBrainz`
        );

        if (releaseGroups.length === 0) {
            logger.debug(`   No albums found for artist`);
            return [];
        }

        // Create individual album jobs
        const jobs: { id: string; subject: string }[] = [];

        for (const rg of releaseGroups) {
            const albumMbid = rg.id;
            const albumTitle = rg.title;
            const albumSubject = `${artistName} - ${albumTitle}`;

            // Check if we already have this album downloaded
            const existingAlbum = await prisma.album.findFirst({
                where: { rgMbid: albumMbid },
            });

            if (existingAlbum) {
                logger.debug(`   Skipping "${albumTitle}" - already in library`);
                continue;
            }

            // Use transaction with row-level locking to prevent race conditions
            const jobResult = await prisma.$transaction(async (tx) => {
                // Check for existing active job with FOR UPDATE SKIP LOCKED
                // This prevents TOCTOU race conditions like in the single download case
                const existingJobs = await tx.$queryRaw<
                    Array<{
                        id: string;
                        status: string;
                        subject: string;
                        createdAt: Date;
                    }>
                >`
                    SELECT id, status, subject, "createdAt"
                    FROM "DownloadJob"
                    WHERE "targetMbid" = ${albumMbid}
                    AND status IN ('pending', 'processing')
                    FOR UPDATE SKIP LOCKED
                `;

                if (existingJobs.length > 0) {
                    return {
                        skipped: true,
                        job: existingJobs[0],
                        reason: "already_queued",
                    };
                }

                // Also check for recently failed job (within last 30 seconds) to prevent spam retries
                const recentFailed = await tx.$queryRaw<
                    Array<{
                        id: string;
                        status: string;
                        completedAt: Date;
                    }>
                >`
                    SELECT id, status, "completedAt"
                    FROM "DownloadJob"
                    WHERE "targetMbid" = ${albumMbid}
                    AND status = 'failed'
                    AND "completedAt" >= ${new Date(Date.now() - 30000)}
                    FOR UPDATE SKIP LOCKED
                `;

                if (recentFailed.length > 0) {
                    return {
                        skipped: true,
                        job: recentFailed[0],
                        reason: "recently_failed",
                    };
                }

                // Create new job inside transaction
                const now = new Date();
                const job = await tx.downloadJob.create({
                    data: {
                        userId,
                        subject: albumSubject,
                        type: "album",
                        targetMbid: albumMbid,
                        status: "pending",
                        metadata: {
                            downloadType,
                            rootFolderPath,
                            artistName,
                            artistMbid,
                            albumTitle,
                            batchId, // Link all albums in this artist download
                            batchArtist: artistName,
                            createdAt: now.toISOString(), // Track when job was created for timeout
                        },
                    },
                });

                return { skipped: false, job };
            });

            if (jobResult.skipped) {
                logger.debug(
                    `   Skipping "${albumTitle}" - ${
                        jobResult.reason === "recently_failed"
                            ? "recently failed"
                            : "already in download queue"
                    }`
                );
                continue;
            }

            const job = jobResult.job;
            jobs.push({ id: job.id, subject: albumSubject });
            logger.debug(`   [JOB] Created job for: ${albumSubject}`);

            // Start the download in background
            processDownload(
                job.id,
                "album",
                albumMbid,
                albumSubject,
                rootFolderPath,
                artistName,
                albumTitle
            ).catch((error) => {
                logger.error(`Download failed for ${albumSubject}:`, error);
            });
        }

        logger.debug(`   Created ${jobs.length} album download jobs`);
        return jobs;
    } catch (error: any) {
        logger.error(`   Failed to process artist download:`, error.message);
        throw error;
    }
}

// Background download processor
async function processDownload(
    jobId: string,
    type: string,
    mbid: string,
    subject: string,
    rootFolderPath: string,
    artistName?: string,
    albumTitle?: string
) {
    const job = await prisma.downloadJob.findUnique({ where: { id: jobId } });
    if (!job) {
        logger.error(`Job ${jobId} not found`);
        return;
    }

    if (type === "album") {
        let parsedArtist = artistName;
        let parsedAlbum = albumTitle;

        if (!parsedArtist || !parsedAlbum) {
            const parts = subject.split(" - ");
            if (parts.length >= 2) {
                parsedArtist = parts[0].trim();
                parsedAlbum = parts.slice(1).join(" - ").trim();
            } else {
                parsedArtist = subject;
                parsedAlbum = subject;
            }
        }

        logger.debug(`Parsed: Artist="${parsedArtist}", Album="${parsedAlbum}"`);

        // Check configured download source and service availability
        const settings = await getSystemSettings();
        const configuredSource = settings?.downloadSource || "soulseek";

        const [tidalAvail, lidarrAvail, soulseekAvail] = await Promise.all([
            tidalService.isAvailable(),
            lidarrService.isEnabled(),
            soulseekService.isAvailable(),
        ]);

        // Determine effective download source:
        // 1. Use configured source if that service is available
        // 2. Otherwise auto-detect: prefer Tidal > Soulseek > Lidarr
        let effectiveSource = configuredSource;
        if (configuredSource === "tidal" && !tidalAvail) {
            effectiveSource = soulseekAvail ? "soulseek" : lidarrAvail ? "lidarr" : "soulseek";
        } else if (configuredSource === "soulseek" && !soulseekAvail) {
            effectiveSource = tidalAvail ? "tidal" : lidarrAvail ? "lidarr" : "soulseek";
        } else if (configuredSource === "lidarr" && !lidarrAvail) {
            effectiveSource = tidalAvail ? "tidal" : soulseekAvail ? "soulseek" : "lidarr";
        }

        logger.debug(`Download source: configured=${configuredSource}, effective=${effectiveSource}`);

        if (effectiveSource === "tidal" && tidalAvail) {
            await processTidalDownload(jobId, parsedArtist, parsedAlbum, job.userId);
        } else {
            // Use simple download manager for Lidarr/Soulseek downloads
            const result = await simpleDownloadManager.startDownload(
                jobId,
                parsedArtist,
                parsedAlbum,
                mbid,
                job.userId
            );

            if (!result.success) {
                logger.error(`Failed to start download: ${result.error}`);
            }
        }
    }
}

/**
 * Process a TIDAL download: search → download album → update job → trigger scan
 */
async function processTidalDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string
) {
    const existingJob = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    const existingMetadata = (existingJob?.metadata as any) || {};

    try {
        // Mark job as processing with TIDAL source
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status: "processing",
                metadata: {
                    ...existingMetadata,
                    currentSource: "tidal",
                    statusText: "Searching TIDAL...",
                },
            },
        });

        // Search TIDAL for the album
        const match = await tidalService.findAlbum(artistName, albumTitle);
        if (!match) {
            // TIDAL search failed — check for fallback
            const settings = await getSystemSettings();
            const fallback = settings?.primaryFailureFallback;

            if (fallback && fallback !== "none" && fallback !== "tidal") {
                logger.debug(
                    `[TIDAL] Album not found, falling back to ${fallback}`
                );
                await prisma.downloadJob.update({
                    where: { id: jobId },
                    data: {
                        metadata: {
                            ...existingMetadata,
                            currentSource: fallback,
                            statusText: `TIDAL not found → ${fallback}`,
                        },
                    },
                });

                if (fallback === "lidarr" || fallback === "soulseek") {
                    const result = await simpleDownloadManager.startDownload(
                        jobId,
                        artistName,
                        albumTitle,
                        existingMetadata.albumMbid || "",
                        userId
                    );
                    if (!result.success) {
                        logger.error(`Fallback ${fallback} failed: ${result.error}`);
                    }
                    return;
                }
            }

            throw new Error(
                `Album not found on TIDAL: ${artistName} - ${albumTitle}`
            );
        }

        logger.debug(
            `[TIDAL] Found album: "${match.title}" by ${match.artist} (ID: ${match.albumId}, ${match.numberOfTracks} tracks)`
        );

        // Update status before download
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                metadata: {
                    ...existingMetadata,
                    currentSource: "tidal",
                    statusText: `Downloading ${match.numberOfTracks} tracks...`,
                    tidalAlbumId: match.albumId,
                },
            },
        });

        // Download the album — files go directly to /music
        const result = await tidalService.downloadAlbum(match.albumId);

        logger.debug(
            `[TIDAL] Download complete: ${result.downloaded}/${result.total_tracks} tracks`
        );

        if (result.downloaded === 0) {
            throw new Error(
                `All ${result.total_tracks} tracks failed to download`
            );
        }

        // Mark job as completed
        const statusText =
            result.failed > 0
                ? `${result.downloaded}/${result.total_tracks} tracks (${result.failed} failed)`
                : `${result.downloaded} tracks`;

        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status: "completed",
                completedAt: new Date(),
                metadata: {
                    ...existingMetadata,
                    currentSource: "tidal",
                    statusText: `TIDAL ✓ ${statusText}`,
                    tidalAlbumId: match.albumId,
                    tidalResult: {
                        downloaded: result.downloaded,
                        failed: result.failed,
                        totalTracks: result.total_tracks,
                    },
                },
            },
        });

        // Trigger a library scan so the backend picks up the new files
        const { scanQueue } = await import("../workers/queues");
        await scanQueue.add("scan", {
            userId,
            source: "tidal-download",
            artistName: result.artist,
            albumTitle: result.album_title,
        });

        logger.debug(
            `[TIDAL] Scan queued for: ${result.artist} - ${result.album_title}`
        );
    } catch (error: any) {
        logger.error(`[TIDAL] Download failed for job ${jobId}:`, error.message);

        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status: "failed",
                error: error.message,
                completedAt: new Date(),
                metadata: {
                    ...existingMetadata,
                    currentSource: "tidal",
                    statusText: "TIDAL failed",
                    failedAt: new Date().toISOString(),
                },
            },
        });
    }
}

// DELETE /downloads/clear-all - Clear all download jobs for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "clear-all" as an ID
router.delete("/clear-all", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { status } = req.query;

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }

        const result = await prisma.downloadJob.deleteMany({ where });

        logger.debug(
            ` Cleared ${result.count} download jobs for user ${userId}`
        );
        res.json({ success: true, deleted: result.count });
    } catch (error) {
        logger.error("Clear downloads error:", error);
        res.status(500).json({ error: "Failed to clear downloads" });
    }
});

// POST /downloads/clear-lidarr-queue - Clear stuck/failed items from Lidarr's queue
router.post("/clear-lidarr-queue", async (req, res) => {
    try {
        const result = await simpleDownloadManager.clearLidarrQueue();
        res.json({
            success: true,
            removed: result.removed,
            errors: result.errors,
        });
    } catch (error: any) {
        logger.error("Clear Lidarr queue error:", error);
        res.status(500).json({ error: "Failed to clear Lidarr queue" });
    }
});

// GET /downloads/failed - List failed/unavailable albums for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "failed" as an ID
router.get("/failed", async (req, res) => {
    try {
        const userId = req.user!.id;

        const failedAlbums = await prisma.unavailableAlbum.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        res.json(failedAlbums);
    } catch (error) {
        logger.error("List failed albums error:", error);
        res.status(500).json({ error: "Failed to list failed albums" });
    }
});

// DELETE /downloads/failed/:id - Dismiss a failed album notification
router.delete("/failed/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Verify ownership before deleting
        const failedAlbum = await prisma.unavailableAlbum.findFirst({
            where: { id, userId },
        });

        if (!failedAlbum) {
            return res.status(404).json({ error: "Failed album not found" });
        }

        await prisma.unavailableAlbum.delete({
            where: { id },
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Delete failed album error:", error);
        res.status(500).json({ error: "Failed to delete failed album" });
    }
});

// GET /downloads/releases/:albumMbid - Get available releases for an album (interactive search)
router.get("/releases/:albumMbid", async (req, res) => {
    try {
        const { albumMbid } = req.params;
        const artistName = String(req.query.artistName || "").trim();
        const albumTitle = String(req.query.albumTitle || "").trim();

        if (!albumMbid) {
            return res.status(400).json({ error: "Missing albumMbid parameter" });
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return res.status(400).json({ error: "Lidarr not configured" });
        }

        logger.debug(
            `[INTERACTIVE] Searching releases for ${albumTitle || albumMbid}`
        );

        let lidarrAlbumId: number | null = null;

        const searchResults = await lidarrService.searchAlbum(
            artistName,
            albumTitle,
            albumMbid
        );
        if (searchResults.length > 0) {
            const exactMatch = searchResults.find(
                (album) => album.foreignAlbumId === albumMbid
            );
            if (exactMatch) {
                lidarrAlbumId = exactMatch.id;
                logger.debug(
                    `[INTERACTIVE] Found album in Lidarr lookup: ${lidarrAlbumId}`
                );
            }
        }

        // If not already in Lidarr, try adding the artist and retry album lookup.
        if (!lidarrAlbumId && artistName) {
            let artistMbid: string | undefined;
            try {
                const releaseGroup =
                    await musicBrainzService.getReleaseGroup(albumMbid);
                artistMbid = releaseGroup?.["artist-credit"]?.[0]?.artist?.id;
            } catch (error) {
                logger.warn(
                    `[INTERACTIVE] Failed resolving artist MBID for ${albumMbid}:`,
                    error
                );
            }

            if (artistMbid) {
                const settings = await getSystemSettings();
                const baseMusicPath = settings?.musicPath || config.music.musicPath;

                const artist = await lidarrService.addArtist(
                    artistMbid,
                    artistName,
                    baseMusicPath,
                    false, // no auto-search
                    false // don't auto-monitor all albums
                );

                if (artist) {
                    const retryResults = await lidarrService.searchAlbum(
                        artistName,
                        albumTitle,
                        albumMbid
                    );
                    const retryMatch = retryResults.find(
                        (album) => album.foreignAlbumId === albumMbid
                    );
                    if (retryMatch) {
                        lidarrAlbumId = retryMatch.id;
                        logger.debug(
                            `[INTERACTIVE] Found album after artist add: ${lidarrAlbumId}`
                        );
                    }
                }
            }
        }

        if (!lidarrAlbumId) {
            return res.status(404).json({
                error: "Album not found in Lidarr",
                message:
                    "Could not find or add this album to Lidarr. The album may not be available in Lidarr metadata.",
            });
        }

        const releases = await lidarrService.getAlbumReleases(lidarrAlbumId);
        const formattedReleases = releases.map(mapInteractiveRelease);

        res.json({
            albumMbid,
            lidarrAlbumId,
            releases: formattedReleases,
            total: formattedReleases.length,
        });
    } catch (error: any) {
        logger.error("Get interactive releases error:", error);
        res.status(500).json({
            error: "Failed to fetch releases",
            message: error?.message,
        });
    }
});

// POST /downloads/grab - Grab a specific release from interactive search
router.post("/grab", async (req, res) => {
    try {
        const {
            guid,
            indexerId,
            albumMbid,
            lidarrAlbumId,
            artistName,
            albumTitle,
            title: releaseTitle,
        } = req.body;
        const userId = req.user!.id;
        const parsedLidarrAlbumId = Number(lidarrAlbumId);
        const normalizedAlbumMbid =
            typeof albumMbid === "string" ? albumMbid.trim() : "";

        if (!guid || !Number.isFinite(parsedLidarrAlbumId) || parsedLidarrAlbumId <= 0) {
            return res
                .status(400)
                .json({ error: "Missing required fields: guid, lidarrAlbumId" });
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return res.status(400).json({ error: "Lidarr not configured" });
        }

        const duplicateWhere: any = {
            userId,
            status: { in: ["pending", "processing"] },
            OR: [{ lidarrAlbumId: parsedLidarrAlbumId }],
        };

        if (normalizedAlbumMbid) {
            duplicateWhere.OR.push({ targetMbid: normalizedAlbumMbid });
        }

        const existingJob = await prisma.downloadJob.findFirst({
            where: duplicateWhere,
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true },
        });

        if (existingJob) {
            return res.json({
                success: true,
                duplicate: true,
                jobId: existingJob.id,
                message: "Download already in progress for this album",
            });
        }

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `${artistName || "Unknown"} - ${albumTitle || "Unknown"}`,
                type: "album",
                targetMbid:
                    normalizedAlbumMbid || `interactive:${parsedLidarrAlbumId}`,
                status: "processing",
                lidarrAlbumId: parsedLidarrAlbumId,
                metadata: {
                    downloadType: "library",
                    rootFolderPath: config.music.musicPath,
                    artistName,
                    albumTitle,
                    interactiveDownload: true,
                    selectedRelease: releaseTitle || guid,
                },
            },
        });

        const success = await lidarrService.grabRelease({
            guid,
            indexerId: Number(indexerId) || 0,
            title: releaseTitle || "",
            protocol: "torrent",
            approved: true,
            rejected: false,
        });

        if (!success) {
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    status: "failed",
                    error: "Failed to grab release from indexer",
                    completedAt: new Date(),
                },
            });
            return res.status(500).json({ error: "Failed to grab release" });
        }

        res.json({
            success: true,
            jobId: job.id,
            message: `Downloading "${albumTitle}" - release grabbed from indexer`,
        });
    } catch (error: any) {
        logger.error("Grab interactive release error:", error);
        res.status(500).json({
            error: "Failed to grab release",
            message: error?.message,
        });
    }
});

// GET /downloads/:id - Get download job status
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return res.status(404).json({ error: "Download job not found" });
        }

        res.json(job);
    } catch (error) {
        logger.error("Get download job error:", error);
        res.status(500).json({ error: "Failed to get download job" });
    }
});

// PATCH /downloads/:id - Update download job (e.g., mark as complete)
router.patch("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const { status } = req.body;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return res.status(404).json({ error: "Download job not found" });
        }

        const updated = await prisma.downloadJob.update({
            where: { id },
            data: {
                status: status || "completed",
                completedAt: status === "completed" ? new Date() : undefined,
            },
        });

        res.json(updated);
    } catch (error) {
        logger.error("Update download job error:", error);
        res.status(500).json({ error: "Failed to update download job" });
    }
});

// DELETE /downloads/:id - Delete download job
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Use deleteMany to handle race conditions gracefully
        // This won't throw an error if the record was already deleted
        const result = await prisma.downloadJob.deleteMany({
            where: {
                id,
                userId,
            },
        });

        // Return success even if nothing was deleted (idempotent delete)
        res.json({ success: true, deleted: result.count > 0 });
    } catch (error: any) {
        logger.error("Delete download job error:", error);
        logger.error("Error details:", error.message, error.stack);
        res.status(500).json({
            error: "Failed to delete download job",
            details: error.message,
        });
    }
});

// GET /downloads - List user's download jobs
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            status,
            limit = "50",
            includeDiscovery = "false",
            includeCleared = "false",
        } = req.query;

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }
        // Filter out cleared jobs by default (user dismissed from history)
        if (includeCleared !== "true") {
            where.cleared = false;
        }

        const jobs = await prisma.downloadJob.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: parseInt(limit as string, 10),
        });

        // Filter out discovery downloads unless explicitly requested
        // Discovery downloads are automated and shouldn't show in the UI popover
        const filteredJobs =
            includeDiscovery === "true"
                ? jobs
                : jobs.filter((job) => {
                      const metadata = job.metadata as any;
                      return metadata?.downloadType !== "discovery";
                  });

        res.json(filteredJobs);
    } catch (error) {
        logger.error("List download jobs error:", error);
        res.status(500).json({ error: "Failed to list download jobs" });
    }
});

// POST /downloads/keep-track - Keep a discovery track (move to permanent library)
router.post("/keep-track", async (req, res) => {
    try {
        const { discoveryTrackId } = req.body;
        const userId = req.user!.id;

        if (!discoveryTrackId) {
            return res.status(400).json({ error: "Missing discoveryTrackId" });
        }

        const discoveryTrack = await prisma.discoveryTrack.findUnique({
            where: { id: discoveryTrackId },
            include: {
                discoveryAlbum: true,
            },
        });

        if (!discoveryTrack) {
            return res.status(404).json({ error: "Discovery track not found" });
        }

        // Mark as kept
        await prisma.discoveryTrack.update({
            where: { id: discoveryTrackId },
            data: { userKept: true },
        });

        // If Lidarr enabled, create job to download full album to permanent library
        const lidarrEnabled = await lidarrService.isEnabled();
        if (lidarrEnabled) {
            const job = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject: `${discoveryTrack.discoveryAlbum.albumTitle} by ${discoveryTrack.discoveryAlbum.artistName}`,
                    type: "album",
                    targetMbid: discoveryTrack.discoveryAlbum.rgMbid,
                    status: "pending",
                },
            });

            return res.json({
                success: true,
                message:
                    "Track marked as kept. Full album will be downloaded to permanent library.",
                downloadJobId: job.id,
            });
        }

        res.json({
            success: true,
            message:
                "Track marked as kept. Please add the full album manually to your /music folder.",
        });
    } catch (error) {
        logger.error("Keep track error:", error);
        res.status(500).json({ error: "Failed to keep track" });
    }
});

export default router;
