import PQueue from "p-queue";
import { deezerService } from "../deezer";
import { notificationService } from "../notificationService";
import {
    normalizeString,
    normalizeTrackTitle,
    stringSimilarity,
    stripTrackSuffix,
    normalizeApostrophes,
} from "../../utils/trackMatching";
import {
    jobLoggers,
    MATCHABLE_TRACK_WHERE,
    saveImportJob,
    spotifyImportPrisma,
} from "./state";
import type { ImportJob } from "./types";
import { SpotifyImportPreviewService } from "./preview";

export class SpotifyImportPlaylistBuilderService extends SpotifyImportPreviewService {
    /**
     * Internal: Build the playlist with matched tracks
     */
    protected async buildPlaylist(job: ImportJob): Promise<void> {
        const logger = jobLoggers.get(job.id);

        job.status = "creating_playlist";
        job.progress = 90;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.logPlaylistCreationStart();
        logger?.logTrackMatchingStart();

        // Match all pending tracks against the library
        const matchedTrackIds: string[] = [];
        let trackIndex = 0;

        for (const pendingTrack of job.pendingTracks) {
            trackIndex++;

            // FAST PATH: If already matched in preview, use that ID directly
            // This ensures tracks found during preview are included in the final playlist
            if (pendingTrack.preMatchedTrackId) {
                // Verify the track still exists
                const existingTrack =
                    await spotifyImportPrisma.track.findUnique({
                        where: {
                            ...MATCHABLE_TRACK_WHERE,
                            id: pendingTrack.preMatchedTrackId,
                        },
                        select: { id: true, title: true },
                    });
                if (existingTrack) {
                    matchedTrackIds.push(existingTrack.id);
                    logger?.debug(
                        `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`,
                    );
                    logger?.logTrackMatch(
                        trackIndex,
                        job.tracksTotal,
                        pendingTrack.title,
                        pendingTrack.artist,
                        true,
                        existingTrack.id,
                    );
                    continue;
                }
            }

            const normalizedArtist = normalizeString(pendingTrack.artist);
            // Get first word for fuzzy artist matching (handles "Nick Cave & The Bad Seeds" -> "nick")
            const artistFirstWord = normalizedArtist.split(" ")[0];
            // Strip suffix but keep punctuation for DB queries: "Ain't Gonna Rain Anymore - 2011 Remaster" -> "Ain't Gonna Rain Anymore"
            const strippedTitle = stripTrackSuffix(pendingTrack.title);
            // Also normalize apostrophes in the original title for searching
            const normalizedTitle = normalizeApostrophes(pendingTrack.title);
            // Fully normalized for similarity comparison: "aint gonna rain anymore"
            const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

            logger?.log(
                `   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`,
            );
            logger?.log(
                `   strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`,
            );

            // Try multiple matching strategies
            let localTrack = null;

            // Strategy 1: Exact title match with fuzzy artist (contains first word)
            localTrack = await spotifyImportPrisma.track.findFirst({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    title: {
                        equals: normalizedTitle,
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
            });

            // Strategy 2: Stripped title match (removes remaster suffix but keeps punctuation)
            // "Ain't Gonna Rain Anymore - 2011 Remaster" -> searches for "Ain't Gonna Rain Anymore"
            if (!localTrack && strippedTitle !== normalizedTitle) {
                logger?.log(
                    `   Strategy 2: Searching for stripped title "${strippedTitle}"`,
                );
                localTrack = await spotifyImportPrisma.track.findFirst({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        title: {
                            equals: strippedTitle,
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                });
            }

            // Strategy 3: Case-insensitive CONTAINS search on title (handles slight variations)
            // e.g., database has "Ain't" but Spotify has "Ain't" (different apostrophe after normalization still differs)
            if (!localTrack && strippedTitle.length >= 5) {
                // Search for tracks where title contains the first few words
                const searchTerm = strippedTitle
                    .split(" ")
                    .slice(0, 4)
                    .join(" ");
                logger?.log(
                    `   Strategy 3: Contains search for "${searchTerm}"`,
                );
                const candidates = await spotifyImportPrisma.track.findMany({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        title: {
                            contains: searchTerm,
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    take: 10,
                });

                // Find best match using similarity OR containment
                for (const candidate of candidates) {
                    const candidateNormalized = normalizeTrackTitle(
                        candidate.title,
                    );
                    const sim = stringSimilarity(
                        cleanedTitle,
                        candidateNormalized,
                    );

                    // Direct similarity match
                    if (sim >= 80) {
                        localTrack = candidate;
                        logger?.log(
                            `      Found via contains+similarity (${sim.toFixed(
                                0,
                            )}%)`,
                        );
                        break;
                    }

                    // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
                    // Check if one title contains the other (normalized)
                    const spotifyNorm = cleanedTitle.toLowerCase();
                    const libraryNorm = candidateNormalized.toLowerCase();
                    if (
                        libraryNorm.startsWith(spotifyNorm) ||
                        spotifyNorm.startsWith(libraryNorm)
                    ) {
                        localTrack = candidate;
                        logger?.log(
                            `      Found via containment match: "${cleanedTitle}" in "${candidateNormalized}"`,
                        );
                        break;
                    }
                }
            }

            // Strategy 3.5: Same as preview - fuzzy match on artist NAME using similarity
            // This catches cases where normalizedName differs from what we expect
            if (!localTrack) {
                logger?.log(`   Strategy 3.5: Fuzzy artist+title matching`);
                const candidates = await spotifyImportPrisma.track.findMany({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: { album: { include: { artist: true } } },
                    take: 50,
                });

                // Use same matching as preview: compare cleaned titles
                for (const candidate of candidates) {
                    const titleSim = stringSimilarity(
                        cleanedTitle,
                        normalizeTrackTitle(candidate.title),
                    );
                    const artistSim = stringSimilarity(
                        pendingTrack.artist,
                        candidate.album.artist.name,
                    );
                    const score = titleSim * 0.6 + artistSim * 0.4;

                    if (score >= 70) {
                        localTrack = candidate;
                        logger?.debug(
                            `      (preview-style match: ${score.toFixed(0)}%)`,
                        );
                        break;
                    }
                }
            }

            // Strategy 4: StartsWith match with stripped title (for slight title variations)
            if (!localTrack && strippedTitle.length > 10) {
                logger?.log(`   Strategy 4: StartsWith search`);
                localTrack = await spotifyImportPrisma.track.findFirst({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        title: {
                            startsWith: strippedTitle.substring(
                                0,
                                Math.min(20, strippedTitle.length),
                            ),
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                });

                // Verify match
                if (localTrack) {
                    const dbTitleNormalized = normalizeTrackTitle(
                        localTrack.title,
                    );
                    if (
                        stringSimilarity(cleanedTitle, dbTitleNormalized) < 70
                    ) {
                        localTrack = null;
                    } else {
                        logger?.log(`      Found via startsWith`);
                    }
                }
            }

            // Strategy 5: Very fuzzy - search and score by similarity (last resort)
            if (!localTrack) {
                logger?.log(`   Strategy 5: Fuzzy search (last resort)`);
                // Get first few words for search
                const searchWords = strippedTitle
                    .split(" ")
                    .slice(0, 3)
                    .join(" ");
                if (searchWords.length >= 4) {
                    const candidates = await spotifyImportPrisma.track.findMany(
                        {
                            where: {
                                ...MATCHABLE_TRACK_WHERE,
                                title: {
                                    contains: searchWords.split(" ")[0], // Just first word
                                    mode: "insensitive",
                                },
                                album: {
                                    artist: {
                                        normalizedName: {
                                            contains: artistFirstWord,
                                            mode: "insensitive",
                                        },
                                    },
                                },
                            },
                            include: { album: { include: { artist: true } } },
                            take: 20,
                        },
                    );

                    // Find best match by similarity
                    let bestMatch = null;
                    let bestScore = 0;
                    for (const candidate of candidates) {
                        const titleScore = stringSimilarity(
                            cleanedTitle,
                            normalizeTrackTitle(candidate.title),
                        );
                        const artistScore = stringSimilarity(
                            normalizedArtist,
                            normalizeString(candidate.album.artist.name),
                        );
                        const combinedScore =
                            titleScore * 0.7 + artistScore * 0.3;

                        if (combinedScore > bestScore && combinedScore >= 65) {
                            bestScore = combinedScore;
                            bestMatch = candidate;
                        }
                    }

                    if (bestMatch) {
                        localTrack = bestMatch;
                        logger?.debug(
                            `      (fuzzy match: score ${bestScore.toFixed(
                                0,
                            )}% with "${bestMatch.title}" by ${
                                bestMatch.album.artist.name
                            })`,
                        );
                    }
                }
            }

            // Strategy 6: Title-only search (ignores artist entirely)
            // This handles cases where file has wrong artist metadata (e.g., "Various Artists" compilations)
            // Only used when title is distinctive enough (>10 chars) and no match found yet
            if (!localTrack && cleanedTitle.length >= 10) {
                logger?.log(
                    `   Strategy 6: Title-only search (fallback for wrong artist metadata)`,
                );

                // Search for tracks with very similar title, ignore artist completely
                const titleSearchTerm = strippedTitle
                    .split(" ")
                    .slice(0, 4)
                    .join(" ");
                const candidates = await spotifyImportPrisma.track.findMany({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        title: {
                            contains: titleSearchTerm,
                            mode: "insensitive",
                        },
                    },
                    include: { album: { include: { artist: true } } },
                    take: 50,
                });

                // Find a high-confidence title match (require 85%+ similarity on title alone)
                let bestTitleMatch = null;
                let bestTitleScore = 0;

                for (const candidate of candidates) {
                    const titleScore = stringSimilarity(
                        cleanedTitle,
                        normalizeTrackTitle(candidate.title),
                    );

                    // Require very high title match since we're ignoring artist
                    if (titleScore > bestTitleScore && titleScore >= 85) {
                        bestTitleScore = titleScore;
                        bestTitleMatch = candidate;
                    }
                }

                if (bestTitleMatch) {
                    localTrack = bestTitleMatch;
                    logger?.log(
                        `      Found via title-only match (${bestTitleScore.toFixed(
                            0,
                        )}%): "${bestTitleMatch.title}" by ${
                            bestTitleMatch.album.artist.name
                        }`,
                    );
                    logger?.debug(
                        `      (title-only match: ${bestTitleScore.toFixed(
                            0,
                        )}% - note: artist metadata mismatch, wanted "${
                            pendingTrack.artist
                        }" got "${bestTitleMatch.album.artist.name}")`,
                    );
                }
            }

            if (localTrack) {
                matchedTrackIds.push(localTrack.id);
                logger?.debug(
                    `   ✓ Matched: "${pendingTrack.title}" -> track ${localTrack.id}`,
                );
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    true,
                    localTrack.id,
                );
            } else {
                // Debug: Check if artist exists at all
                const artistExists = await spotifyImportPrisma.artist.findFirst(
                    {
                        where: {
                            normalizedName: {
                                contains: normalizedArtist.split(" ")[0],
                                mode: "insensitive",
                            },
                        },
                        select: { name: true, normalizedName: true },
                    },
                );
                if (artistExists) {
                    logger?.debug(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist "${artistExists.name}" exists but track not found)`,
                    );
                } else {
                    logger?.debug(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`,
                    );
                }
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    false,
                );
            }
        }

        const uniqueTrackIds = Array.from(new Set(matchedTrackIds));
        if (uniqueTrackIds.length < matchedTrackIds.length) {
            const removed = matchedTrackIds.length - uniqueTrackIds.length;
            logger?.debug(
                `   Removed ${removed} duplicate track references before playlist creation`,
            );
            logger?.info(
                `Removed ${removed} duplicate track references before playlist creation`,
            );
        }

        logger?.debug(
            `   Matched ${uniqueTrackIds.length}/${job.tracksTotal} tracks`,
        );
        logger?.info(
            `Matched tracks after scan: ${uniqueTrackIds.length}/${job.tracksTotal}`,
        );
        // Create the playlist with Spotify metadata
        const playlist = await spotifyImportPrisma.playlist.create({
            data: {
                userId: job.userId,
                name: job.playlistName,
                isPublic: false,
                spotifyPlaylistId: job.spotifyPlaylistId,
                items:
                    uniqueTrackIds.length > 0
                        ? {
                              create: uniqueTrackIds.map((trackId, index) => ({
                                  trackId,
                                  sort: index,
                              })),
                          }
                        : undefined,
            },
        });

        // Save unmatched tracks as pending tracks for later auto-matching
        const unmatchedTracks = job.pendingTracks.filter((_, index) => {
            // We need to track which indices were matched
            // Since matchedTrackIds doesn't preserve order, we need a different approach
            return true; // We'll recalculate below
        });

        // Recalculate unmatched - tracks that weren't added to playlist
        const matchedTitlesNormalized = new Set<string>();
        for (const pendingTrack of job.pendingTracks) {
            const normalizedArtist = normalizeString(pendingTrack.artist);
            const strippedTitle = stripTrackSuffix(pendingTrack.title);

            // Check if this track was matched by looking for it in the created items
            const found = await spotifyImportPrisma.track.findFirst({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    id: { in: uniqueTrackIds },
                    title: {
                        contains: strippedTitle.split(" ")[0],
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: normalizedArtist.split(" ")[0],
                                mode: "insensitive",
                            },
                        },
                    },
                },
            });

            if (found) {
                matchedTitlesNormalized.add(
                    `${normalizedArtist}|${strippedTitle.toLowerCase()}`,
                );
            }
        }

        // Save pending tracks that weren't matched
        const pendingTracksToSave = job.pendingTracks
            .map((track, index) => ({ ...track, originalIndex: index }))
            .filter((track) => {
                const normalizedArtist = normalizeString(track.artist);
                const strippedTitle = stripTrackSuffix(
                    track.title,
                ).toLowerCase();
                return !matchedTitlesNormalized.has(
                    `${normalizedArtist}|${strippedTitle}`,
                );
            });

        if (pendingTracksToSave.length > 0) {
            logger?.debug(
                `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`,
            );
            logger?.debug(
                `   Fetching Deezer preview URLs for pending tracks...`,
            );
            logger?.info(
                `Saving pending tracks: ${pendingTracksToSave.length}`,
            );

            // Fetch Deezer previews with concurrency limit to avoid overwhelming API
            const DEEZER_PREVIEW_CONCURRENCY = 5;
            const previewQueue = new PQueue({
                concurrency: DEEZER_PREVIEW_CONCURRENCY,
            });

            const pendingTracksWithPreviews = await Promise.all(
                pendingTracksToSave.map((track) =>
                    previewQueue.add(async () => {
                        let deezerPreviewUrl: string | null = null;
                        try {
                            deezerPreviewUrl =
                                await deezerService.getTrackPreview(
                                    track.artist,
                                    track.title,
                                );
                        } catch (e) {
                            // Preview not critical, continue without it
                        }
                        return {
                            ...track,
                            deezerPreviewUrl,
                        };
                    }),
                ),
            );

            const previewsFound = pendingTracksWithPreviews.filter(
                (t) => t.deezerPreviewUrl,
            ).length;
            logger?.debug(
                `   Found ${previewsFound}/${pendingTracksToSave.length} Deezer preview URLs`,
            );
            logger?.info(
                `Pending previews found: ${previewsFound}/${pendingTracksToSave.length}`,
            );

            await spotifyImportPrisma.playlistPendingTrack.createMany({
                data: pendingTracksWithPreviews.map((track) => ({
                    playlistId: playlist.id,
                    spotifyArtist: track.artist,
                    spotifyTitle: track.title,
                    spotifyAlbum: track.album,
                    albumMbid: track.albumMbid,
                    artistMbid: track.artistMbid,
                    deezerPreviewUrl: track.deezerPreviewUrl,
                    sort: track.originalIndex,
                })),
                skipDuplicates: true,
            });
        }

        job.createdPlaylistId = playlist.id;
        job.tracksMatched = uniqueTrackIds.length;
        job.status = "completed";
        job.progress = 100;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.debug(`[Spotify Import] Job ${job.id} completed:`);
        logger?.debug(`   Playlist created: ${playlist.id}`);
        logger?.debug(
            `   Tracks matched: ${matchedTrackIds.length}/${job.tracksTotal}`,
        );

        logger?.logPlaylistCreated(
            playlist.id,
            matchedTrackIds.length,
            job.tracksTotal,
        );
        logger?.logJobComplete(
            matchedTrackIds.length,
            job.tracksTotal,
            playlist.id,
        );

        // Send notification about import completion
        try {
            await notificationService.notifyImportComplete(
                job.userId,
                job.playlistName,
                playlist.id,
                matchedTrackIds.length,
                job.tracksTotal,
            );
        } catch (notifError) {
            logger?.error(`Failed to send import notification: ${notifError}`);
        }

        // Clean up job logger to prevent memory leak
        jobLoggers.delete(job.id);
    }
}
