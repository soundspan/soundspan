import { Artist } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { wikidataService } from "../services/wikidata";
import { lastFmService } from "../services/lastfm";
import { musicBrainzService } from "../services/musicbrainz";
import { normalizeArtistName } from "../utils/artistNormalization";
import { redisClient } from "../utils/redis";
import { downloadAndStoreImage, isNativePath } from "../services/imageStorage";
import { resolveAlbumCover } from "../services/metadata/albumCoverResolver";
import { resolveArtistImage } from "../services/metadata/artistImageResolver";
import { isRealArtistMbid } from "../utils/musicIds";

function isMbidUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { code?: unknown; message?: unknown };
    if (maybeError.code === "P2002") return true;
    if (typeof maybeError.message === "string") {
        return (
            maybeError.message.includes("Unique constraint failed") &&
            maybeError.message.includes("`mbid`")
        );
    }
    return false;
}

/**
 * Enriches an artist with metadata from Wikidata and Last.fm
 * - Fetches artist bio/summary and hero image from Wikidata
 * - Falls back to Last.fm if Wikidata fails
 * - Fetches similar artists from Last.fm
 */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    const logPrefix = `[ENRICH ${artist.name}]`;
    logger.debug(`${logPrefix} Starting enrichment (MBID: ${artist.mbid})`);

    // Mark as enriching
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });

    // Track which source provided data
    let imageSource = "none";
    let summarySource = "none";

    try {
        // If artist has a temp MBID, try to get the real one from MusicBrainz
        if (!isRealArtistMbid(artist.mbid)) {
            logger.debug(
                `${logPrefix} Temp MBID detected, searching MusicBrainz...`,
            );
            try {
                const mbResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1,
                );
                if (mbResults.length > 0 && isRealArtistMbid(mbResults[0].id)) {
                    const realMbid = mbResults[0].id;
                    logger.debug(
                        `${logPrefix} MusicBrainz: Found real MBID: ${realMbid}`,
                    );

                    const existingArtist = await prisma.artist.findUnique({
                        where: { mbid: realMbid },
                        select: { id: true },
                    });
                    if (existingArtist && existingArtist.id !== artist.id) {
                        logger.debug(
                            `${logPrefix} MusicBrainz: MBID ${realMbid} already exists on another artist, skipping DB MBID update`,
                        );
                    } else {
                        // Update artist with real MBID. If a concurrent writer claims
                        // it between lookup and update, swallow unique conflicts.
                        try {
                            await prisma.artist.update({
                                where: { id: artist.id },
                                data: { mbid: realMbid },
                            });
                        } catch (updateError) {
                            if (isMbidUniqueConstraintError(updateError)) {
                                logger.debug(
                                    `${logPrefix} MusicBrainz: MBID ${realMbid} was claimed concurrently, skipping DB MBID update`,
                                );
                            } else {
                                throw updateError;
                            }
                        }
                    }

                    // Update the local artist object for downstream lookups.
                    artist.mbid = realMbid;
                } else {
                    logger.debug(
                        `${logPrefix} MusicBrainz: No match found, keeping temp MBID`,
                    );
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} MusicBrainz: FAILED - ${
                        error?.message || error
                    }`,
                );
            }
        }

        // Try Wikidata first (only if we have a real MBID)
        let summary = null;
        let heroUrl = null;
        let genres: string[] = [];

        if (isRealArtistMbid(artist.mbid)) {
            logger.debug(
                `${logPrefix} Wikidata: Fetching for MBID ${artist.mbid}...`,
            );
            try {
                const wikidataInfo = await wikidataService.getArtistInfo(
                    artist.name,
                    artist.mbid,
                );
                if (wikidataInfo) {
                    summary = wikidataInfo.summary;
                    if (summary) summarySource = "wikidata";
                    logger.debug(
                        `${logPrefix} Wikidata: SUCCESS (summary: ${summary ? "yes" : "no"})`,
                    );
                } else {
                    logger.debug(`${logPrefix} Wikidata: No data returned`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Wikidata: FAILED - ${error?.message || error}`,
                );
            }
        } else {
            logger.debug(`${logPrefix} Wikidata: Skipped (temp MBID)`);
        }

        // Fetch from Last.fm if we need summary or genres.
        if (!summary || genres.length === 0) {
            logger.debug(
                `${logPrefix} Last.fm: Fetching (need summary: ${!summary})...`,
            );
            try {
                const validMbid = isRealArtistMbid(artist.mbid)
                    ? artist.mbid
                    : undefined;
                const lastfmInfo = await lastFmService.getArtistInfo(
                    artist.name,
                    validMbid,
                );
                if (lastfmInfo) {
                    // Extract text from bio object (bio.summary or bio.content)
                    if (!summary && lastfmInfo.bio) {
                        const bio = lastfmInfo.bio as any;
                        summary = bio.summary || bio.content || null;
                        if (summary) {
                            summarySource = "lastfm";
                            logger.debug(`${logPrefix} Last.fm: Got summary`);
                        }
                    }

                    // Extract genres from Last.fm tags
                    if (
                        lastfmInfo.tags?.tag &&
                        Array.isArray(lastfmInfo.tags.tag)
                    ) {
                        genres = lastfmInfo.tags.tag
                            .slice(0, 5) // Top 5 tags as genres
                            .map((t: any) => t.name)
                            .filter(Boolean);
                        if (genres.length > 0) {
                            logger.debug(
                                `${logPrefix} Extracted ${genres.length} genres: ${genres.join(", ")}`,
                            );
                        }
                    }
                } else {
                    logger.debug(`${logPrefix} Last.fm: No data returned`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Last.fm: FAILED - ${error?.message || error}`,
                );
            }
        }

        try {
            const image = await resolveArtistImage({
                artistName: artist.name,
                mbid: artist.mbid,
            });
            heroUrl = image?.url ?? null;
            imageSource = image?.source ?? "none";
        } catch (error) {
            logger.debug(`${logPrefix} Artist image resolution failed`, error);
        }

        // Get similar artists from Last.fm
        let similarArtists: Array<{
            name: string;
            mbid?: string;
            match: number;
        }> = [];
        try {
            // Filter out temp MBIDs
            const validMbid = isRealArtistMbid(artist.mbid) ? artist.mbid : "";
            similarArtists = await lastFmService.getSimilarArtists(
                validMbid,
                artist.name,
            );
            logger.debug(
                `${logPrefix} Similar artists: Found ${similarArtists.length}`,
            );
        } catch (error: any) {
            logger.debug(
                `${logPrefix} Similar artists: FAILED - ${
                    error?.message || error
                }`,
            );
        }

        // Log enrichment summary
        logger.debug(
            `${logPrefix} SUMMARY: image=${imageSource}, summary=${summarySource}, heroUrl=${
                heroUrl ? "set" : "null"
            }`,
        );

        // Download image locally if we have an external URL
        let localHeroUrl: string | null = null;
        if (heroUrl && !isNativePath(heroUrl)) {
            logger.debug(`${logPrefix} Downloading image locally...`);
            localHeroUrl = await downloadAndStoreImage(
                heroUrl,
                artist.id,
                "artist",
            );
            if (localHeroUrl) {
                logger.debug(
                    `${logPrefix} Image saved locally: ${localHeroUrl}`,
                );
            } else {
                logger.debug(
                    `${logPrefix} Failed to download image, keeping external URL`,
                );
                localHeroUrl = heroUrl; // Fallback to external URL if download fails
            }
        } else if (heroUrl) {
            localHeroUrl = heroUrl; // Already a native path
        }

        // Prepare similar artists JSON for storage (full Last.fm data)
        const similarArtistsJson: any =
            similarArtists.length > 0
                ? similarArtists.map((s) => ({
                      name: s.name,
                      mbid: s.mbid || null,
                      match: s.match,
                  }))
                : null;

        // Update artist with enriched data
        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                summary,
                heroUrl: localHeroUrl,
                similarArtistsJson,
                genres: genres.length > 0 ? genres : undefined,
                lastEnriched: new Date(),
                enrichmentStatus: "completed",
            },
        });

        // Store similar artists
        if (similarArtists.length > 0) {
            // Delete existing similar artist relationships
            await prisma.similarArtist.deleteMany({
                where: { fromArtistId: artist.id },
            });

            // Create new relationships
            for (const similar of similarArtists) {
                // Find existing similar artist (don't create new ones)
                let similarArtistRecord = null;

                if (similar.mbid) {
                    // Try to find by MBID first
                    similarArtistRecord = await prisma.artist.findUnique({
                        where: { mbid: similar.mbid },
                    });
                }

                if (!similarArtistRecord) {
                    // Try to find by normalized name (case-insensitive)
                    const normalizedSimilarName = normalizeArtistName(
                        similar.name,
                    );
                    similarArtistRecord = await prisma.artist.findFirst({
                        where: { normalizedName: normalizedSimilarName },
                    });
                }

                // Only create similarity relationship if the similar artist already exists in our database
                // This prevents endless crawling of similar artists
                if (similarArtistRecord) {
                    await prisma.similarArtist.upsert({
                        where: {
                            fromArtistId_toArtistId: {
                                fromArtistId: artist.id,
                                toArtistId: similarArtistRecord.id,
                            },
                        },
                        create: {
                            fromArtistId: artist.id,
                            toArtistId: similarArtistRecord.id,
                            weight: similar.match,
                        },
                        update: {
                            weight: similar.match,
                        },
                    });
                }
            }

            logger.debug(
                `${logPrefix} Stored ${similarArtists.length} similar artist relationships`,
            );
        }

        // Fetch covers for all albums belonging to this artist that don't have covers yet
        await enrichAlbumCovers(artist.id, localHeroUrl);

        // Cache artist image path in Redis for faster access
        if (localHeroUrl) {
            try {
                await redisClient.setEx(
                    `hero:${artist.id}`,
                    7 * 24 * 60 * 60,
                    localHeroUrl,
                );
            } catch (err) {
                // Redis errors are non-critical
            }
        }
    } catch (error: any) {
        logger.error(
            `${logPrefix} ENRICHMENT FAILED:`,
            error?.message || error,
        );

        // Mark as failed
        await prisma.artist.update({
            where: { id: artist.id },
            data: { enrichmentStatus: "failed" },
        });

        throw error;
    }
}

/**
 * Enrich album covers for an artist
 * Resolves covers through the canonical provider ladder for albums without covers
 */
async function enrichAlbumCovers(
    artistId: string,
    artistHeroUrl: string | null,
): Promise<void> {
    try {
        // Find albums for this artist that don't have cover art
        const albumsWithoutCovers = await prisma.album.findMany({
            where: {
                artistId,
                OR: [{ coverUrl: null }, { coverUrl: "" }],
                location: { not: "FEDERATED" },
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                artist: { select: { name: true } },
            },
        });

        if (albumsWithoutCovers.length === 0) {
            logger.debug(`    All albums already have covers`);
            return;
        }

        logger.debug(
            `    Fetching covers for ${albumsWithoutCovers.length} albums...`,
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3; // Limit concurrent requests

        // Process in batches to avoid overwhelming cover providers
        for (let i = 0; i < albumsWithoutCovers.length; i += BATCH_SIZE) {
            const batch = albumsWithoutCovers.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    if (album.rgMbid?.startsWith("federation:")) {
                        return;
                    }

                    try {
                        const resolution = await resolveAlbumCover({
                            artistName: album.artist.name,
                            albumTitle: album.title,
                            rgMbid: album.rgMbid,
                        });
                        const coverUrl = resolution?.url;

                        if (coverUrl) {
                            // Save to database
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl },
                            });

                            // Cache in Redis
                            try {
                                await redisClient.setEx(
                                    `album-cover:${album.id}`,
                                    30 * 24 * 60 * 60, // 30 days
                                    coverUrl,
                                );
                            } catch (err) {
                                // Redis errors are non-critical
                            }

                            fetchedCount++;
                        }
                    } catch (err) {
                        // Cover art fetch failed, continue with next album
                        logger.debug(
                            `      No cover found for: ${album.title}`,
                        );
                    }
                }),
            );
        }

        logger.debug(
            `    Fetched ${fetchedCount}/${albumsWithoutCovers.length} album covers`,
        );
    } catch (error) {
        logger.error(`    Failed to enrich album covers:`, error);
        // Don't throw - album cover failures shouldn't fail the entire enrichment
    }
}
