import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { ProgrammaticPlaylistCuratedMixService } from "./curatedMixes";
import {
    getMixColor,
    type ProgrammaticMix,
    RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
    selectTracksWithArtistDiversityForMix,
} from "./shared";

/** Weekly curated and on-demand mood mix generators. */
export class ProgrammaticPlaylistWeeklyAndMoodMixService extends ProgrammaticPlaylistCuratedMixService {
    // WEEKLY CURATED MIXES (20 tracks)

    /**
     * "Deep Cuts" - Hidden gems from your library
     * Tracks with playCount < 3 from artists you play often
     */
    async generateDeepCuts(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Get tracks that haven't been played much
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                plays: {
                    none: {},
                },
            }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
            take: 200,
        });

        if (tracks.length < 15) {
            // Fallback: tracks with few plays
            const lowPlayTracks = await prisma.track.findMany({
                where: this.trackWhere(),
                include: {
                    album: { select: { coverUrl: true } },
                    _count: { select: { plays: true } },
                },
                take: 200,
            });

            const filtered = lowPlayTracks
                .filter((t) => t._count.plays <= 3)
                .map((t) => ({ ...t, album: t.album }));

            if (filtered.length < 15) return null;

            const shuffled = await selectTracksWithArtistDiversityForMix(
                filtered,
                this.WEEKLY_TRACK_LIMIT,
            );
            const coverUrls = shuffled
                .filter((t) => t.album.coverUrl)
                .slice(0, 4)
                .map((t) => t.album.coverUrl!);

            return {
                id: `deep-cuts-${today}`,
                type: "deep-cuts",
                name: "Deep Cuts",
                description: "Hidden gems waiting to be discovered",
                trackIds: shuffled.map((t) => t.id),
                coverUrls,
                trackCount: shuffled.length,
                color: getMixColor("rediscover"),
            };
        }

        const shuffled = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.WEEKLY_TRACK_LIMIT,
        );
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `deep-cuts-${today}`,
            type: "deep-cuts",
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("rediscover"),
        };
    }

    /**
     * "Key Journey" - Harmonic progression
     * Tracks ordered by circle of fifths key progression
     */
    async generateKeyJourney(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Circle of fifths order
        const keyOrder = [
            "C",
            "G",
            "D",
            "A",
            "E",
            "B",
            "F#",
            "Db",
            "Ab",
            "Eb",
            "Bb",
            "F",
        ];

        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                key: { not: null },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 200,
        });

        if (tracks.length < 15) return null;

        // Group by key
        const byKey = new Map<string, typeof tracks>();
        for (const track of tracks) {
            const key = track.key || "C";
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key)!.push(track);
        }

        // Build a journey through keys
        const journey: typeof tracks = [];
        for (const key of keyOrder) {
            const keyTracks = byKey.get(key) || [];
            if (
                keyTracks.length > 0 &&
                journey.length < this.WEEKLY_TRACK_LIMIT
            ) {
                // Pick 1-2 tracks from each key
                const count = Math.min(
                    2,
                    keyTracks.length,
                    this.WEEKLY_TRACK_LIMIT - journey.length,
                );
                // Include the key in the seed so each key's selection is
                // independent; a shared accumulator would correlate them.
                journey.push(
                    ...(await selectTracksWithArtistDiversityForMix(
                        keyTracks,
                        count,
                        `key-journey-${today}-${key}`,
                    )),
                );
            }
        }

        if (journey.length < 15) return null;

        const coverUrls = journey
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `key-journey-${today}`,
            type: "key-journey",
            name: "Key Journey",
            description: "Harmonic progression through your library",
            trackIds: journey.map((t) => t.id),
            coverUrls,
            trackCount: journey.length,
            color: getMixColor("instrumental"),
        };
    }

    /**
     * "Tempo Flow" - Energy arc throughout
     * Start low BPM, build to peak, come down
     */
    async generateTempoFlow(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                bpm: { not: null },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 200,
        });

        if (tracks.length < 15) return null;

        // Sort by BPM
        const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

        // Build an arc: slow → fast → slow
        const slow = sorted.filter((t) => (t.bpm || 0) < 100);
        const medium = sorted.filter(
            (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130,
        );
        const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

        const flow: typeof tracks = [];

        // Intro: 4 slow tracks
        flow.push(
            ...(await selectTracksWithArtistDiversityForMix(
                slow,
                Math.min(4, slow.length),
            )),
        );
        // Build: 4 medium tracks
        flow.push(
            ...(await selectTracksWithArtistDiversityForMix(
                medium,
                Math.min(5, medium.length),
            )),
        );
        // Peak: 5 fast tracks
        flow.push(
            ...(await selectTracksWithArtistDiversityForMix(
                fast,
                Math.min(6, fast.length),
            )),
        );
        // Cool down: 3 medium tracks
        flow.push(
            ...(await selectTracksWithArtistDiversityForMix(
                medium.filter((t) => !flow.includes(t)),
                Math.min(3, medium.length),
            )),
        );
        // Outro: 3 slow tracks
        flow.push(
            ...(await selectTracksWithArtistDiversityForMix(
                slow.filter((t) => !flow.includes(t)),
                Math.min(2, slow.length),
            )),
        );

        if (flow.length < 15) return null;

        const coverUrls = flow
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `tempo-flow-${today}`,
            type: "tempo-flow",
            name: "Tempo Flow",
            description: "An energy journey through BPM",
            trackIds: flow.slice(0, this.WEEKLY_TRACK_LIMIT).map((t) => t.id),
            coverUrls,
            trackCount: Math.min(flow.length, this.WEEKLY_TRACK_LIMIT),
            color: getMixColor("workout"),
        };
    }

    /**
     * "Vocal Detox" - Pure instrumental escape
     * instrumentalness > 0.8 + variety of moods
     */
    async generateVocalDetox(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                instrumentalness: { gte: 0.75 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const shuffled = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.WEEKLY_TRACK_LIMIT,
        );
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `vocal-detox-${today}`,
            type: "vocal-detox",
            name: "Vocal Detox",
            description: "Pure instrumental escape",
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("instrumental"),
        };
    }

    /**
     * "Minor Key Mondays" - All minor key bangers
     * keyScale = 'minor' + energy > 0.5
     * Only available on Mondays
     */
    async generateMinorKeyMix(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // Only generate on Mondays (day 1)
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek !== 1) return null;

        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                keyScale: "minor",
                energy: { gte: 0.45 },
            }),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const shuffled = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.WEEKLY_TRACK_LIMIT,
        );
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `minor-key-${today}`,
            type: "melancholy",
            name: "Minor Key Mondays",
            description: "All minor key bangers",
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("melancholy"),
        };
    }

    // MOOD ON DEMAND

    /**
     * Generate a custom mood mix based on audio feature parameters
     * Supports both basic audio features and ML mood predictions
     */
    async generateMoodOnDemand(
        userId: string,
        params: {
            // Basic audio features
            valence?: { min?: number; max?: number };
            energy?: { min?: number; max?: number };
            danceability?: { min?: number; max?: number };
            acousticness?: { min?: number; max?: number };
            instrumentalness?: { min?: number; max?: number };
            arousal?: { min?: number; max?: number };
            bpm?: { min?: number; max?: number };
            keyScale?: "major" | "minor";
            // ML mood predictions (require Enhanced mode analysis)
            moodHappy?: { min?: number; max?: number };
            moodSad?: { min?: number; max?: number };
            moodRelaxed?: { min?: number; max?: number };
            moodAggressive?: { min?: number; max?: number };
            moodParty?: { min?: number; max?: number };
            moodAcoustic?: { min?: number; max?: number };
            moodElectronic?: { min?: number; max?: number };
            limit?: number;
        },
    ): Promise<ProgrammaticMix | null> {
        const where: any = {
            analysisStatus: "completed",
        };

        // Check if any ML mood params are being used
        const mlMoodParams = [
            "moodHappy",
            "moodSad",
            "moodRelaxed",
            "moodAggressive",
            "moodParty",
            "moodAcoustic",
            "moodElectronic",
        ];
        const usesMLMoods = mlMoodParams.some(
            (key) => params[key as keyof typeof params] !== undefined,
        );

        // First, check how many enhanced tracks we have
        let useEnhancedMode = false;
        if (usesMLMoods) {
            const enhancedCount = await prisma.track.count({
                where: this.trackWhere({
                    analysisStatus: "completed",
                    analysisMode: "enhanced",
                    analysisVersion: {
                        startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                    },
                }),
            });

            // Only require enhanced mode if we have at least 15 enhanced tracks
            if (enhancedCount >= 15) {
                where.analysisMode = "enhanced";
                where.analysisVersion = {
                    startsWith: RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX,
                };
                useEnhancedMode = true;
            } else {
                // Not enough enhanced tracks - convert ML mood params to basic audio feature equivalents
                logger.debug(
                    `[MoodMixer] Only ${enhancedCount} enhanced tracks, falling back to basic features`,
                );

                // Map ML moods to basic audio features for fallback
                // This provides approximate matching when enhanced mode isn't available
                if (params.moodHappy) {
                    where.valence = where.valence || {};
                    if (params.moodHappy.min !== undefined)
                        where.valence.gte = Math.max(
                            where.valence.gte || 0,
                            params.moodHappy.min,
                        );
                }
                if (params.moodSad) {
                    where.valence = where.valence || {};
                    if (params.moodSad.min !== undefined)
                        where.valence.lte = Math.min(
                            where.valence.lte || 1,
                            1 - params.moodSad.min,
                        );
                }
                if (params.moodRelaxed) {
                    where.energy = where.energy || {};
                    if (params.moodRelaxed.min !== undefined)
                        where.energy.lte = Math.min(
                            where.energy.lte || 1,
                            1 - params.moodRelaxed.min * 0.5,
                        );
                }
                if (params.moodAggressive) {
                    where.energy = where.energy || {};
                    if (params.moodAggressive.min !== undefined)
                        where.energy.gte = Math.max(
                            where.energy.gte || 0,
                            params.moodAggressive.min,
                        );
                }
                if (params.moodParty) {
                    where.danceability = where.danceability || {};
                    if (params.moodParty.min !== undefined)
                        where.danceability.gte = Math.max(
                            where.danceability.gte || 0,
                            params.moodParty.min,
                        );
                }
                // Clear the ML mood params since we're falling back
                delete params.moodHappy;
                delete params.moodSad;
                delete params.moodRelaxed;
                delete params.moodAggressive;
                delete params.moodParty;
                delete params.moodAcoustic;
                delete params.moodElectronic;
            }
        }

        // Basic audio feature filters - merge with any existing from fallback
        if (params.valence) {
            where.valence = where.valence || {};
            if (params.valence.min !== undefined)
                where.valence.gte = Math.max(
                    where.valence.gte || 0,
                    params.valence.min,
                );
            if (params.valence.max !== undefined)
                where.valence.lte = Math.min(
                    where.valence.lte ?? 1,
                    params.valence.max,
                );
        }
        if (params.energy) {
            where.energy = where.energy || {};
            if (params.energy.min !== undefined)
                where.energy.gte = Math.max(
                    where.energy.gte || 0,
                    params.energy.min,
                );
            if (params.energy.max !== undefined)
                where.energy.lte = Math.min(
                    where.energy.lte ?? 1,
                    params.energy.max,
                );
        }
        if (params.danceability) {
            where.danceability = where.danceability || {};
            if (params.danceability.min !== undefined)
                where.danceability.gte = Math.max(
                    where.danceability.gte || 0,
                    params.danceability.min,
                );
            if (params.danceability.max !== undefined)
                where.danceability.lte = Math.min(
                    where.danceability.lte ?? 1,
                    params.danceability.max,
                );
        }
        if (params.acousticness) {
            where.acousticness = {};
            if (params.acousticness.min !== undefined)
                where.acousticness.gte = params.acousticness.min;
            if (params.acousticness.max !== undefined)
                where.acousticness.lte = params.acousticness.max;
        }
        if (params.instrumentalness) {
            where.instrumentalness = {};
            if (params.instrumentalness.min !== undefined)
                where.instrumentalness.gte = params.instrumentalness.min;
            if (params.instrumentalness.max !== undefined)
                where.instrumentalness.lte = params.instrumentalness.max;
        }
        if (params.arousal) {
            where.arousal = {};
            if (params.arousal.min !== undefined)
                where.arousal.gte = params.arousal.min;
            if (params.arousal.max !== undefined)
                where.arousal.lte = params.arousal.max;
        }
        if (params.bpm) {
            where.bpm = {};
            if (params.bpm.min !== undefined) where.bpm.gte = params.bpm.min;
            if (params.bpm.max !== undefined) where.bpm.lte = params.bpm.max;
        }
        if (params.keyScale) {
            where.keyScale = params.keyScale;
        }

        // ML mood prediction filters
        if (params.moodHappy) {
            where.moodHappy = {};
            if (params.moodHappy.min !== undefined)
                where.moodHappy.gte = params.moodHappy.min;
            if (params.moodHappy.max !== undefined)
                where.moodHappy.lte = params.moodHappy.max;
        }
        if (params.moodSad) {
            where.moodSad = {};
            if (params.moodSad.min !== undefined)
                where.moodSad.gte = params.moodSad.min;
            if (params.moodSad.max !== undefined)
                where.moodSad.lte = params.moodSad.max;
        }
        if (params.moodRelaxed) {
            where.moodRelaxed = {};
            if (params.moodRelaxed.min !== undefined)
                where.moodRelaxed.gte = params.moodRelaxed.min;
            if (params.moodRelaxed.max !== undefined)
                where.moodRelaxed.lte = params.moodRelaxed.max;
        }
        if (params.moodAggressive) {
            where.moodAggressive = {};
            if (params.moodAggressive.min !== undefined)
                where.moodAggressive.gte = params.moodAggressive.min;
            if (params.moodAggressive.max !== undefined)
                where.moodAggressive.lte = params.moodAggressive.max;
        }
        if (params.moodParty) {
            where.moodParty = {};
            if (params.moodParty.min !== undefined)
                where.moodParty.gte = params.moodParty.min;
            if (params.moodParty.max !== undefined)
                where.moodParty.lte = params.moodParty.max;
        }
        if (params.moodAcoustic) {
            where.moodAcoustic = {};
            if (params.moodAcoustic.min !== undefined)
                where.moodAcoustic.gte = params.moodAcoustic.min;
            if (params.moodAcoustic.max !== undefined)
                where.moodAcoustic.lte = params.moodAcoustic.max;
        }
        if (params.moodElectronic) {
            where.moodElectronic = {};
            if (params.moodElectronic.min !== undefined)
                where.moodElectronic.gte = params.moodElectronic.min;
            if (params.moodElectronic.max !== undefined)
                where.moodElectronic.lte = params.moodElectronic.max;
        }

        const tracks = await prisma.track.findMany({
            where: this.trackWhere(where),
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        const limit = params.limit || 15;
        if (tracks.length < Math.min(limit, 8)) return null;

        const shuffled = await selectTracksWithArtistDiversityForMix(
            tracks,
            limit,
        );
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        const timestamp = Date.now();
        return {
            id: `mood-on-demand-${timestamp}`,
            type: "mood-on-demand",
            name: "Custom Mood Mix",
            description: `Generated just for you`,
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("mood"),
        };
    }
}
