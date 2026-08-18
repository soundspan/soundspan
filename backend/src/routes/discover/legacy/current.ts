import type { Request, Response } from "express";
import { endOfWeek, startOfWeek } from "date-fns";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { TRACK_VISIBLE_WHERE } from "../../../utils/librarySorting";
import { buildDiscoveryTrackPayload } from "../../discoverTrackPayload";
import { sendCurrentPlaylistFailure } from "../shared";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

/** Handles the frozen legacy current discovery playlist. */
export async function handleLegacyCurrent(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
        const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 }); // Sunday

        // Get all discovery albums for this week with their tracks
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            include: {
                tracks: true, // DiscoveryTrack records (trackId is just a string, not a relation)
            },
            orderBy: { downloadedAt: "asc" },
        });

        // Get unavailable albums for this week (show full replacement chain)
        const unavailableAlbums = await prisma.unavailableAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
            },
            orderBy: [
                { originalAlbumId: "asc" }, // Group by original album
                { attemptNumber: "asc" }, // Then sort by attempt number
            ],
        });

        // Build track list from DiscoveryTrack records (the actual selected tracks)
        const tracks = [];

        for (const discoveryAlbum of discoveryAlbums) {
            // If we have DiscoveryTrack records, use them (the actual selected tracks)
            if (discoveryAlbum.tracks && discoveryAlbum.tracks.length > 0) {
                // Fetch all tracks in one query using their IDs
                const trackIds = discoveryAlbum.tracks
                    .map((dt) => dt.trackId)
                    .filter((id): id is string => id !== null);

                if (trackIds.length > 0) {
                    const libraryTracks = await prisma.track.findMany({
                        where: {
                            ...TRACK_VISIBLE_WHERE,
                            id: { in: trackIds },
                        },
                        include: { album: { include: { artist: true } } },
                    });

                    // Create a map for quick lookup
                    const trackMap = new Map(
                        libraryTracks.map((t) => [t.id, t]),
                    );

                    for (const dt of discoveryAlbum.tracks) {
                        const track = dt.trackId
                            ? trackMap.get(dt.trackId)
                            : null;
                        if (track) {
                            tracks.push(
                                buildDiscoveryTrackPayload(
                                    discoveryAlbum,
                                    track,
                                    {
                                        artistId:
                                            track.album?.artist?.id ?? null,
                                        coverUrl: track.album?.coverUrl,
                                        albumLoudnessLufs:
                                            track.album.albumLoudnessLufs,
                                        albumTruePeakDb:
                                            track.album.albumTruePeakDb,
                                    },
                                ),
                            );
                        }
                    }
                }
            }

            // Fallback: No DiscoveryTrack records or no valid trackIds, find ONE track from library
            if (
                tracks.filter((t) => t.album === discoveryAlbum.albumTitle)
                    .length === 0
            ) {
                const album = await prisma.album.findFirst({
                    where: {
                        title: discoveryAlbum.albumTitle,
                        artist: { name: discoveryAlbum.artistName },
                    },
                    include: {
                        artist: true,
                        tracks: {
                            where: TRACK_VISIBLE_WHERE,
                            take: 1,
                            orderBy: { trackNo: "asc" },
                        },
                    },
                });

                if (album && album.tracks.length > 0) {
                    const track = album.tracks[0];
                    tracks.push(
                        buildDiscoveryTrackPayload(discoveryAlbum, track, {
                            artistId: album.artist?.id ?? null,
                            coverUrl: album.coverUrl,
                            albumLoudnessLufs: album.albumLoudnessLufs,
                            albumTruePeakDb: album.albumTruePeakDb,
                        }),
                    );
                } else {
                    // Album not in library yet (downloading/pending)
                    tracks.push({
                        id: `pending-${discoveryAlbum.id}`,
                        title: `${discoveryAlbum.albumTitle} (pending import)`,
                        artist: discoveryAlbum.artistName,
                        artistId: null,
                        album: discoveryAlbum.albumTitle,
                        albumId: discoveryAlbum.rgMbid,
                        isLiked: discoveryAlbum.status === "LIKED",
                        likedAt: discoveryAlbum.likedAt,
                        similarity: discoveryAlbum.similarity,
                        tier: discoveryAlbum.tier,
                        coverUrl: null,
                        available: false,
                        isPending: true,
                        duration: 0,
                    });
                }
            }
        }

        // Get the list of successfully downloaded album MBIDs from discoveryAlbums
        const successfulMbids = new Set(discoveryAlbums.map((da) => da.rgMbid));

        // Filter unavailable albums:
        // 1. Remove albums that successfully downloaded (have DiscoveryAlbum record)
        // 2. Remove albums that the user now owns (in Album table)
        const filteredUnavailable: typeof unavailableAlbums = [];
        for (const album of unavailableAlbums) {
            // Skip if this album successfully downloaded this week
            if (successfulMbids.has(album.albumMbid)) {
                continue;
            }

            // Skip if album exists in user's library by artist+title (normalized match)
            const normalizedArtist = album.artistName.toLowerCase().trim();
            const normalizedAlbum = album.albumTitle
                .toLowerCase()
                .replace(/\(.*?\)/g, "") // Remove parenthetical content
                .replace(/\[.*?\]/g, "") // Remove bracketed content
                .trim();

            const existsInLibrary = await prisma.album.findFirst({
                where: {
                    OR: [
                        { rgMbid: album.albumMbid },
                        {
                            title: {
                                contains: normalizedAlbum,
                                mode: "insensitive",
                            },
                            artist: {
                                name: {
                                    contains: normalizedArtist,
                                    mode: "insensitive",
                                },
                            },
                        },
                    ],
                },
            });

            if (existsInLibrary) {
                continue; // User already owns this album, don't show as unavailable
            }

            filteredUnavailable.push(album);
        }

        // Format unavailable albums
        const unavailable = filteredUnavailable.map((album) => ({
            id: `unavailable-${album.id}`,
            title: album.albumTitle,
            artist: album.artistName,
            album: album.albumTitle,
            albumId: album.albumMbid,
            similarity: album.similarity,
            tier: album.tier,
            previewUrl: album.previewUrl,
            deezerTrackId: album.deezerTrackId,
            deezerAlbumId: album.deezerAlbumId,
            attemptNumber: album.attemptNumber,
            originalAlbumId: album.originalAlbumId,
            available: false,
        }));

        try {
            logger.debug(`\nDiscover Weekly API Response:`);
            logger.debug(`  Total tracks: ${tracks.length}`);
            logger.debug(`  Unavailable albums: ${unavailable.length}`);
            if (unavailable.length > 0 && unavailable.length <= 20) {
                logger.debug(`  Unavailable albums with previews:`);
                unavailable.slice(0, 5).forEach((album, i) => {
                    logger.debug(
                        `    ${i + 1}. ${album.artist} - ${album.album} [${
                            album.previewUrl ? "HAS PREVIEW" : "NO PREVIEW"
                        }]`,
                    );
                });
                if (unavailable.length > 5) {
                    logger.debug(`    ... and ${unavailable.length - 5} more`);
                }
            }
        } catch (err) {
            logger.error("Error logging discover response:", err);
        }

        res.json({
            weekStart,
            weekEnd,
            tracks,
            unavailable,
            totalCount: tracks.length,
            unavailableCount: unavailable.length,
        });
    } catch (error) {
        sendCurrentPlaylistFailure(res, error);
    }
}
