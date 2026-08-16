import {
    getDecadeFromYear,
    getDecadeWhereClause,
    getEffectiveYear,
} from "../../utils/dateFilters";
import { normalizeArtistName } from "../../utils/artistNormalization";
import { prisma } from "../../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { logger } from "../../utils/logger";
import { separateArtists } from "../../utils/separateArtists";
import { getSeededRandom, seededShuffle } from "../artistSlotAllocation";
import { lastFmService } from "../lastfm";
import { applyArtistCap } from "../programmaticPlaylistArtistCap";
import {
    findTracksByGenrePatterns,
    getMixColor,
    type ProgrammaticMix,
    ProgrammaticPlaylistServiceBase,
    type TrackWithAlbumCover,
} from "./shared";

/** Library-history, genre, era, artist-similarity, and discovery mixes. */
export class ProgrammaticPlaylistLibraryMixService extends ProgrammaticPlaylistServiceBase {
    /**
     * Generate ONE era-based mix (rotating decade daily)
     */
    async generateEraMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Get all decades
        const albums = await prisma.album.findMany({
            where: {
                tracks: {
                    some: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
                },
            },
            select: { year: true, originalYear: true, displayYear: true },
        });

        const decades = new Set<number>();
        albums.forEach((album) => {
            const effectiveYear = getEffectiveYear(album);
            if (effectiveYear) {
                const decade = getDecadeFromYear(effectiveYear);
                decades.add(decade);
            }
        });

        if (decades.size === 0) return null;

        // Pick one decade based on today's date
        const decadeArray = Array.from(decades).sort((a, b) => b - a);
        const decadeSeed = getSeededRandom(`era-${today}`);
        const selectedDecade = decadeArray[decadeSeed % decadeArray.length];

