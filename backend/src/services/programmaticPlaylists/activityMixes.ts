import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    findTracksByGenrePatterns,
    getMixColor,
    type ProgrammaticMix,
    RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
} from "./shared";
import { ProgrammaticPlaylistLibraryMixService } from "./libraryMixes";

/** Party, chill, workout, and focus mix generators. */
export class ProgrammaticPlaylistActivityMixService extends ProgrammaticPlaylistLibraryMixService {
    /**
     * Generate "Party Playlist" mix - upbeat dance, electronic, pop tracks
     * Uses multiple strategies: Genre table, album.genre, audio analysis
     */
    async generatePartyMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const partyGenres = [
            "dance",
            "electronic",
            "pop",
            "disco",
            "house",
            "techno",
            "edm",
            "funk",
            "electro",
            "dance pop",
            "club",
            "eurodance",
            "trance",
            "dubstep",
            "drum and bass",
            "hip hop",
        ];

        let tracks: any[] = [];

        // Strategy 1: Genre table
        const genres = await prisma.genre.findMany({
            where: { name: { in: partyGenres, mode: "insensitive" } },
            include: {
                trackGenres: {
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
                    take: 50,
                },
            },
        });
        tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
        logger.debug(
            `[PARTY MIX] Found ${tracks.length} tracks from Genre table`,
        );

