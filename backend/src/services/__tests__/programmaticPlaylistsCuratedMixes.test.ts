import { ProgrammaticMix, ProgrammaticPlaylistService } from "../programmaticPlaylists";
import { prisma } from "../../utils/db";

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: jest.fn(),
            count: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/artistNormalization", () => ({
    normalizeArtistName: (name: string) => name.toLowerCase(),
}));

jest.mock("../lastfm", () => ({
    lastFmService: {
        getSimilarArtists: jest.fn(),
    },
}));

jest.mock("../moodBucketService", () => ({
    moodBucketService: {
        getUserMoodMix: jest.fn(),
        getMoodMix: jest.fn(),
    },
}));

type MockTrack = {
    id: string;
    key: string;
    keyScale: "major" | "minor";
    bpm: number;
    valence: number;
    energy: number;
    danceability: number;
    acousticness: number;
    instrumentalness: number;
    arousal: number;
    moodTags: string[] | null;
    lastfmTags: string[] | null;
    analysisStatus: "completed";
    analysisMode?: "enhanced" | "standard";
    analysisVersion?: string;
    moodHappy?: number;
    moodSad?: number;
    moodRelaxed?: number;
    moodAggressive?: number;
    moodParty?: number;
    moodAcoustic?: number;
    moodElectronic?: number;
    album: {
        coverUrl: string | null;
        genres?: string[] | null;
        userGenres?: string[] | null;
        artist: {
            id: string;
            userGenres?: string[] | null;
        };
    };
    _count?: {
        plays: number;
    };
};

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeTracks(
    count: number,
    prefix: string,
    overrides?: (index: number) => Partial<MockTrack>
): MockTrack[] {
    return Array.from({ length: count }, (_, idx) => {
        const i = idx + 1;
        const base: MockTrack = {
            id: `${prefix}-${i}`,
            key: ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"][
                idx % 12
            ],
            keyScale: idx % 2 === 0 ? "major" : "minor",
            bpm: 85 + (idx % 80),
            valence: 0.45 + ((idx % 4) * 0.1),
            energy: 0.45 + ((idx % 5) * 0.1),
            danceability: 0.4 + ((idx % 6) * 0.1),
            acousticness: 0.2 + ((idx % 5) * 0.1),
            instrumentalness: 0.1 + ((idx % 6) * 0.1),
            arousal: 0.3 + ((idx % 5) * 0.1),
            moodTags: idx % 3 === 0 ? ["energetic"] : ["relaxed"],
            lastfmTags: idx % 4 === 0 ? ["dreamy"] : ["party"],
            analysisStatus: "completed",
            album: {
                coverUrl: `${prefix}-cover-${i}.jpg`,
                genres: ["pop"],
                userGenres: null,
                artist: {
                    id: `${prefix}-artist-${Math.floor(idx / 2)}`,
                    userGenres: null,
                },
            },
        };

        const patch = overrides?.(idx) ?? {};
        return {
            ...base,
            ...patch,
            album: {
                ...base.album,
                ...(patch.album || {}),
                artist: {
                    ...base.album.artist,
                    ...(patch.album?.artist || {}),
                },
            },
        };
    });
}

function sampleMix(type: string): ProgrammaticMix {
    return {
        id: `sample-${type}`,
        type,
        name: "Sample",
        description: "Sample",
        trackIds: ["track-1"],
        coverUrls: [],
        trackCount: 1,
        color: "gradient",
    };
}

