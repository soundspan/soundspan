import { prisma } from "../../utils/db";
import {
    CURATED_VIBE_MIXES_BY_TYPE,
    type CuratedVibeMixDefinition,
} from "../curatedVibeMixDefinitions";
import { ProgrammaticPlaylistContextualMixService } from "./contextualMixes";
import {
    getMixColor,
    type ProgrammaticMix,
    selectTracksWithArtistDiversityForMix,
} from "./shared";

/** Data-driven daily curated-vibe mix generators. */
export class ProgrammaticPlaylistCuratedMixService extends ProgrammaticPlaylistContextualMixService {
    /**
     * Shared generator for data-driven curated daily vibe mixes. Applies the
     * definition's optional weekday gate, queries the candidate pool with the
     * definition's Prisma filter (always constrained to completed analysis),
     * enforces the minimum pool size, then builds a diversity-selected mix.
     */
    private async generateCuratedVibeMix(
        today: string,
        definition: CuratedVibeMixDefinition,
    ): Promise<ProgrammaticMix | null> {
        if (
            definition.dayOfWeek !== undefined &&
            new Date().getDay() !== definition.dayOfWeek
        ) {
            return null;
        }

        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                ...definition.where,
            }),
            include: { album: { select: { coverUrl: true } } },
            take: definition.take,
        });

        const minTracks = definition.minTracks ?? this.MIN_TRACKS_DAILY;
        if (tracks.length < minTracks) return null;

        const shuffled = await selectTracksWithArtistDiversityForMix(
            tracks,
            this.DAILY_TRACK_LIMIT,
        );
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `${definition.type}-${today}`,
            type: definition.type,
            name: definition.name,
            description: definition.description,
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor(definition.colorKey),
        };
    }

    // CURATED VIBE MIXES (Daily, 10 tracks)

    /**
     * "Sad Girl Sundays" - Melancholic introspection
     * valence < 0.3 + keyScale = 'minor' + arousal < 0.4
     * Only available on Sundays
     */
    async generateSadGirlSundays(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["sad-girl-sundays"],
        );
    }

    /**
     * "Main Character Energy" - Walking through life like a movie
     * valence > 0.6 + energy > 0.6 + danceability > 0.5
     */
    async generateMainCharacterEnergy(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["main-character"],
        );
    }

    /**
     * "Villain Era" - Dark, empowering, dramatic
     * keyScale = 'minor' + energy > 0.7 + moodTags includes 'aggressive'
     */
    async generateVillainEra(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["villain-era"],
        );
    }

    /**
     * "3AM Thoughts" - Late night overthinking
     * arousal < 0.3 + energy < 0.4 + valence < 0.4
     */
    async generate3AMThoughts(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["3am-thoughts"],
        );
    }

    /**
     * "Hot Girl Walk" - Confident, upbeat cardio
     * danceability > 0.7 + bpm 100-130 + energy > 0.6
     */
    async generateHotGirlWalk(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["hot-girl-walk"],
        );
    }

    /**
     * "Rage Cleaning" - Aggressive productivity
     * energy > 0.8 + arousal > 0.7 + bpm > 130
     */
    async generateRageCleaning(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["rage-cleaning"],
        );
    }

    /**
     * "Golden Hour" - Warm, hopeful, sunset vibes
     * valence > 0.5 + acousticness > 0.4 + energy 0.3-0.6
     */
    async generateGoldenHour(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["golden-hour"],
        );
    }

    /**
     * "Shower Karaoke" - Belters you can't help but sing
     * instrumentalness < 0.3 + energy > 0.6 + valence > 0.5
     */
    async generateShowerKaraoke(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["shower-karaoke"],
        );
    }

    /**
     * "In My Feelings" - Deep emotional processing
     * valence < 0.35 + arousal < 0.5 + acousticness > 0.3
     */
    async generateInMyFeelings(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["in-my-feelings"],
        );
    }

    /**
     * "Midnight Drive" - Cruising at night, contemplative
     * energy 0.4-0.6 + arousal 0.3-0.5 + bpm 90-120
     */
    async generateMidnightDrive(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["midnight-drive"],
        );
    }

    /**
     * "Coffee Shop Vibes" - Cozy background energy
     * acousticness > 0.5 + energy 0.2-0.5 + instrumentalness > 0.3
     */
    async generateCoffeeShopVibes(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: cozy, background-appropriate music only
        const tracks = await prisma.track.findMany({
            where: this.trackWhere({
                analysisStatus: "completed",
                AND: [
                    // MUST be low-to-moderate energy (exclude workout-level tracks)
                    { energy: { gte: 0.08, lte: 0.5 } },
                    // MUST be moderate-slow tempo
                    { bpm: { gte: 55, lte: 112 } },
                    // MUST include at least one cozy indicator
                    {
                        OR: [
                            { acousticness: { gte: 0.4 } },
                            { instrumentalness: { gte: 0.3 } },
                            { moodRelaxed: { gte: 0.45 } },
                        ],
                    },
                    // Exclude explicitly intense/heavy candidates when tags are available
                    {
                        NOT: {
                            OR: [
                                {
                                    moodTags: {
                                        hasSome: [
                                            "aggressive",
                                            "intense",
                                            "upbeat",
                                            "workout",
                                        ],
                                    },
                                },
                                {
                                    lastfmTags: {
                                        hasSome: [
                                            "metal",
                                            "hard rock",
                                            "hardcore",
                                            "punk",
                                            "thrash metal",
                                        ],
                                    },
                                },
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
            take: 120,
        });

        if (tracks.length < this.MIN_TRACKS_DAILY) {
            return null;
        }

        let selectedTracks = this.diversifyTracksUniqueFirst(
            tracks,
            this.DAILY_TRACK_LIMIT,
            `coffee-shop-${today}-${userId}`,
        );
        selectedTracks = await this.backfillFromLibraryForDiversity(
            selectedTracks,
            this.DAILY_TRACK_LIMIT,
            `coffee-shop-${today}-${userId}`,
        );

        if (selectedTracks.length < this.MIN_TRACKS_DAILY) {
            return null;
        }

        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `coffee-shop-${today}`,
            type: "coffee-shop",
            name: "Coffee Shop Vibes",
            description: "Cozy background music",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("coffee-shop"),
        };
    }

    /**
     * "Romanticize Your Life" - Dreamy, aesthetic moments
     * valence 0.4-0.7 + arousal 0.3-0.6 + acousticness > 0.3
     */
    async generateRomanticizeYourLife(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["romanticize"],
        );
    }

    /**
     * "That Girl Era" - Self-improvement anthem energy
     * valence > 0.6 + energy > 0.5 + danceability > 0.5
     */
    async generateThatGirlEra(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["that-girl-era"],
        );
    }

    /**
     * "Unhinged" - Chaotic, weird, fun
     * High variance in features, unexpected combinations
     */
    async generateUnhinged(
        userId: string,
        today: string,
    ): Promise<ProgrammaticMix | null> {
        return this.generateCuratedVibeMix(
            today,
            CURATED_VIBE_MIXES_BY_TYPE["unhinged"],
        );
    }
}
