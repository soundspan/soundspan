import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { ProgrammaticPlaylistAudioAnalysisMixService } from "./audioAnalysisMixes";
import {
    findTracksByGenrePatterns,
    getMixColor,
    type ProgrammaticMix,
    selectTracksWithArtistDiversityForMix,
} from "./shared";

/** Tag, road-trip, and day-of-week mix generators. */
export class ProgrammaticPlaylistContextualMixService extends ProgrammaticPlaylistAudioAnalysisMixService {
    // LAST.FM TAG-BASED MIXES

    /**
     * Generate mix based on Last.fm mood tags
     */
    async generateMoodTagMix(
        userId: string,
        today: string,
        moodTag: string,
        mixName: string,
        mixDescription: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                lastfmTags: {
                    has: moodTag,
                },
            }),
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `mood-${moodTag}-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `mood-${moodTag}-${today}`,
            type: `mood-${moodTag}`,
            name: mixName,
            description: mixDescription,
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("mood"),
        };
    }

    /**
     * Generate "Road Trip" mix - using tags
     */
    async generateRoadTripMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Last.fm/mood tags
        const taggedTracks = await prisma.track.findMany({
            where: this.trackWhere({
                OR: [
                    {
                        lastfmTags: {
                            hasSome: [
                                "driving",
                                "road trip",
                                "travel",
                                "summer",
                            ],
                        },
                    },
                    { moodTags: { hasSome: ["energetic", "upbeat", "happy"] } },
                ],
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        tracks = taggedTracks;
        logger.debug(`[ROAD TRIP MIX] Found ${tracks.length} tracks from tags`);

        // Strategy 2: Audio analysis (medium-high energy, good tempo)
        if (tracks.length < 15) {
            const audioTracks = await prisma.track.findMany({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    energy: { gte: 0.5, lte: 0.8 },
                    bpm: { gte: 100, lte: 130 },
                }),
                include: { album: { select: { coverUrl: true } } },
                take: 100,
            });
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...audioTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[ROAD TRIP MIX] After audio fallback: ${tracks.length} tracks`,
            );
        }

        // Strategy 3: Fallback to upbeat rock/pop genres (using helper for proper JSON array handling)
        if (tracks.length < 15) {
            const roadTripGenres = [
                "rock",
                "pop",
                "indie",
                "alternative",
                "classic rock",
            ];
            const albumGenreTracks = await findTracksByGenrePatterns(
                roadTripGenres,
                100,
            );
            const existingIds = new Set(tracks.map((t) => t.id));
            tracks = [
                ...tracks,
                ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
            ];
            logger.debug(
                `[ROAD TRIP MIX] After genre fallback: ${tracks.length} tracks`,
            );
        }

        if (tracks.length < 15) {
            logger.debug(
                `[ROAD TRIP MIX] FAILED: Only ${tracks.length} tracks found`,
            );
            return null;
        }

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
            `road-trip-${today}`,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `road-trip-${today}`,
            type: "road-trip",
            name: "Road Trip",
            description: "Perfect soundtrack for the open road",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("road-trip"),
        };
    }

    // DAY-OF-WEEK MIXES

    /**
     * Generate day-specific mix based on the current day
     */
    async generateDayMix(userId: string): Promise<ProgrammaticMix | null> {
        const dayOfWeek = new Date().getDay();
        const today = new Date().toISOString().split("T")[0];

        // Different vibes for different days
        switch (dayOfWeek) {
            case 0: // Sunday - Relaxed
                return this.generateSundayMix(userId, today);
            case 1: // Monday - Motivation
                return this.generateMondayMix(userId, today);
            case 5: // Friday - Party
                return this.generateFridayMix(userId, today);
            default:
                return null;
        }
    }

    async generateSundayMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { lte: 0.5 },
                        acousticness: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "relaxed",
                                "calm",
                                "peaceful",
                                "chill",
                                "sunday",
                            ],
                        },
                    },
                ],
            }),
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `sunday-${today}`,
            type: "sunday-morning",
            name: "Sunday Morning",
            description: "Peaceful tunes for a lazy Sunday",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("sunday-morning"),
        };
    }

    async generateMondayMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { gte: 0.6 },
                        valence: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "motivation",
                                "uplifting",
                                "energetic",
                                "happy",
                            ],
                        },
                    },
                ],
            }),
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `monday-${today}`,
            type: "confidence-boost",
            name: "Monday Motivation",
            description: "Start your week with energy",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("confidence-boost"),
        };
    }

    async generateFridayMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                OR: [
                    {
                        analysisStatus: "completed",
                        danceability: { gte: 0.7 },
                        energy: { gte: 0.6 },
                    },
                    {
                        lastfmTags: {
                            hasSome: ["party", "dance", "fun", "groovy"],
                        },
                    },
                ],
            }),
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.TRACK_LIMIT,
        );
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `friday-${today}`,
            type: "dance-floor",
            name: "Friday Night",
            description: "Weekend vibes to kick off the party",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("dance-floor"),
        };
    }
}