        // Strategy 2: Album genre field (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const albumGenreTracks = await findTracksByGenrePatterns(
                partyGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[PARTY MIX] After album genre fallback: ${tracks.length} tracks`,
            );
        }

        // Strategy 3: Audio analysis (high energy, high danceability)
        if (tracks.length < 15) {
            const audioTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    OR: [
                        { danceability: { gte: 0.7 } },
                        {
                            AND: [
                                { energy: { gte: 0.7 } },
                                { bpm: { gte: 110 } },
                            ],
                        },
                    ],
                }),
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                            artist: { select: { id: true } },
                        },
                    },
                },
                take: 50,
            });
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...audioTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[PARTY MIX] After audio analysis fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[PARTY MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = this.diversifyTracks(
            tracks,
            this.TRACK_LIMIT,
            `party-${today}-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `party-${today}`,
            type: "dance-floor",
            name: "Party Playlist",
            description: "High energy dance, EDM, and pop hits",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("dance-floor"),
        };
    }

    /**
     * Generate "Chill Mix" - relaxing, mellow tracks
     * Enhanced mode: Uses ML moodRelaxed prediction
     * Standard mode: Uses energy/arousal heuristics
     */
    async generateChillMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Strategy 1: Enhanced mode - ML moodRelaxed prediction
        let tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                },
                AND: [
                    { moodRelaxed: { gte: 0.5 } },
                    { moodAggressive: { lte: 0.3 } },
                    { energy: { lte: 0.55 } },
                ],
            }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
            take: 100,
        });

        logger.debug(
            `[CHILL MIX] Enhanced mode: Found ${tracks.length} tracks`,
        );

        // Strategy 2: Standard mode fallback
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(`[CHILL MIX] Falling back to Standard mode`);
            tracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    AND: [
                        // MUST be low-to-moderate energy
                        { energy: { lte: 0.55 } },
                        // MUST be slow-to-moderate tempo
                        { bpm: { lte: 115 } },
                        // Plus additional mellow indicator
                        {
                            OR: [
                                { arousal: { lte: 0.55 } },
                                { acousticness: { gte: 0.3 } },
                                { valence: { lte: 0.65 } },
                            ],
                        },
                    ],
                }),
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                            artist: { select: { id: true } },
                        },
                    },
                },
                take: 100,
            });
            logger.debug(
                `[CHILL MIX] Standard mode: Found ${tracks.length} tracks`,
            );
        }

        logger.debug(
            `[CHILL MIX] Total: ${tracks.length} tracks matching criteria`,
        );

        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(
                `[CHILL MIX] FAILED: Only ${tracks.length} tracks (need ${this.MIN_TRACKS_DAILY})`,
            );
            return null;
        }

        let diverseTracks = this.diversifyTracksUniqueFirst(
            tracks,
            this.WEEKLY_TRACK_LIMIT,
            `chill-${today}-${userId}`,
        );
        diverseTracks = await this.backfillFromLibraryForDiversity(
            diverseTracks,
            this.WEEKLY_TRACK_LIMIT,
            `chill-${today}-${userId}`,
        );
        if (diverseTracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(
                `[CHILL MIX] FAILED: Only ${diverseTracks.length} diverse tracks (need ${this.MIN_TRACKS_DAILY})`,
            );
            return null;
        }

        // Determine if daily or weekly based on available tracks after diversity
        const isWeekly = diverseTracks.length >= this.MIN_TRACKS_WEEKLY;
        const trackLimit = isWeekly
            ? this.WEEKLY_TRACK_LIMIT
            : this.DAILY_TRACK_LIMIT;
        const selectedTracks = diverseTracks.slice(0, trackLimit);

        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `chill-${today}`,
            type: "chill",
            name: "Chill Mix",
            description: "Relax and unwind with mellow vibes",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("chill"),
        };
    }

    /**
     * Generate "Workout Mix" - high energy, motivational tracks
     * Enhanced mode: Uses ML high arousal + moodAggressive
     * Standard mode: Uses energy/BPM heuristics + genres
     */
    async generateWorkoutMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const workoutGenres = [
            "rock",
            "metal",
            "hard rock",
            "alternative rock",
            "punk",
            "hip hop",
            "rap",
            "trap",
            "hardcore",
            "metalcore",
            "industrial",
            "drum and bass",
            "hardstyle",
            "nu metal",
            "electronic",
            "edm",
            "house",
            "techno",
            "pop punk",
        ];

        let tracks: any[] = [];

        // Strategy 1: Enhanced mode - high arousal and energy
        const enhancedTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                },
                AND: [
                    { arousal: { gte: 0.6 } },
                    { energy: { gte: 0.6 } },
                    { bpm: { gte: 110 } },
                    // Not too relaxed
                    { moodRelaxed: { lte: 0.4 } },
                ],
            }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
            take: 100,
        });
        tracks = enhancedTracks;
        logger.debug(
            `[WORKOUT MIX] Enhanced mode: Found ${tracks.length} tracks`,
        );

        // Strategy 2: Standard mode fallback - audio analysis
        if (tracks.length < 15) {
            logger.debug(`[WORKOUT MIX] Falling back to Standard mode`);
            const audioTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    OR: [
                        {
                            AND: [
                                { energy: { gte: 0.65 } },
                                { bpm: { gte: 115 } },
                            ],
                        },
                        {
                            moodTags: {
                                hasSome: [
                                    "workout",
                                    "energetic",
                                    "upbeat",
                                    "powerful",
                                ],
                            },
                        },
                    ],
                }),
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                            artist: { select: { id: true } },
                        },
                    },
                },
                take: 100,
            });
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...audioTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[WORKOUT MIX] Standard mode: Total ${tracks.length} tracks`,
            );
        }

        // Strategy 2: Genre table
        if (tracks.length < 15) {
            const genres = await prisma.genre.findMany({
                where: { name: { in: workoutGenres, mode: "insensitive" } },
                include: {
                    trackGenres: {
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
                        take: 50,
                    },
                },
            });
            const genreTracks = genres.flatMap((g) =>
                g.trackGenres.map((tg) => tg.track),
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...genreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[WORKOUT MIX] After Genre table: ${tracks.length} tracks`,
            );
        }

        // Strategy 3: Album genre field (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const albumGenreTracks = await findTracksByGenrePatterns(
                workoutGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[WORKOUT MIX] After album genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[WORKOUT MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = this.diversifyTracks(
            tracks,
            this.TRACK_LIMIT,
            `workout-${today}-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `workout-${today}`,
            type: "workout",
            name: "Workout Mix",
            description: "High energy tracks to power your workout",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("workout"),
        };
    }

    /**
     * Generate "Focus Mix" - instrumental, minimal vocals, concentration music
     * Uses multiple strategies: Genre table, album.genre, audio analysis
     */
    async generateFocusMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const focusGenres = [
            "classical",
            "instrumental",
            "jazz",
            "piano",
            "ambient",
            "post-rock",
            "math rock",
            "soundtrack",
            "score",
            "contemporary classical",
            "minimal",
            "modern classical",
            "neoclassical",
        ];

        let tracks: any[] = [];

        // Strategy 1: Genre table
        const genres = await prisma.genre.findMany({
            where: { name: { in: focusGenres, mode: "insensitive" } },
            include: {
                trackGenres: {
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
                    take: 50,
                },
            },
        });
        tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
        logger.debug(
            `[FOCUS MIX] Found ${tracks.length} tracks from Genre table`,
        );

        // Strategy 2: Album genre field (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const albumGenreTracks = await findTracksByGenrePatterns(
                focusGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[FOCUS MIX] After album genre fallback: ${tracks.length} tracks`,
            );
        }

        // Strategy 3: Audio analysis (high instrumentalness, moderate energy)
        if (tracks.length < 15) {
            const audioTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    instrumentalness: { gte: 0.5 },
                    energy: { gte: 0.2, lte: 0.7 },
                }),
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                            artist: { select: { id: true } },
                        },
                    },
                },
                take: 50,
            });
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...audioTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[FOCUS MIX] After audio analysis fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[FOCUS MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        let selectedTracks = this.diversifyTracksUniqueFirst(
            tracks,
            this.TRACK_LIMIT,
            `focus-${today}-${userId}`,
        );
        selectedTracks = await this.backfillFromLibraryForDiversity(
            selectedTracks,
            this.TRACK_LIMIT,
            `focus-${today}-${userId}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `focus-${today}`,
            type: "focus-flow",
            name: "Focus Mix",
            description: "Concentration music for deep work",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("focus-flow"),
        };
    }
}