describe("ProgrammaticPlaylistService curated and mood-on-demand methods", () => {
    let service: ProgrammaticPlaylistService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        service = new ProgrammaticPlaylistService();
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(0);
    });

    it("generates high-energy and late-night mixes with fallback behavior", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(24, "high-energy"))
            .mockResolvedValueOnce(makeTracks(4, "late-night-enhanced"))
            .mockResolvedValueOnce(makeTracks(12, "late-night-standard"));

        const highEnergy = await service.generateHighEnergyMix(
            "user-1",
            "2026-02-17"
        );
        const lateNight = await service.generateLateNightMix(
            "user-1",
            "2026-02-17"
        );

        expect(highEnergy).not.toBeNull();
        expect(highEnergy!.trackCount).toBe(20);
        expect(lateNight).not.toBeNull();
        expect(lateNight!.trackCount).toBe(10);
    });

    it("generates happy, melancholy, dance-floor, acoustic, and instrumental mixes", async () => {
        const happyEnhanced = makeTracks(8, "happy-enhanced", () => ({
            moodHappy: 0.8,
            moodSad: 0.1,
        }));
        const happyStandard = makeTracks(16, "happy-standard");
        const melancholyStandard = makeTracks(18, "melancholy-standard", (idx) => ({
            keyScale: idx % 2 === 0 ? "minor" : "major",
            moodTags: idx % 3 === 0 ? ["melancholy"] : null,
            lastfmTags: idx % 4 === 0 ? ["emotional"] : null,
            valence: 0.2,
            energy: 0.3,
        }));

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(happyEnhanced)
            .mockResolvedValueOnce(happyStandard)
            .mockResolvedValueOnce(makeTracks(30, "melancholy-enhanced", () => ({
                moodSad: 0.75,
                moodHappy: 0.1,
            })))
            .mockResolvedValueOnce(makeTracks(22, "dance-floor"))
            .mockResolvedValueOnce(makeTracks(21, "acoustic"))
            .mockResolvedValueOnce(makeTracks(20, "instrumental"));

        const happy = await service.generateHappyMix("user-1", "2026-02-17");
        const melancholy = await service.generateMelancholyMix(
            "user-1",
            "2026-02-17"
        );
        const danceFloor = await service.generateDanceFloorMix(
            "user-1",
            "2026-02-17"
        );
        const acoustic = await service.generateAcousticMix(
            "user-1",
            "2026-02-17"
        );
        const instrumental = await service.generateInstrumentalMix(
            "user-1",
            "2026-02-17"
        );

        expect(happy?.trackCount).toBe(20);
        expect(melancholy?.trackCount).toBe(20);
        expect(danceFloor?.trackCount).toBe(20);
        expect(acoustic?.trackCount).toBe(20);
        expect(instrumental?.trackCount).toBe(20);
    });

    it("falls back to genre seed tracks when melancholy enhanced candidates are insufficient", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(10, "melancholy-enhanced-short"))
            .mockResolvedValueOnce(makeTracks(10, "melancholy-standard", () => ({
                moodTags: ["sad"],
                valence: 0.2,
                energy: 0.4,
            })))
            .mockResolvedValueOnce(makeTracks(10, "melancholy-genre-fallback"));

        const mix = await service.generateMelancholyMix("user-1", "2026-02-17");

        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(4);
        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(20);
    });

    it("returns null for mood-tag mixes below threshold and a mix when enough tracks exist", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(10, "mood-tag-too-small"))
            .mockResolvedValueOnce(makeTracks(17, "mood-tag-enough"));

        const tooSmall = await service.generateMoodTagMix(
            "user-1",
            "2026-02-17",
            "dreamy",
            "Dreamy Mix",
            "Dreamy tracks"
        );
        const enough = await service.generateMoodTagMix(
            "user-1",
            "2026-02-17",
            "dreamy",
            "Dreamy Mix",
            "Dreamy tracks"
        );

        expect(tooSmall).toBeNull();
        expect(enough).not.toBeNull();
        expect(enough!.trackCount).toBe(17);
    });

    it("generates road-trip mix after combining tag and audio strategies", async () => {
        const tagged = makeTracks(9, "road-tagged");
        const audio = makeTracks(12, "road-audio");

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(tagged)
            .mockResolvedValueOnce(audio);

        const mix = await service.generateRoadTripMix("user-1", "2026-02-17");

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(20);
    });

    it("dispatches day mix generation based on day-of-week", async () => {
        const sundaySpy = jest
            .spyOn(service, "generateSundayMix")
            .mockResolvedValue(sampleMix("sunday"));
        const mondaySpy = jest
            .spyOn(service, "generateMondayMix")
            .mockResolvedValue(sampleMix("monday"));
        const fridaySpy = jest
            .spyOn(service, "generateFridayMix")
            .mockResolvedValue(sampleMix("friday"));

        jest.useFakeTimers().setSystemTime(new Date("2026-02-22T12:00:00Z")); // Sunday
        expect((await service.generateDayMix("user-1"))?.type).toBe("sunday");

        jest.setSystemTime(new Date("2026-02-23T12:00:00Z")); // Monday
        expect((await service.generateDayMix("user-1"))?.type).toBe("monday");

        jest.setSystemTime(new Date("2026-02-27T12:00:00Z")); // Friday
        expect((await service.generateDayMix("user-1"))?.type).toBe("friday");

        jest.setSystemTime(new Date("2026-02-24T12:00:00Z")); // Tuesday
        expect(await service.generateDayMix("user-1")).toBeNull();

        expect(sundaySpy).toHaveBeenCalled();
        expect(mondaySpy).toHaveBeenCalled();
        expect(fridaySpy).toHaveBeenCalled();
    });

    it("generates Sunday, Monday, and Friday mixes directly", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(24, "sunday"))
            .mockResolvedValueOnce(makeTracks(24, "monday"))
            .mockResolvedValueOnce(makeTracks(24, "friday"));

        const sunday = await service.generateSundayMix("user-1", "2026-02-22");
        const monday = await service.generateMondayMix("user-1", "2026-02-23");
        const friday = await service.generateFridayMix("user-1", "2026-02-27");

        expect(sunday?.trackCount).toBe(20);
        expect(monday?.trackCount).toBe(20);
        expect(friday?.trackCount).toBe(20);
    });

    it("returns null for day-of-week mixes when tracks are below minimum", async () => {
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(10, "weekday-low")
        );

        const sunday = await service.generateSundayMix("user-1", "2026-02-22");
        const monday = await service.generateMondayMix("user-1", "2026-02-23");
        const friday = await service.generateFridayMix("user-1", "2026-02-27");

        expect(sunday).toBeNull();
        expect(monday).toBeNull();
        expect(friday).toBeNull();
    });

    it("generates curated daily vibe mixes with expected daily size", async () => {
        const dailyMethods: Array<keyof ProgrammaticPlaylistService> = [
            "generateMainCharacterEnergy",
            "generateVillainEra",
            "generate3AMThoughts",
            "generateHotGirlWalk",
            "generateRageCleaning",
            "generateGoldenHour",
            "generateShowerKaraoke",
            "generateInMyFeelings",
            "generateMidnightDrive",
            "generateRomanticizeYourLife",
            "generateThatGirlEra",
            "generateUnhinged",
        ];

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(30, "daily-vibes")
        );

        for (const method of dailyMethods) {
            const result = await (service[method] as unknown as (
                userId: string,
                today: string
            ) => Promise<ProgrammaticMix | null>)("user-1", "2026-02-17");
            expect(result).not.toBeNull();
            expect(result!.trackCount).toBe(10);
        }
    });

    it("returns null for curated daily vibe mixes when candidate pool is under minimum size", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-22T12:00:00Z"));
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(7, "daily-under-min")
        );

        const underMinimumMethods: Array<
            (userId: string, today: string) => Promise<ProgrammaticMix | null>
        > = [
            service.generateSadGirlSundays.bind(service),
            service.generateMainCharacterEnergy.bind(service),
            service.generateVillainEra.bind(service),
            service.generate3AMThoughts.bind(service),
            service.generateRomanticizeYourLife.bind(service),
        ];

        for (const run of underMinimumMethods) {
            const mix = await run("user-1", "2026-02-17");
            expect(mix).toBeNull();
        }
    });

    it("gates Sad Girl Sundays and Minor Key Mondays by weekday", async () => {
        jest.useFakeTimers();

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(24, "weekday-gated", (idx) => ({
                keyScale: idx % 2 === 0 ? "minor" : "major",
            }))
        );

        jest.setSystemTime(new Date("2026-02-22T12:00:00Z")); // Sunday
        const sunday = await service.generateSadGirlSundays(
            "user-1",
            "2026-02-22"
        );
        expect(sunday).not.toBeNull();
        expect(sunday!.trackCount).toBe(10);

        jest.setSystemTime(new Date("2026-02-23T12:00:00Z")); // Monday
        const monday = await service.generateMinorKeyMix("user-1", "2026-02-23");
        expect(monday).not.toBeNull();
        expect(monday!.trackCount).toBe(20);

        jest.setSystemTime(new Date("2026-02-24T12:00:00Z")); // Tuesday
        expect(
            await service.generateSadGirlSundays("user-1", "2026-02-24")
        ).toBeNull();
        expect(await service.generateMinorKeyMix("user-1", "2026-02-24")).toBeNull();
    });

    it("generates weekly deep cuts, key journey, tempo flow, and vocal detox mixes", async () => {
        const keyJourneyTracks = makeTracks(40, "key-journey");
        const tempoTracks = makeTracks(40, "tempo-flow", (idx) => ({
            bpm: idx < 14 ? 92 : idx < 28 ? 114 : 142,
        }));

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(28, "deep-cuts"))
            .mockResolvedValueOnce(keyJourneyTracks)
            .mockResolvedValueOnce(tempoTracks)
            .mockResolvedValueOnce(makeTracks(25, "vocal-detox", () => ({
                instrumentalness: 0.9,
            })));

        const deepCuts = await service.generateDeepCuts("user-1", "2026-02-17");
        const keyJourney = await service.generateKeyJourney("user-1", "2026-02-17");
        const tempoFlow = await service.generateTempoFlow("user-1", "2026-02-17");
        const vocalDetox = await service.generateVocalDetox("user-1", "2026-02-17");

        expect(deepCuts?.trackCount).toBe(20);
        expect(keyJourney?.trackCount).toBeGreaterThanOrEqual(15);
        expect(tempoFlow?.trackCount).toBeGreaterThanOrEqual(15);
        expect(vocalDetox?.trackCount).toBe(20);
    });

    it("returns null for tempo-flow when BPM bucket split cannot satisfy the arc", async () => {
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValueOnce(
            makeTracks(12, "tempo-flow-sparse", (idx) => ({
                bpm: idx < 4 ? 92 : idx < 8 ? 100 : 155,
            }))
        );

        const mix = await service.generateTempoFlow("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("uses low-play fallback path in deep cuts when never-played pool is too small", async () => {
        const lowPlayTracks = makeTracks(30, "low-play", (idx) => ({
            _count: { plays: idx < 22 ? 2 : 5 },
        }));

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(8, "deep-cuts-too-small"))
            .mockResolvedValueOnce(lowPlayTracks);

        const mix = await service.generateDeepCuts("user-1", "2026-02-17");
        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(20);
    });

    it("builds mood-on-demand query using fallback mapping when enhanced coverage is insufficient", async () => {
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(6);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(12, "mood-fallback")
        );

        const mix = await service.generateMoodOnDemand("user-1", {
            moodHappy: { min: 0.7 },
            moodRelaxed: { min: 0.5 },
            moodParty: { min: 0.6 },
            limit: 10,
        });

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(10);
        expect(mockPrisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    analysisStatus: "completed",
                    valence: expect.objectContaining({ gte: 0.7 }),
                    energy: expect.objectContaining({ lte: 0.75 }),
                    danceability: expect.objectContaining({ gte: 0.6 }),
                }),
                take: 100,
            })
        );
    });

    it("uses enhanced-mode mood filters for mood-on-demand when enough enhanced tracks exist", async () => {
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(22);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(18, "mood-enhanced", () => ({
                analysisMode: "enhanced",
                analysisVersion: "2.1b6-enhanced-v3.2",
                moodHappy: 0.8,
                moodElectronic: 0.7,
            }))
        );

        const mix = await service.generateMoodOnDemand("user-1", {
            moodHappy: { min: 0.65 },
            moodElectronic: { max: 0.8 },
            energy: { min: 0.4, max: 0.9 },
            keyScale: "minor",
            limit: 15,
        });

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(15);
        expect(mockPrisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    analysisMode: "enhanced",
                    analysisVersion: {
                        startsWith: "2.1b6-enhanced-v3",
                    },
                    moodHappy: expect.objectContaining({ gte: 0.65 }),
                    moodElectronic: expect.objectContaining({ lte: 0.8 }),
                    energy: expect.objectContaining({ gte: 0.4, lte: 0.9 }),
                    keyScale: "minor",
                }),
            })
        );
    });

    it("returns null for mood-on-demand when result set is below minimum threshold", async () => {
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(5, "mood-too-small")
        );

        const mix = await service.generateMoodOnDemand("user-1", {
            valence: { min: 0.6 },
            limit: 20,
        });
        expect(mix).toBeNull();
    });
});
