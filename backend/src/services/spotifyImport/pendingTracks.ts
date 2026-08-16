import { logger } from "../../utils/logger";
import {
    normalizeString,
    normalizeTrackTitle,
    stringSimilarity,
    stripTrackSuffix,
} from "../../utils/trackMatching";
import { MATCHABLE_TRACK_WHERE, spotifyImportPrisma } from "./state";
import { SpotifyImportJobManagementService } from "./jobManagement";

export class SpotifyImportPendingTrackService extends SpotifyImportJobManagementService {
    /**
     * Reconcile pending tracks for ALL playlists after a library scan
     * This checks if any previously unmatched tracks now have matches in the library
     * and automatically adds them to their playlists
     */
    async reconcilePendingTracks(): Promise<{
        playlistsUpdated: number;
        tracksAdded: number;
    }> {
        logger?.debug(
            `\n[Spotify Import] Reconciling pending tracks across all playlists...`,
        );

        // Get all pending tracks grouped by playlist
        const allPendingTracks =
            await spotifyImportPrisma.playlistPendingTrack.findMany({
                include: {
                    playlist: {
                        select: {
                            id: true,
                            name: true,
                            userId: true,
                        },
                    },
                },
                orderBy: [{ playlistId: "asc" }, { sort: "asc" }],
            });

        if (allPendingTracks.length === 0) {
            logger?.debug(`   No pending tracks to reconcile`);
            return { playlistsUpdated: 0, tracksAdded: 0 };
        }

        logger?.debug(
            `   Found ${allPendingTracks.length} pending tracks across playlists`,
        );

        let totalTracksAdded = 0;
        const playlistsWithAdditions = new Set<string>();
        const matchedPendingTrackIds: string[] = [];

        // Group by playlist for efficient processing
        const tracksByPlaylist = new Map<string, typeof allPendingTracks>();
        for (const pt of allPendingTracks) {
            const existing = tracksByPlaylist.get(pt.playlistId) || [];
            existing.push(pt);
            tracksByPlaylist.set(pt.playlistId, existing);
        }

        for (const [playlistId, pendingTracks] of tracksByPlaylist) {
            // Get current max sort position in playlist
            const maxSortResult =
                await spotifyImportPrisma.playlistItem.aggregate({
                    where: { playlistId },
                    _max: { sort: true },
                });
            let nextSort = (maxSortResult._max.sort ?? -1) + 1;

            // Get existing track IDs in playlist to avoid duplicates
            const existingItems =
                await spotifyImportPrisma.playlistItem.findMany({
                    where: { playlistId },
                    select: { trackId: true },
                });
            const existingTrackIds = new Set(
                existingItems.map((item) => item.trackId),
            );

            for (const pendingTrack of pendingTracks) {
                const normalizedArtist = normalizeString(
                    pendingTrack.spotifyArtist,
                );
                const artistFirstWord = normalizedArtist.split(" ")[0];
                const strippedTitle = stripTrackSuffix(
                    pendingTrack.spotifyTitle,
                );
                const cleanedTitle = normalizeTrackTitle(strippedTitle);

                logger?.debug(
                    `   Trying to match: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`,
                );
                logger?.debug(
                    `      strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`,
                );

                // Debug: Check what tracks exist for this artist
                const artistTracks = await spotifyImportPrisma.track.findMany({
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
                    select: {
                        title: true,
                        album: {
                            select: {
                                artist: {
                                    select: {
                                        name: true,
                                        normalizedName: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 5,
                });
                if (artistTracks.length > 0) {
                    logger?.debug(
                        `      DEBUG: Found ${artistTracks.length}+ tracks for artist containing "${artistFirstWord}"`,
                    );
                    artistTracks
                        .slice(0, 3)
                        .forEach((t) =>
                            logger?.debug(
                                `         - "${t.title}" (artist: ${t.album.artist.name}, normalized: ${t.album.artist.normalizedName})`,
                            ),
                        );
                } else {
                    logger?.debug(
                        `      DEBUG: NO tracks found for artist containing "${artistFirstWord}"`,
                    );
                }

                // Try to find a matching track (using same strategies as buildPlaylist)
                // Strategy 1: Stripped title + fuzzy artist (contains first word)
                let localTrack = await spotifyImportPrisma.track.findFirst({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        title: { equals: strippedTitle, mode: "insensitive" },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    select: { id: true, title: true },
                });

                logger?.debug(
                    `      Strategy 1 result: ${
                        localTrack ? "FOUND" : "not found"
                    }`,
                );

                // Strategy 2: Contains search on first few words + similarity
                if (!localTrack && strippedTitle.length >= 5) {
                    const searchTerm = strippedTitle
                        .split(" ")
                        .slice(0, 4)
                        .join(" ");
                    logger?.debug(
                        `      Strategy 2: Contains search for "${searchTerm}"`,
                    );
                    const candidates = await spotifyImportPrisma.track.findMany(
                        {
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
                            include: { album: { include: { artist: true } } },
                            take: 10,
                        },
                    );

                    logger?.debug(
                        `      Strategy 2: Found ${candidates.length} candidates`,
                    );
                    for (const candidate of candidates) {
                        const candidateNormalized = normalizeTrackTitle(
                            candidate.title,
                        );
                        const sim = stringSimilarity(
                            cleanedTitle,
                            candidateNormalized,
                        );
                        logger?.debug(
                            `         "${candidate.title}" by ${
                                candidate.album.artist.name
                            }: ${sim.toFixed(0)}%`,
                        );

                        // Direct similarity match
                        if (sim >= 80) {
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }

                        // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
                        const spotifyNorm = cleanedTitle.toLowerCase();
                        const libraryNorm = candidateNormalized.toLowerCase();
                        if (
                            libraryNorm.startsWith(spotifyNorm) ||
                            spotifyNorm.startsWith(libraryNorm)
                        ) {
                            logger?.debug(
                                `         Found via containment: "${cleanedTitle}" starts "${candidateNormalized}"`,
                            );
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }
                    }
                }

                if (!localTrack)
                    logger?.debug(`      Strategy 2 result: not found`);

                // Strategy 3: Fuzzy match on title + artist similarity
                if (!localTrack) {
                    const firstWord = strippedTitle.split(" ")[0];
                    logger?.debug(
                        `      Strategy 3: Fuzzy search for title containing "${firstWord}" and artist containing "${artistFirstWord}"`,
                    );
                    const candidates = await spotifyImportPrisma.track.findMany(
                        {
                            where: {
                                ...MATCHABLE_TRACK_WHERE,
                                title: {
                                    contains: firstWord,
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

                    logger?.debug(
                        `      Strategy 3: Found ${candidates.length} candidates`,
                    );
                    for (const candidate of candidates) {
                        const titleScore = stringSimilarity(
                            cleanedTitle,
                            normalizeTrackTitle(candidate.title),
                        );
                        const artistScore = stringSimilarity(
                            pendingTrack.spotifyArtist,
                            candidate.album.artist.name,
                        );
                        const combinedScore =
                            titleScore * 0.6 + artistScore * 0.4;
                        logger?.debug(
                            `         "${candidate.title}" by ${
                                candidate.album.artist.name
                            }: title=${titleScore.toFixed(
                                0,
                            )}%, artist=${artistScore.toFixed(
                                0,
                            )}%, combined=${combinedScore.toFixed(0)}%`,
                        );

                        if (combinedScore >= 70) {
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }
                    }
                }

                // Strategy 4: Title-only match with artist scoring (for compilations / Various Artists)
                if (!localTrack) {
                    logger?.debug(
                        `      Strategy 4: Title-only match for "${strippedTitle}" (compilation fallback)`,
                    );
                    const candidates = await spotifyImportPrisma.track.findMany(
                        {
                            where: {
                                ...MATCHABLE_TRACK_WHERE,
                                title: {
                                    equals: strippedTitle,
                                    mode: "insensitive",
                                },
                            },
                            include: { album: { include: { artist: true } } },
                            take: 10,
                        },
                    );

                    if (candidates.length > 0) {
                        // Score by artist name similarity, pick best match
                        const scored = candidates.map((c) => ({
                            candidate: c,
                            score: stringSimilarity(
                                pendingTrack.spotifyArtist,
                                c.album.artist.name,
                            ),
                        }));
                        scored.sort((a, b) => b.score - a.score);

                        const best = scored[0];
                        logger?.debug(
                            `      Strategy 4: Best match "${best.candidate.title}" by ${best.candidate.album.artist.name} (artist score: ${best.score.toFixed(0)}%)`,
                        );

                        // Accept if artist similarity is reasonable (>= 40%) or if there's only one candidate
                        if (best.score >= 40 || candidates.length === 1) {
                            localTrack = {
                                id: best.candidate.id,
                                title: best.candidate.title,
                            };
                        }
                    }
                }

                if (localTrack && !existingTrackIds.has(localTrack.id)) {
                    // Add to playlist
                    await spotifyImportPrisma.playlistItem.create({
                        data: {
                            playlistId,
                            trackId: localTrack.id,
                            sort: nextSort++,
                        },
                    });

                    existingTrackIds.add(localTrack.id);
                    matchedPendingTrackIds.push(pendingTrack.id);
                    totalTracksAdded++;
                    playlistsWithAdditions.add(playlistId);

                    logger?.debug(
                        `   ✓ Matched: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`,
                    );
                }
            }
        }

        // Delete the matched pending tracks
        if (matchedPendingTrackIds.length > 0) {
            await spotifyImportPrisma.playlistPendingTrack.deleteMany({
                where: { id: { in: matchedPendingTrackIds } },
            });
        }

        // Send notifications for each playlist that was updated
        if (playlistsWithAdditions.size > 0) {
            const { notificationService } =
                await import("../notificationService");

            for (const playlistId of playlistsWithAdditions) {
                const playlist = await spotifyImportPrisma.playlist.findUnique({
                    where: { id: playlistId },
                    select: { id: true, name: true, userId: true },
                });

                if (playlist) {
                    const tracksAddedToPlaylist = matchedPendingTrackIds.filter(
                        (id) =>
                            allPendingTracks.find(
                                (pt) =>
                                    pt.id === id &&
                                    pt.playlistId === playlistId,
                            ),
                    ).length;

                    await notificationService.create({
                        userId: playlist.userId,
                        type: "playlist_ready",
                        title: "Playlist Updated",
                        message: `${tracksAddedToPlaylist} new track${
                            tracksAddedToPlaylist !== 1 ? "s" : ""
                        } added to "${playlist.name}"`,
                        metadata: {
                            playlistId: playlist.id,
                            tracksAdded: tracksAddedToPlaylist,
                        },
                    });
                }
            }
        }

        logger?.debug(
            `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsWithAdditions.size} playlists`,
        );

        return {
            playlistsUpdated: playlistsWithAdditions.size,
            tracksAdded: totalTracksAdded,
        };
    }

    /**
     * Get pending tracks count for a playlist
     */
    async getPendingTracksCount(playlistId: string): Promise<number> {
        return spotifyImportPrisma.playlistPendingTrack.count({
            where: { playlistId },
        });
    }

    /**
     * Get pending tracks for a playlist
     */
    async getPendingTracks(playlistId: string): Promise<
        Array<{
            id: string;
            artist: string;
            title: string;
            album: string;
        }>
    > {
        const tracks = await spotifyImportPrisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        return tracks.map((t) => ({
            id: t.id,
            artist: t.spotifyArtist,
            title: t.spotifyTitle,
            album: t.spotifyAlbum,
        }));
    }
}
