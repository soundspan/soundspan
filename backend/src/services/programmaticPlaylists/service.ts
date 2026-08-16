import { moodBucketService } from "../moodBucketService";
import { getSeededRandom } from "../artistSlotAllocation";
import { logger } from "../../utils/logger";
import { type ProgrammaticMix } from "./shared";
import { ProgrammaticPlaylistWeeklyAndMoodMixService } from "./weeklyAndMoodMixes";

/** Programmatic playlist service composed from focused generator modules. */
export class ProgrammaticPlaylistService extends ProgrammaticPlaylistWeeklyAndMoodMixService {
    /**
     * Generate 4 daily rotating mixes
     */
    async generateAllMixes(
        userId: string,
        forceRandom = false,
    ): Promise<ProgrammaticMix[]> {
        // Get today's date for daily rotation (or random seed if refreshing)
        const today = new Date().toISOString().split("T")[0];
        const seedString = forceRandom
            ? `${userId}-${Date.now()}-${Math.random()}`
            : `${today}-${userId}`;
        const dateSeed = getSeededRandom(seedString);

        logger.debug(
            `[MIXES] Generating mixes for user ${userId}, forceRandom: ${forceRandom}, seed: ${dateSeed}`,
        );

        // Define all possible mix types
        const seedSuffix = forceRandom ? `-${Date.now()}` : "";
        const mixGenerators = [
            // Classic mixes (genre/era based)
            {
                fn: () => this.generateEraMix(userId, today + seedSuffix),
                weight: 2,
                name: "Era Mix",
            },
            {
                fn: () => this.generateGenreMix(userId, today + seedSuffix),
                weight: 2,
                name: "Genre Mix",
            },
            {
                fn: () => this.generateTopTracksMix(userId),
                weight: 1,
                name: "Top Tracks Mix",
            },
            {
                fn: () =>
                    this.generateRediscoverMix(userId, today + seedSuffix),
                weight: 1,
                name: "Rediscover Mix",
            },
            {
                fn: () => this.generateArtistSimilarMix(userId),
                weight: 1,
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    this.generateRandomDiscoveryMix(userId, today + seedSuffix),
                weight: 1,
                name: "Random Discovery Mix",
            },
            {
                fn: () => this.generatePartyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Party Mix",
            },
            {
                fn: () => this.generateChillMix(userId, today + seedSuffix),
                weight: 2,
                name: "Chill Mix",
            },
            {
                fn: () => this.generateWorkoutMix(userId, today + seedSuffix),
                weight: 2,
                name: "Workout Mix",
            },
            {
                fn: () => this.generateFocusMix(userId, today + seedSuffix),
                weight: 2,
                name: "Focus Mix",
            },
            // Audio analysis-based mixes (using Essentia features)
            {
                fn: () =>
                    this.generateHighEnergyMix(userId, today + seedSuffix),
                weight: 2,
                name: "High Energy Mix",
            },
            {
                fn: () => this.generateLateNightMix(userId, today + seedSuffix),
                weight: 2,
                name: "Late Night Mix",
            },
            {
                fn: () => this.generateHappyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Happy Vibes Mix",
            },
            {
                fn: () =>
                    this.generateMelancholyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Melancholy Mix",
            },
            {
                fn: () =>
                    this.generateDanceFloorMix(userId, today + seedSuffix),
                weight: 2,
                name: "Dance Floor Mix",
            },
            {
                fn: () => this.generateAcousticMix(userId, today + seedSuffix),
                weight: 2,
                name: "Acoustic Mix",
            },
            {
                fn: () =>
                    this.generateInstrumentalMix(userId, today + seedSuffix),
                weight: 2,
                name: "Instrumental Mix",
            },
            {
                fn: () => this.generateRoadTripMix(userId, today + seedSuffix),
                weight: 2,
                name: "Road Trip Mix",
            },
            // Day-of-week mixes
            {
                fn: () => this.generateDayMix(userId),
                weight: 1,
                name: "Day Mix",
            },
            // Curated Vibe Mixes (Daily, 10 tracks)
            {
                fn: () =>
                    this.generateSadGirlSundays(userId, today + seedSuffix),
                weight: 2,
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    this.generateMainCharacterEnergy(
                        userId,
                        today + seedSuffix,
                    ),
                weight: 2,
                name: "Main Character Energy",
            },
            {
                fn: () => this.generateVillainEra(userId, today + seedSuffix),
                weight: 2,
                name: "Villain Era",
            },
            {
                fn: () => this.generate3AMThoughts(userId, today + seedSuffix),
                weight: 2,
                name: "3AM Thoughts",
            },
            {
                fn: () => this.generateHotGirlWalk(userId, today + seedSuffix),
                weight: 2,
                name: "Hot Girl Walk",
            },
            {
                fn: () => this.generateRageCleaning(userId, today + seedSuffix),
                weight: 2,
                name: "Rage Cleaning",
            },
            {
                fn: () => this.generateGoldenHour(userId, today + seedSuffix),
                weight: 2,
                name: "Golden Hour",
            },
            {
                fn: () =>
                    this.generateShowerKaraoke(userId, today + seedSuffix),
                weight: 2,
                name: "Shower Karaoke",
            },
            {
                fn: () => this.generateInMyFeelings(userId, today + seedSuffix),
                weight: 2,
                name: "In My Feelings",
            },
            {
                fn: () =>
                    this.generateMidnightDrive(userId, today + seedSuffix),
                weight: 2,
                name: "Midnight Drive",
            },
            {
                fn: () =>
                    this.generateCoffeeShopVibes(userId, today + seedSuffix),
                weight: 2,
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    this.generateRomanticizeYourLife(
                        userId,
                        today + seedSuffix,
                    ),
                weight: 2,
                name: "Romanticize Your Life",
            },
            {
                fn: () => this.generateThatGirlEra(userId, today + seedSuffix),
                weight: 2,
                name: "That Girl Era",
            },
            {
                fn: () => this.generateUnhinged(userId, today + seedSuffix),
                weight: 2,
                name: "Unhinged",
            },
            // Weekly Curated Mixes (20 tracks)
            {
                fn: () => this.generateDeepCuts(userId, today + seedSuffix),
                weight: 1,
                name: "Deep Cuts",
            },
            {
                fn: () => this.generateKeyJourney(userId, today + seedSuffix),
                weight: 1,
                name: "Key Journey",
            },
            {
                fn: () => this.generateTempoFlow(userId, today + seedSuffix),
                weight: 1,
                name: "Tempo Flow",
            },
            {
                fn: () => this.generateVocalDetox(userId, today + seedSuffix),
                weight: 1,
                name: "Vocal Detox",
            },
            {
                fn: () => this.generateMinorKeyMix(userId, today + seedSuffix),
                weight: 1,
                name: "Minor Key Mondays",
            },
        ];

        // Select 5 mixes based on date seed
        const selectedIndices: number[] = [];
        let seed = dateSeed;

        logger.debug(
            `[MIXES] Selecting ${this.DAILY_MIX_COUNT} mixes from ${mixGenerators.length} types...`,
        );

        while (selectedIndices.length < this.DAILY_MIX_COUNT) {
            seed = (seed * 9301 + 49297) % 233280;
            const index = seed % mixGenerators.length;
            if (!selectedIndices.includes(index)) {
                selectedIndices.push(index);
                logger.debug(
                    `[MIXES] Selected index ${index}: ${mixGenerators[index].name}`,
                );
            }
        }

        logger.debug(
            `[MIXES] Final selected indices: [${selectedIndices.join(", ")}]`,
        );

        // Generate selected mixes
        const mixPromises = selectedIndices.map((i) => {
            logger.debug(`[MIXES] Generating ${mixGenerators[i].name}...`);
            return mixGenerators[i].fn();
        });
        const mixes = await Promise.all(mixPromises);

        logger.debug(
            `[MIXES] Generated ${mixes.length} mixes before filtering`,
        );
        mixes.forEach((mix, i) => {
            if (mix === null) {
                logger.debug(
                    `[MIXES] Mix ${i} (${
                        mixGenerators[selectedIndices[i]].name
                    }) returned NULL`,
                );
            } else {
                logger.debug(
                    `[MIXES] Mix ${i}: ${mix.name} (${mix.trackCount} tracks)`,
                );
            }
        });

        // Filter out null mixes
        let finalMixes = mixes.filter(
            (mix): mix is ProgrammaticMix => mix !== null,
        );
        logger.debug(
            `[MIXES] Returning ${finalMixes.length} mixes after filtering nulls`,
        );

        // If we don't have 5 mixes, try to fill gaps with successful generators
        if (finalMixes.length < this.DAILY_MIX_COUNT) {
            logger.debug(
                `[MIXES] Only got ${finalMixes.length} mixes, trying to fill gaps...`,
            );

            // Try generating from all types that weren't selected or failed
            const successfulTypes = new Set(finalMixes.map((m) => m.type));
            const attemptedIndices = new Set(selectedIndices);

            for (
                let i = 0;
                i < mixGenerators.length &&
                finalMixes.length < this.DAILY_MIX_COUNT;
                i++
            ) {
                if (!attemptedIndices.has(i)) {
                    logger.debug(
                        `[MIXES] Attempting fallback: ${mixGenerators[i].name}`,
                    );
                    const fallbackMix = await mixGenerators[i].fn();
                    if (fallbackMix && !successfulTypes.has(fallbackMix.type)) {
                        finalMixes.push(fallbackMix);
                        successfulTypes.add(fallbackMix.type);
                        logger.debug(
                            `[MIXES] Fallback succeeded: ${fallbackMix.name}`,
                        );
                    }
                }
            }

            logger.debug(`[MIXES] After fallbacks: ${finalMixes.length} mixes`);
        }

        // Check if user has saved mood mix from the new bucket system (fast lookup)
        try {
            const savedMoodMix = await moodBucketService.getUserMoodMix(userId);
            if (savedMoodMix) {
                logger.debug(
                    `[MIXES] User has saved mood mix: "${savedMoodMix.name}" with ${savedMoodMix.trackCount} tracks`,
                );
                finalMixes.push(savedMoodMix);
            }
        } catch (err) {
            logger.error("[MIXES] Error getting user's saved mood mix:", err);
        }

        return finalMixes;
    }
}

/** Shared programmatic playlist service instance. */
export const programmaticPlaylistService = new ProgrammaticPlaylistService();
