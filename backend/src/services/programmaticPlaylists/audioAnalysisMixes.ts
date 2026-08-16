import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { ProgrammaticPlaylistActivityMixService } from "./activityMixes";
import {
    findTracksByGenrePatterns,
    getMixColor,
    type ProgrammaticMix,
    RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
    selectTracksWithArtistDiversityForMix,
} from "./shared";

/** Audio-analysis-driven energy, mood, dance, and acoustic mixes. */
export class ProgrammaticPlaylistAudioAnalysisMixService extends ProgrammaticPlaylistActivityMixService {
    // AUDIO ANALYSIS-BASED MIXES (Using Essentia features)

    /**
     * Generate "High Energy" mix using audio analysis
     * Criteria: energy >= 0.7, BPM >= 120
     * Fallback: energetic genres if no audio analysis
     */
    async generateHighEnergyMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
        const audioTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                energy: { gte: 0.7 },
                bpm: { gte: 120 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = audioTracks;
        logger.debug(
            `[HIGH ENERGY MIX] Found ${tracks.length} tracks from audio analysis`,
        );

        // Strategy 2: Fallback to energetic genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const energyGenres = [
                "rock",
                "metal",
                "punk",
                "electronic",
                "edm",
                "dance",
                "hip hop",
                "trap",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                energyGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[HIGH ENERGY MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[HIGH ENERGY MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `high-energy-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `high-energy-${today}`,
            type: "workout",
            name: "High Energy",
            description: "Fast-paced tracks to get you moving",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("workout"),
        };
    }

    /**
     * Generate "Late Night" mix using audio analysis
     * Enhanced mode: Uses ML moodRelaxed and low moodAggressive
     * Standard mode: Uses energy, BPM, arousal heuristics
     */
    async generateLateNightMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // First try Enhanced mode (ML mood predictions)
        let tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                },
                AND: [
                    // High relaxed mood (ML)
                    { moodRelaxed: { gte: 0.5 } },
                    // Low aggression (ML)
                    { moodAggressive: { lte: 0.4 } },
                    // Low-moderate energy
                    { energy: { lte: 0.5 } },
                    // Slow-moderate tempo
                    { bpm: { lte: 110 } },
                ],
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        logger.debug(
            `[LATE NIGHT MIX] Enhanced mode: Found ${tracks.length} tracks`,
        );

        // Fallback to Standard mode if not enough Enhanced tracks
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(`[LATE NIGHT MIX] Falling back to Standard mode`);
            tracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    AND: [
                        // MUST have low energy
                        { energy: { lte: 0.45 } },
                        // MUST have moderate-slow tempo
                        { bpm: { lte: 110 } },
                        // Plus at least one additional mellow indicator
                        {
                            OR: [
                                { arousal: { lte: 0.5 } },
                                { valence: { lte: 0.6 } },
                                { acousticness: { gte: 0.3 } },
                            ],
                        },
                    ],
                }),
                include: { album: { select: { coverUrl: true } } },
                take: 100,
            });
            logger.debug(
                `[LATE NIGHT MIX] Standard mode: Found ${tracks.length} tracks`,
            );
        }

        logger.debug(
            `[LATE NIGHT MIX] Total: ${tracks.length} tracks matching criteria`,
        );

        // No fallback padding - if not enough truly mellow tracks, don't generate
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(
                `[LATE NIGHT MIX] FAILED: Only ${tracks.length} tracks (need ${this.MIN_TRACKS_DAILY})`,
            );
            return null;
        }

        // Determine if daily or weekly based on available tracks
        const isWeekly = tracks.length >= this.MIN_TRACKS_WEEKLY;
        const trackLimit = isWeekly
            ? this.WEEKLY_TRACK_LIMIT
            : this.DAILY_TRACK_LIMIT;
        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            trackLimit,
            `late-night-${today}`,
        );

        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `late-night-${today}`,
            type: "late-night",
            name: "Late Night",
            description: "Mellow vibes for the quiet hours",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("late-night"),
        };
    }

    /**
     * Generate "Happy Vibes" mix using audio analysis
     * Enhanced mode: Uses ML moodHappy prediction
     * Standard mode: Uses valence/energy heuristics
     */
    async generateHappyMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Enhanced mode - ML moodHappy prediction
        const enhancedTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                },
                moodHappy: { gte: 0.6 },
                moodSad: { lte: 0.3 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = enhancedTracks;
        logger.debug(
            `[HAPPY MIX] Enhanced mode: Found ${tracks.length} tracks`,
        );

        // Strategy 2: Standard mode fallback - valence/energy heuristics
        if (tracks.length < 15) {
            const standardTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    valence: { gte: 0.6 },
                    energy: { gte: 0.5 },
                }),
                include: { album: { select: { coverUrl: true } } },
                take: 100,
            });
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...standardTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[HAPPY MIX] After Standard fallback: ${tracks.length} tracks`,
            );
        }

        // Strategy 2: Fallback to upbeat/happy genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const happyGenres = [
                "pop",
                "funk",
                "disco",
                "soul",
                "reggae",
                "ska",
                "motown",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                happyGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[HAPPY MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[HAPPY MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `happy-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `happy-${today}`,
            type: "happy",
            name: "Happy Vibes",
            description: "Feel-good tracks to brighten your day",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("happy"),
        };
    }

    /**
     * Generate "Melancholy" mix using audio analysis
     * Enhanced mode: Uses ML moodSad prediction
     * Standard mode: Uses valence heuristics + minor key
     */
    async generateMelancholyMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Enhanced mode - ML moodSad prediction
        const enhancedTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                },
                moodSad: { gte: 0.5 },
                moodHappy: { lte: 0.4 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 150,
        });
        logger.debug(
            `[MELANCHOLY MIX] Enhanced mode: Found ${enhancedTracks.length} tracks`,
        );

        if (enhancedTracks.length >= 15) {
            tracks = enhancedTracks;
        } else {
            // Strategy 2: Standard mode fallback
            logger.debug(`[MELANCHOLY MIX] Falling back to Standard mode`);
            const audioTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    valence: { lte: 0.35 },
                    energy: { lte: 0.6 },
                }),
                include: { album: { select: { coverUrl: true } } },
                take: 150,
            });
            logger.debug(
                `[MELANCHOLY MIX] Standard mode: Found ${audioTracks.length} low-valence tracks`,
            );

            // Further filter: prefer minor key OR sad mood tags
            tracks = audioTracks.filter((t) => {
                const hasMinorKey = t.keyScale === "minor";
                const hasSadTags = t.moodTags?.some((tag: string) =>
                    [
                        "sad",
                        "melancholic",
                        "melancholy",
                        "moody",
                        "atmospheric",
                    ].includes(tag.toLowerCase()),
                );
                const hasLastfmSadTags = t.lastfmTags?.some((tag: string) =>
                    [
                        "sad",
                        "melancholic",
                        "melancholy",
                        "depressing",
                        "emotional",
                        "heartbreak",
                    ].includes(tag.toLowerCase()),
                );
                return hasMinorKey || hasSadTags || hasLastfmSadTags;
            });
            logger.debug(
                `[MELANCHOLY MIX] After tag filter: ${tracks.length} tracks`,
            );
        }

        // Strategy 2: Fallback to sad/emotional genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const sadGenres = [
                "blues",
                "soul",
                "ballad",
                "singer-songwriter",
                "slowcore",
                "sadcore",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                sadGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[MELANCHOLY MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        // Require minimum 15 tracks for a meaningful playlist
        if (tracks.length < 15) {
            logger.debug(
                `[MELANCHOLY MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        // Score and sort by "melancholy-ness" (only for tracks with audio analysis)
        const sortedTracks = tracks.sort((a, b) => {
            // Lower valence = more melancholy (score should be lower = better)
            const aScore =
                (a.valence || 0.5) * 2 + // Valence is primary factor
                (a.energy || 0.5) + // Lower energy is better
                (a.keyScale === "minor" ? 0 : 0.3); // Minor key bonus
            const bScore =
                (b.valence || 0.5) * 2 +
                (b.energy || 0.5) +
                (b.keyScale === "minor" ? 0 : 0.3);
            return aScore - bScore;
        });

        // Take the top 50 most melancholy tracks, then select with
        // artist weighting (GH #46).
        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            sortedTracks.slice(0, 50),
            this.TRACK_LIMIT,
            `melancholy-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `melancholy-${today}`,
            type: "melancholy",
            name: "Melancholy",
            description: "Introspective tracks for reflective moments",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("melancholy"),
        };
    }

    /**
     * Generate "Dance Floor" mix using audio analysis
     * Criteria: danceability >= 0.7, BPM 110-140
     * Fallback: dance/electronic genres if no audio analysis
     */
    async generateDanceFloorMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
        const audioTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                danceability: { gte: 0.7 },
                bpm: { gte: 110, lte: 140 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = audioTracks;
        logger.debug(
            `[DANCE FLOOR MIX] Found ${tracks.length} tracks from audio analysis`,
        );

        // Strategy 2: Fallback to dance genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const danceGenres = [
                "dance",
                "electronic",
                "edm",
                "house",
                "disco",
                "techno",
                "pop",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                danceGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[DANCE FLOOR MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[DANCE FLOOR MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `dance-floor-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `dance-floor-${today}`,
            type: "dance-floor",
            name: "Dance Floor",
            description: "High danceability tracks with perfect tempo",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("dance-floor"),
        };
    }

    /**
     * Generate "Acoustic Afternoon" mix using audio analysis
     * Criteria: acousticness >= 0.6, energy 0.3-0.6
     * Fallback: acoustic/folk/singer-songwriter genres
     */
    async generateAcousticMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
        const audioTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                acousticness: { gte: 0.6 },
                energy: { gte: 0.3, lte: 0.6 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = audioTracks;
        logger.debug(
            `[ACOUSTIC MIX] Found ${tracks.length} tracks from audio analysis`,
        );

        // Strategy 2: Fallback to acoustic genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const acousticGenres = [
                "acoustic",
                "folk",
                "singer-songwriter",
                "unplugged",
                "indie folk",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                acousticGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[ACOUSTIC MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[ACOUSTIC MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `acoustic-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `acoustic-${today}`,
            type: "acoustic",
            name: "Acoustic Afternoon",
            description: "Stripped-down, organic sounds",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("acoustic"),
        };
    }

    /**
     * Generate "Instrumental Focus" mix using audio analysis
     * Criteria: instrumentalness >= 0.7, energy 0.3-0.6
     * Fallback: instrumental/classical/soundtrack genres
     */
    async generateInstrumentalMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
        const audioTracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                instrumentalness: { gte: 0.7 },
                energy: { gte: 0.3, lte: 0.6 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = audioTracks;
        logger.debug(
            `[INSTRUMENTAL MIX] Found ${tracks.length} tracks from audio analysis`,
        );

        // Strategy 2: Fallback to instrumental genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const instrumentalGenres = [
                "instrumental",
                "classical",
                "soundtrack",
                "score",
                "ambient",
                "post-rock",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                instrumentalGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[INSTRUMENTAL MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[INSTRUMENTAL MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `instrumental-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `instrumental-${today}`,
            type: "instrumental",
            name: "Instrumental Focus",
            description: "No vocals, pure concentration",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("instrumental"),
        };
    }
}
