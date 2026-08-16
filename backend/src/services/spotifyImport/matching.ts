import type { SpotifyTrack } from "../spotify";
import { logger } from "../../utils/logger";
import { musicBrainzService } from "../musicbrainz";
import { extractPrimaryArtist } from "../../utils/artistNormalization";
import {
    normalizeString,
    normalizeTrackTitle,
    normalizeAlbumForMatching,
    stringSimilarity,
    stripTrackSuffix,
} from "../../utils/trackMatching";
import { MATCHABLE_TRACK_WHERE, spotifyImportPrisma } from "./state";
import type { MatchedTrack } from "./types";

export class SpotifyImportMatchingService {
    /**
     * Match a Spotify track to the local library
     *
     * Matching strategies (in order):
     * 1. Exact match: artist + album + title (case-insensitive)
     * 2. Normalized album match: artist + normalized album + title
     * 3. Artist + title only: for "Unknown Album" or when album match fails
     * 4. Fuzzy match: similarity-based matching across all tracks by artist
     */
    protected async matchTrack(
        spotifyTrack: SpotifyTrack,
    ): Promise<MatchedTrack> {
        const normalizedTitle = normalizeString(spotifyTrack.title);
        const normalizedArtist = normalizeString(spotifyTrack.artist);
        const cleanedTrackTitle = normalizeTrackTitle(spotifyTrack.title);

        // Extract primary artist for better matching (handles "Artist feat. Someone")
        const primaryArtist = extractPrimaryArtist(spotifyTrack.artist);
        const normalizedPrimaryArtist = normalizeString(primaryArtist);

        // Normalize album title (strip edition/remaster suffixes)
        const cleanedAlbum = normalizeAlbumForMatching(spotifyTrack.album);
        const isUnknownAlbum =
            spotifyTrack.album === "Unknown Album" || !spotifyTrack.album;

        // Strategy 1: Exact match by primary artist + album + title
        let exactMatch = await spotifyImportPrisma.track.findFirst({
            where: {
                ...MATCHABLE_TRACK_WHERE,
                album: {
                    artist: {
                        normalizedName: normalizedPrimaryArtist,
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.album,
                    },
                },
                title: {
                    mode: "insensitive",
                    equals: spotifyTrack.title,
                },
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        // Strategy 1b: Try with full artist name if primary artist didn't match
        if (!exactMatch && primaryArtist !== spotifyTrack.artist) {
            exactMatch = await spotifyImportPrisma.track.findFirst({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    album: {
                        artist: {
                            normalizedName: normalizedArtist,
                        },
                        title: {
                            mode: "insensitive",
                            equals: spotifyTrack.album,
                        },
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.title,
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
            });
        }

        if (exactMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: exactMatch.id,
                    title: exactMatch.title,
                    albumId: exactMatch.albumId,
                    albumTitle: exactMatch.album.title,
                    artistName: exactMatch.album.artist.name,
                },
                matchType: "exact",
                matchConfidence: 100,
            };
        }

        // Strategy 2: Normalized album match (handles "Album (Deluxe Edition)" vs "Album")
        // Only try if album is not unknown and differs from cleaned version
        if (!isUnknownAlbum && cleanedAlbum !== spotifyTrack.album) {
            let normalizedAlbumMatch =
                await spotifyImportPrisma.track.findFirst({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        album: {
                            artist: {
                                normalizedName: normalizedPrimaryArtist,
                            },
                            title: {
                                mode: "insensitive",
                                startsWith: cleanedAlbum,
                            },
                        },
                        title: {
                            mode: "insensitive",
                            equals: spotifyTrack.title,
                        },
                    },
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                });

            // Also try: DB album starts with Spotify album (handles Spotify having shorter name)
            if (!normalizedAlbumMatch) {
                // Get all albums by this artist and check if any starts with the cleaned album name
                const artistAlbums = await spotifyImportPrisma.album.findMany({
                    where: {
                        artist: {
                            normalizedName: normalizedPrimaryArtist,
                        },
                    },
                    include: {
                        tracks: true,
                        artist: true,
                    },
                });

                for (const album of artistAlbums) {
                    const dbAlbumCleaned = normalizeAlbumForMatching(
                        album.title,
                    );
                    // Check if album names match after normalization
                    if (
                        dbAlbumCleaned.toLowerCase() ===
                            cleanedAlbum.toLowerCase() ||
                        dbAlbumCleaned
                            .toLowerCase()
                            .startsWith(cleanedAlbum.toLowerCase()) ||
                        cleanedAlbum
                            .toLowerCase()
                            .startsWith(dbAlbumCleaned.toLowerCase())
                    ) {
                        // Find matching track in this album
                        const matchingTrack = album.tracks.find(
                            (t) =>
                                t.title.toLowerCase() ===
                                    spotifyTrack.title.toLowerCase() ||
                                normalizeTrackTitle(t.title) ===
                                    cleanedTrackTitle,
                        );
                        if (matchingTrack) {
                            return {
                                spotifyTrack,
                                localTrack: {
                                    id: matchingTrack.id,
                                    title: matchingTrack.title,
                                    albumId: album.id,
                                    albumTitle: album.title,
                                    artistName: album.artist.name,
                                },
                                matchType: "exact",
                                matchConfidence: 95,
                            };
                        }
                    }
                }
            }

            if (normalizedAlbumMatch) {
                return {
                    spotifyTrack,
                    localTrack: {
                        id: normalizedAlbumMatch.id,
                        title: normalizedAlbumMatch.title,
                        albumId: normalizedAlbumMatch.albumId,
                        albumTitle: normalizedAlbumMatch.album.title,
                        artistName: normalizedAlbumMatch.album.artist.name,
                    },
                    matchType: "exact",
                    matchConfidence: 95,
                };
            }
        }

        // Strategy 3: Artist + title match (ignores album - for "Unknown Album" tracks)
        // This catches tracks where the album metadata is missing from Spotify/Deezer
        const artistTitleMatches = await spotifyImportPrisma.track.findMany({
            where: {
                ...MATCHABLE_TRACK_WHERE,
                album: {
                    artist: {
                        normalizedName: normalizedPrimaryArtist,
                    },
                },
                OR: [
                    {
                        title: {
                            mode: "insensitive",
                            equals: spotifyTrack.title,
                        },
                    },
                    {
                        title: {
                            mode: "insensitive",
                            equals: cleanedTrackTitle,
                        },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
            take: 10,
        });

        // Also try with full artist name
        if (
            artistTitleMatches.length === 0 &&
            primaryArtist !== spotifyTrack.artist
        ) {
            const fullArtistMatches = await spotifyImportPrisma.track.findMany({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    album: {
                        artist: {
                            normalizedName: normalizedArtist,
                        },
                    },
                    OR: [
                        {
                            title: {
                                mode: "insensitive",
                                equals: spotifyTrack.title,
                            },
                        },
                        {
                            title: {
                                mode: "insensitive",
                                equals: cleanedTrackTitle,
                            },
                        },
                    ],
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 10,
            });
            artistTitleMatches.push(...fullArtistMatches);
        }

        if (artistTitleMatches.length > 0) {
            // If we have an album hint (not Unknown), prefer tracks from matching album
            if (!isUnknownAlbum) {
                const albumMatch = artistTitleMatches.find((t) => {
                    const dbAlbumCleaned = normalizeAlbumForMatching(
                        t.album.title,
                    ).toLowerCase();
                    const spotifyAlbumCleaned = cleanedAlbum.toLowerCase();
                    return (
                        dbAlbumCleaned === spotifyAlbumCleaned ||
                        dbAlbumCleaned.includes(spotifyAlbumCleaned) ||
                        spotifyAlbumCleaned.includes(dbAlbumCleaned)
                    );
                });
                if (albumMatch) {
                    return {
                        spotifyTrack,
                        localTrack: {
                            id: albumMatch.id,
                            title: albumMatch.title,
                            albumId: albumMatch.albumId,
                            albumTitle: albumMatch.album.title,
                            artistName: albumMatch.album.artist.name,
                        },
                        matchType: "exact",
                        matchConfidence: 90,
                    };
                }
            }

            // Return first match (artist + title matched)
            const match = artistTitleMatches[0];
            return {
                spotifyTrack,
                localTrack: {
                    id: match.id,
                    title: match.title,
                    albumId: match.albumId,
                    albumTitle: match.album.title,
                    artistName: match.album.artist.name,
                },
                matchType: isUnknownAlbum ? "fuzzy" : "exact",
                matchConfidence: isUnknownAlbum ? 85 : 90,
            };
        }

        // Strategy 4: Fuzzy match by primary artist + title (any album)
        // Use multiple search strategies for better coverage
        let fuzzyMatches: any[] = [];

        // 4a: Search by first word of artist (original strategy)
        const firstWord = normalizedPrimaryArtist.split(" ")[0];
        if (firstWord.length >= 3) {
            fuzzyMatches = await spotifyImportPrisma.track.findMany({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    album: {
                        artist: {
                            normalizedName: {
                                contains: firstWord,
                            },
                        },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 50,
            });
        }

        // 4b: For single-word artist names or if no matches, try startsWith
        if (fuzzyMatches.length === 0) {
            fuzzyMatches = await spotifyImportPrisma.track.findMany({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    album: {
                        artist: {
                            normalizedName: {
                                startsWith: normalizedPrimaryArtist.substring(
                                    0,
                                    Math.min(5, normalizedPrimaryArtist.length),
                                ),
                            },
                        },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 50,
            });
        }

        // 4c: Fallback - try with full artist name
        if (
            fuzzyMatches.length === 0 &&
            primaryArtist !== spotifyTrack.artist
        ) {
            const fullArtistFirstWord = normalizedArtist.split(" ")[0];
            if (fullArtistFirstWord.length >= 3) {
                fuzzyMatches = await spotifyImportPrisma.track.findMany({
                    where: {
                        ...MATCHABLE_TRACK_WHERE,
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: fullArtistFirstWord,
                                },
                            },
                        },
                    },
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                    take: 50,
                });
            }
        }

        let bestMatch: any = null;
        let bestScore = 0;

        for (const track of fuzzyMatches) {
            // Use cleaned titles for comparison (strips "- 2011 Remaster", etc.)
            const titleSim = stringSimilarity(
                cleanedTrackTitle,
                normalizeTrackTitle(track.title),
            );
            // Compare against primary artist for better matching
            const artistSim = stringSimilarity(
                normalizedPrimaryArtist,
                normalizeString(track.album.artist.name),
            );

            // Weight: title 60%, artist 40%
            const score = titleSim * 0.6 + artistSim * 0.4;

            if (score > bestScore && score >= 70) {
                bestScore = score;
                bestMatch = track;
            }
        }

        if (bestMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: bestMatch!.id,
                    title: bestMatch!.title,
                    albumId: bestMatch!.albumId,
                    albumTitle: bestMatch!.album.title,
                    artistName: bestMatch!.album.artist.name,
                },
                matchType: "fuzzy",
                matchConfidence: Math.round(bestScore),
            };
        }

        return {
            spotifyTrack,
            localTrack: null,
            matchType: "none",
            matchConfidence: 0,
        };
    }

    /**
     * Look up album info from MusicBrainz for downloading
     */
    protected async findAlbumMbid(
        artistName: string,
        albumName: string,
    ): Promise<{ artistMbid: string | null; albumMbid: string | null }> {
        try {
            // Search for artist first
            const artists = await musicBrainzService.searchArtist(
                artistName,
                5,
            );
            if (!artists || artists.length === 0) {
                return { artistMbid: null, albumMbid: null };
            }

            // Find best matching artist
            let bestArtist = artists[0];
            for (const artist of artists) {
                if (
                    normalizeString(artist.name) === normalizeString(artistName)
                ) {
                    bestArtist = artist;
                    break;
                }
            }

            const artistMbid = bestArtist.id;

            // Search for album by this artist
            const releaseGroups =
                await musicBrainzService.getReleaseGroups(artistMbid);

            for (const rg of releaseGroups || []) {
                if (stringSimilarity(rg.title, albumName) >= 80) {
                    return { artistMbid, albumMbid: rg.id };
                }
            }

            return { artistMbid, albumMbid: null };
        } catch (error) {
            logger?.error("MusicBrainz lookup error:", error);
            return { artistMbid: null, albumMbid: null };
        }
    }

    /**
     * Enrich tracks with "Unknown Album" by looking up each track in MusicBrainz
     * This happens BEFORE album grouping so tracks get grouped by their actual albums
     *
     * @param tracks - Array of SpotifyTrack objects (mutated in place)
     * @param logPrefix - Prefix for log messages
     * @returns Stats about resolution success
     */
    protected async enrichUnknownAlbumsViaMusicBrainz(
        tracks: SpotifyTrack[],
        logPrefix: string,
    ): Promise<{
        resolved: number;
        failed: number;
        cached: Map<
            string,
            { albumName: string; albumId: string; albumMbid: string }
        >;
    }> {
        const unknownAlbumTracks = tracks.filter(
            (t) => t.album === "Unknown Album",
        );

        if (unknownAlbumTracks.length === 0) {
            return { resolved: 0, failed: 0, cached: new Map() };
        }

        logger?.info(
            `${logPrefix} Resolving ${unknownAlbumTracks.length} tracks with Unknown Album via MusicBrainz...`,
        );

        // Cache to avoid duplicate lookups for same artist+title
        const resolutionCache = new Map<
            string,
            { albumName: string; albumId: string; albumMbid: string } | null
        >();
        // Results cache for use in album grouping
        const resultsCache = new Map<
            string,
            { albumName: string; albumId: string; albumMbid: string }
        >();

        let resolved = 0;
        let failed = 0;

        // Process tracks (MusicBrainz rate limiting is handled by musicBrainzService)
        for (const track of unknownAlbumTracks) {
            const cacheKey = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;

            // Check if we already looked this up
            if (resolutionCache.has(cacheKey)) {
                const cached = resolutionCache.get(cacheKey);
                if (cached) {
                    track.album = cached.albumName;
                    // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
                    // This is parsed later in buildPreviewFromTracklist() and startImport()
                    track.albumId = `mbid:${cached.albumMbid}`;
                    resolved++;
                    logger?.debug(
                        `${logPrefix} [Cache Hit] "${track.title}" -> "${cached.albumName}"`,
                    );
                } else {
                    failed++;
                }
                continue;
            }

            // Normalize track title (remove remaster/live suffixes)
            const normalizedTitle = stripTrackSuffix(track.title);

            try {
                logger?.debug(
                    `${logPrefix} Looking up: "${track.title}" by ${track.artist}...`,
                );

                const recordingInfo = await musicBrainzService.searchRecording(
                    normalizedTitle,
                    track.artist,
                );

                if (recordingInfo && recordingInfo.albumName) {
                    // Success - update track with resolved album
                    track.album = recordingInfo.albumName;
                    // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
                    // This is parsed later in buildPreviewFromTracklist() and startImport()
                    track.albumId = `mbid:${recordingInfo.albumMbid}`;

                    const result = {
                        albumName: recordingInfo.albumName,
                        albumId: recordingInfo.albumMbid,
                        albumMbid: recordingInfo.albumMbid,
                    };

                    resolutionCache.set(cacheKey, result);
                    resultsCache.set(track.spotifyId, result);
                    resolved++;

                    logger?.info(
                        `${logPrefix} Resolved: "${track.title}" -> "${recordingInfo.albumName}"`,
                    );
                } else {
                    // Failed - track stays as "Unknown Album"
                    resolutionCache.set(cacheKey, null);
                    failed++;
                    logger?.debug(
                        `${logPrefix} Could not resolve: "${track.title}" by ${track.artist}`,
                    );
                }
            } catch (error: unknown) {
                resolutionCache.set(cacheKey, null);
                failed++;
                const errorMsg =
                    error instanceof Error ? error.message : String(error);
                logger?.error(
                    `${logPrefix} Error resolving "${track.title}": ${errorMsg}`,
                );
            }
        }

        logger?.info(
            `${logPrefix} MusicBrainz resolution complete: ${resolved} resolved, ${failed} still unknown`,
        );

        return { resolved, failed, cached: resultsCache };
    }
}
