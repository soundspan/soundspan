import { CURATED_VIBE_MIXES, CuratedVibeMixDefinition } from "../curatedVibeMixDefinitions";
import { ProgrammaticMix, ProgrammaticPlaylistService } from "../programmaticPlaylists";
import { prisma } from "../../utils/db";

jest.mock("../../config", () => ({
    config: {
        generationDiversity: { weightAlpha: 0.5, shareCeiling: 0.3 },
    },
}));

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

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeTracks(count: number, prefix: string) {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        albumId: `${prefix}-album-${i}`,
        album: {
            coverUrl: `${prefix}-cover-${i}.jpg`,
            artist: {
                id: `${prefix}-artist-${Math.floor(i / 2)}`,
            },
        },
    }));
}

type CuratedVibeMixGenerator =
    | "generateSadGirlSundays"
    | "generateMainCharacterEnergy"
    | "generateVillainEra"
    | "generate3AMThoughts"
    | "generateHotGirlWalk"
    | "generateRageCleaning"
    | "generateGoldenHour"
    | "generateShowerKaraoke"
    | "generateInMyFeelings"
    | "generateMidnightDrive"
    | "generateRomanticizeYourLife"
    | "generateThatGirlEra"
    | "generateUnhinged";

const GENERATOR_METHOD_BY_TYPE: Record<
    CuratedVibeMixDefinition["type"],
    CuratedVibeMixGenerator
> = {
    "sad-girl-sundays": "generateSadGirlSundays",
    "main-character": "generateMainCharacterEnergy",
    "villain-era": "generateVillainEra",
    "3am-thoughts": "generate3AMThoughts",
    "hot-girl-walk": "generateHotGirlWalk",
    "rage-cleaning": "generateRageCleaning",
    "golden-hour": "generateGoldenHour",
    "shower-karaoke": "generateShowerKaraoke",
    "in-my-feelings": "generateInMyFeelings",
    "midnight-drive": "generateMidnightDrive",
    romanticize: "generateRomanticizeYourLife",
    "that-girl-era": "generateThatGirlEra",
    unhinged: "generateUnhinged",
};

const KNOWN_CURATED_VIBE_MIX_TYPES = [
    "sad-girl-sundays",
    "main-character",
    "villain-era",
    "3am-thoughts",
    "hot-girl-walk",
    "rage-cleaning",
    "golden-hour",
    "shower-karaoke",
    "in-my-feelings",
    "midnight-drive",
    "romanticize",
    "that-girl-era",
    "unhinged",
];

describe("ProgrammaticPlaylistService data-driven curated vibe mixes", () => {
    let service: ProgrammaticPlaylistService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        service = new ProgrammaticPlaylistService();
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue([]);
    });

    it("catalog contains exactly the 13 known curated vibe mix types", () => {
        expect(new Set(CURATED_VIBE_MIXES.map((definition) => definition.type))).toEqual(
            new Set(KNOWN_CURATED_VIBE_MIX_TYPES)
        );
        expect(CURATED_VIBE_MIXES.length).toBe(13);
    });

    it("every definition is well-formed", () => {
        for (const definition of CURATED_VIBE_MIXES) {
            expect(typeof definition.type === "string" && definition.type.length > 0).toBe(
                true
            );
            expect(typeof definition.name === "string" && definition.name.length > 0).toBe(
                true
            );
            expect(
                typeof definition.description === "string" &&
                    definition.description.length > 0
            ).toBe(true);
            expect(
                typeof definition.colorKey === "string" && definition.colorKey.length > 0
            ).toBe(true);
            expect(definition.take).toBeGreaterThanOrEqual(50);
            expect(typeof definition.where).toBe("object");
            expect(definition.where).not.toBeNull();
        }
    });

    it("each definition drives its generator's output and query", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-22T12:00:00Z"));

        for (const definition of CURATED_VIBE_MIXES) {
            (mockPrisma.track.findMany as jest.Mock).mockReset();
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
                makeTracks(30, definition.type)
            );

            const methodName = GENERATOR_METHOD_BY_TYPE[definition.type];
            const mix: ProgrammaticMix | null = await service[methodName](
                "user-1",
                "2026-02-17"
            );

            expect(mix).not.toBeNull();
            expect(mix!.type).toBe(definition.type);
            expect(mix!.name).toBe(definition.name);
            expect(mix!.description).toBe(definition.description);
            expect(mix!.id).toBe(`${definition.type}-2026-02-17`);
            expect(mix!.trackCount).toBe(10);
            expect(typeof mix!.color === "string" && mix!.color.length > 0).toBe(true);

            const calls = (mockPrisma.track.findMany as jest.Mock).mock.calls;
            const mostRecentCall = calls[calls.length - 1];
            expect(mostRecentCall[0]).toEqual({
                where: {
                    analysisStatus: "completed",
                    ...definition.where,
                },
                include: {
                    album: {
                        select: {
                            coverUrl: true,
                        },
                    },
                },
                take: definition.take,
            });
        }
    });

    it("sad-girl-sundays is gated to Sunday", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-24T12:00:00Z"));
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(30, "sad-girl-sundays")
        );

        await expect(
            service.generateSadGirlSundays("user-1", "2026-02-17")
        ).resolves.toBeNull();

        const sadGirlSundays = CURATED_VIBE_MIXES.find(
            (definition) => definition.type === "sad-girl-sundays"
        );
        expect(sadGirlSundays?.dayOfWeek).toBe(0);
    });
});