        // Get ALL tracks from this decade
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                album: getDecadeWhereClause(selectedDecade),
            }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
        });

        if (tracks.length < 15) return null;

        let selectedTracks = this.diversifyTracksUniqueFirst(
            tracks,
            this.TRACK_LIMIT,
            `era-${today}-tracks-${userId}`,
        );
        selectedTracks = await this.backfillFromLibraryForDiversity(
            selectedTracks,
            this.TRACK_LIMIT,
            `era-${today}-tracks-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `era-${selectedDecade}-${today}`,
            type: "era",
            name: `Your ${selectedDecade}s Mix`,
            description: `Random picks from the ${selectedDecade}s`,
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("era"),
        };
    }

    /**
     * Generate ONE genre-based mix (rotating genre daily)
     */
    async generateGenreMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Get top genres
        const genres = await prisma.genre.findMany({
            include: {
                _count: { select: { trackGenres: true } },
            },
            orderBy: {
                trackGenres: { _count: "desc" },
            },
            take: 20,
        });

        logger.debug(`[GENRE MIX] Found ${genres.length} genres total`);
        const validGenres = genres.filter((g) => g._count.trackGenres >= 5);
        logger.debug(
            `[GENRE MIX] ${validGenres.length} genres have >= 5 tracks`,
        );
        if (validGenres.length === 0) {
            logger.debug(`[GENRE MIX] FAILED: No genres with enough tracks`);
            return null;
        }

        // Pick one genre based on today's date
        const genreSeed = getSeededRandom(`genre-${today}`);
        const selectedGenre = validGenres[genreSeed % validGenres.length];

        // Get ALL tracks from this genre
        const trackGenres = await prisma.trackGenre.findMany({
            where: {
                genreId: selectedGenre.id,
                track: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
            },
            include: {
                track: {
                    include: {
                        album: {
                            select: {
                                coverUrl: true,
                                artist: { select: { id: true } },
                            },
                        },
                    },
                },
            },
        });

        let tracks: TrackWithAlbumCover[] = trackGenres.map(
            (tg) => tg.track as TrackWithAlbumCover,
        );
        if (tracks.length < this.TRACK_LIMIT) {
            const genrePatternTracks = await findTracksByGenrePatterns(
                [selectedGenre.name],
                this.TRACK_LIMIT * 10,
            );
            const existingIds = new Set(tracks.map((track) => track.id));
            tracks = [
                ...tracks,
                ...genrePatternTracks.filter(
                    (track) => !existingIds.has(track.id),
                ),
            ];
        }
        if (tracks.length < 5) return null;

        let selectedTracks = this.diversifyTracksUniqueFirst(
            tracks,
            this.TRACK_LIMIT,
            `genre-${today}-${selectedGenre.id}-${userId}`,
        );
        selectedTracks = await this.backfillFromLibraryForDiversity(
            selectedTracks,
            this.TRACK_LIMIT,
            `genre-${today}-${selectedGenre.id}-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `genre-${selectedGenre.id}-${today}`,
            type: "genre",
            name: `Your ${selectedGenre.name} Mix`,
            description: `Random ${selectedGenre.name} picks`,
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("genre"),
        };
    }

    /**
     * Generate "Your Top 20" mix
     */
    async generateTopTracksMix(
        userId: string,
    ): Promise<ProgrammaticMix | null> {
        const seedKey = `top-tracks-${userId}`;
        const playStats = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                track: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
            },
            _count: { trackId: true },
            orderBy: { _count: { trackId: "desc" } },
            take: this.TRACK_LIMIT * 10,
        });

        logger.debug(
            `[TOP TRACKS MIX] Found ${playStats.length} unique played tracks`,
        );
        if (playStats.length < 5) {
            logger.debug(
                `[TOP TRACKS MIX] FAILED: Only ${playStats.length} tracks (need at least 5)`,
            );
            return null;
        }

        const trackIds = playStats
            .map((play) => play.trackId)
            .filter(
                (trackId): trackId is string => typeof trackId === "string",
            );
        if (trackIds.length < 5) {
            return null;
        }
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({ id: { in: trackIds } }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
        });

        // Preserve play count order
        const orderedTracks = trackIds
            .map((id) => tracks.find((t) => t.id === id))
            .filter((track): track is (typeof tracks)[number] =>
                Boolean(track),
            );

        // Keep ranked top tracks first with a strict cap before any fallback fill.
        const strictTopTracks = separateArtists(
            applyArtistCap(orderedTracks, {
                maxPerArtist: this.MAX_TRACKS_PER_ARTIST,
                targetCount: this.TRACK_LIMIT,
                preserveInputOrder: true,
                fallback: { enabled: false },
            }),
            (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
        );

        let selectedTracks = strictTopTracks;
        if (selectedTracks.length < this.TRACK_LIMIT) {
            logger.debug(
                `[TOP TRACKS MIX] Underfilled after strict top-track cap (${selectedTracks.length}/${this.TRACK_LIMIT}); backfilling from library`,
            );

            const selectedIds = new Set(
                selectedTracks.map((track) => track.id),
            );
            const fallbackTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    id: { notIn: Array.from(selectedIds) },
                }),
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                            artist: { select: { id: true } },
                        },
                    },
                },
                orderBy: { id: "asc" },
                take: this.TRACK_LIMIT * 50,
            });

            const shuffledFallback = seededShuffle(
                fallbackTracks,
                `${seedKey}-library-fallback`,
            );

            selectedTracks = separateArtists(
                applyArtistCap([...strictTopTracks, ...shuffledFallback], {
                    maxPerArtist: this.MAX_TRACKS_PER_ARTIST,
                    targetCount: this.TRACK_LIMIT,
                    preserveInputOrder: true,
                    fallback: { enabled: false },
                }),
                (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
            );
        }

        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: "top-tracks",
            type: "top-tracks",
            name: "Your Top 20",
            description: "Your most played tracks",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("top-tracks"),
        };
    }

    /**
     * Generate "Rediscover" mix with daily rotation from a bounded candidate pool
     */
    async generateRediscoverMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const overplayed = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                trackId: { not: null },
                track: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
            },
            _count: { trackId: true },
            having: { trackId: { _count: { gt: 2 } } },
        });
        const overplayedIds = overplayed
            .map((row) => row.trackId)
            .filter(
                (trackId): trackId is string => typeof trackId === "string",
            );

        const candidateTracks = await prisma.track.findMany({
            where: this.trackWhere(
                overplayedIds.length > 0
                    ? { id: { notIn: overplayedIds } }
                    : undefined,
            ),
            include: {
                _count: {
                    select: {
                        plays: { where: { userId } },
                    },
                },
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
            orderBy: { id: "asc" },
            take: this.TRACK_LIMIT * 50,
        });

        const underplayedTracks = candidateTracks.filter(
            (t) => t._count.plays <= 2,
        );

        if (underplayedTracks.length < 5) return null;

        const selectedTracks = this.diversifyTracks(
            underplayedTracks,
            this.TRACK_LIMIT,
            `rediscover-${today}-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `rediscover-${today}`,
            type: "rediscover",
            name: "Rediscover",
            description: "Hidden gems you rarely play",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("rediscover"),
        };
    }

    /**
     * Generate "More Like X" mix
     */
    async generateArtistSimilarMix(
        userId: string,
    ): Promise<ProgrammaticMix | null> {
        // Get most played artist from last 7 days
        const recentPlays = await prisma.play.findMany({
            where: {
                userId,
                playedAt: {
                    gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                },
                track: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
            },
            include: {
                track: {
                    include: {
                        album: { select: { artistId: true } },
                    },
                },
            },
        });

        logger.debug(
            `[ARTIST SIMILAR MIX] Found ${recentPlays.length} plays in last 7 days`,
        );
        if (recentPlays.length === 0) {
            logger.debug(
                `[ARTIST SIMILAR MIX] FAILED: No plays in last 7 days`,
            );
            return null;
        }

        // Count plays by artist
        const artistPlayCounts = new Map<string, number>();
        recentPlays.forEach((play) => {
            if (!play.track) {
                return;
            }
            const artistId = play.track.album.artistId;
            artistPlayCounts.set(
                artistId,
                (artistPlayCounts.get(artistId) || 0) + 1,
            );
        });

        // Get top artist
        const topArtistId = Array.from(artistPlayCounts.entries()).sort(
            (a, b) => b[1] - a[1],
        )[0][0];

        const topArtist = await prisma.artist.findUnique({
            where: { id: topArtistId },
        });

        if (!topArtist || !topArtist.name) {
            logger.debug(
                `[ARTIST SIMILAR MIX] FAILED: Top artist not found or has no name`,
            );
            return null;
        }

        logger.debug(`[ARTIST SIMILAR MIX] Top artist: ${topArtist.name}`);

        // Get similar artists from Last.fm
        try {
            const similarArtists = await lastFmService.getSimilarArtists(
                topArtist.mbid || "",
                topArtist.name,
                this.ARTIST_SIMILAR_FETCH_LIMIT,
            );

            logger.debug(
                `[ARTIST SIMILAR MIX] Last.fm returned ${similarArtists.length} similar artists`,
            );

            const similarArtistNormalized = similarArtists.map((a) =>
                normalizeArtistName(a.name),
            );
            const artistsInLibrary = await prisma.artist.findMany({
                where: { normalizedName: { in: similarArtistNormalized } },
                include: {
                    albums: {
                        include: {
                            tracks: {
                                where: {
                                    ...TRACK_VISIBLE_WHERE,
                                    ...TRACK_BROWSE_WHERE,
                                },
                                include: {
                                    album: {
                                        select: {
                                            coverUrl: true,
                                            artist: { select: { id: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });

            logger.debug(
                `[ARTIST SIMILAR MIX] Found ${artistsInLibrary.length} similar artists in library`,
            );

            const tracks = artistsInLibrary.flatMap((artist) =>
                artist.albums.flatMap((album) => album.tracks),
            );

            logger.debug(
                `[ARTIST SIMILAR MIX] Total tracks from similar artists: ${tracks.length}`,
            );

            if (tracks.length < 5) {
                logger.debug(
                    `[ARTIST SIMILAR MIX] FAILED: Only ${tracks.length} tracks (need at least 5)`,
                );
                return null;
            }

            const selectedTracks = this.diversifyTracks(
                tracks,
                this.TRACK_LIMIT,
                `artist-similar-${userId}-${topArtistId}`,
            );
            const coverUrls = selectedTracks
                .filter((t) => t.album.coverUrl)
                .slice(0, 4)
                .map((t) => t.album.coverUrl!);

            return {
                id: `artist-similar-${topArtistId}`,
                type: "artist-similar",
                name: `More Like ${topArtist.name}`,
                description: `Similar artists you might enjoy`,
                trackIds: selectedTracks.map((t) => t.id),
                coverUrls,
                trackCount: selectedTracks.length,
                color: getMixColor("artist-similar"),
            };
        } catch (error) {
            logger.error("Failed to generate artist similar mix:", error);
            return null;
        }
    }

    /**
     * Generate random discovery mix with daily rotation
     */
    async generateRandomDiscoveryMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const totalAlbums = await prisma.album.count({
            where: {
                tracks: {
                    some: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
                },
            },
        });

        if (totalAlbums < 10) return null;

        // Use date as seed for consistent daily randomness
        const seed = getSeededRandom(`random-${today}`) % totalAlbums;

        const randomAlbums = await prisma.album.findMany({
            where: {
                tracks: {
                    some: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
                },
            },
            include: {
                tracks: {
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                    },
                    include: {
                        album: {
                            select: {
                                coverUrl: true,
                                artist: { select: { id: true } },
                            },
                        },
                    },
                },
            },
            skip: seed,
            take: 5, // Just a few albums
        });

        const tracks = randomAlbums.flatMap((album) => album.tracks);
        if (tracks.length < 5) return null;

        const selectedTracks = this.diversifyTracks(
            tracks,
            this.TRACK_LIMIT,
            `random-discovery-${today}-${userId}`,
        );
        const coverUrls = randomAlbums
            .filter((a) => a.coverUrl)
            .slice(0, 4)
            .map((a) => a.coverUrl!);

        return {
            id: `random-discovery-${today}`,
            type: "discovery",
            name: "Random Discovery",
            description: "Random albums to explore today",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("discovery"),
        };
    }
}
