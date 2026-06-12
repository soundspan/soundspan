const mockPrisma = {
    track: { findUnique: jest.fn(), findMany: jest.fn() },
    moodBucket: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
    },
    userMoodMix: { upsert: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
    $connect: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
            code: string;
            constructor(message: string, meta: { code: string }) {
                super(message);
                this.code = meta.code;
            }
        },
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: jest.fn((arr: unknown[]) => [...arr]),
}));

jest.mock("../programmaticPlaylistArtistCap", () => ({
    applyArtistCap: jest.fn((tracks: unknown[]) => tracks),
}));

jest.mock("../../utils/separateArtists", () => ({
    separateArtists: jest.fn((tracks: unknown[]) => tracks),
}));

import { Prisma } from "../../utils/db";
import { separateArtists } from "../../utils/separateArtists";
import { MOOD_CONFIG, MoodBucketService, VALID_MOODS } from "../moodBucketService";
import { applyArtistCap } from "../programmaticPlaylistArtistCap";

type TestTrack = {
    id: string;
    analysisStatus?: string;
    analysisMode: string | null;
    analysisVersion: string | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    valence: number | null;
    energy: number | null;
    arousal: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    bpm: number | null;
    keyScale: string | null;
    moodTags: string[];
};

const makeTrack = (overrides: Partial<TestTrack> = {}): TestTrack => ({
    id: "track-1",
    analysisStatus: "completed",
    analysisMode: "standard",
    analysisVersion: "1.0",
    moodHappy: 0.8,
    moodSad: 0.1,
    moodRelaxed: 0.2,
    moodAggressive: 0.2,
    moodParty: 0.8,
    moodAcoustic: 0.2,
    moodElectronic: 0.1,
    valence: 0.7,
    energy: 0.8,
    arousal: 0.8,
    danceability: 0.9,
    acousticness: 0.2,
    instrumentalness: 0.2,
    bpm: 130,
    keyScale: "major",
    moodTags: [],
    ...overrides,
});

type PrismaMockTypes = {
    PrismaClientKnownRequestError: new (
        message: string,
        meta: { code: string }
    ) => Error & { code: string };
    PrismaClientRustPanicError: new (message: string) => Error;
    PrismaClientUnknownRequestError: new (message: string) => Error;
};

type PrivateMoodBucketService = {
    isRetryablePrismaError: (error: unknown) => boolean;
    withPrismaRetry: <T>(
        operationName: string,
        operation: () => Promise<T>
    ) => Promise<T>;
    evaluateMoodRules: (
        track: TestTrack,
        rules: Record<string, unknown>
    ) => number;
};

const prismaTypes = Prisma as unknown as PrismaMockTypes;

const asPrivate = (instance: MoodBucketService): PrivateMoodBucketService =>
    instance as unknown as PrivateMoodBucketService;

describe("MoodBucketService", () => {
    let service: MoodBucketService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new MoodBucketService();
        mockPrisma.$connect.mockResolvedValue(undefined);
        mockPrisma.$transaction.mockResolvedValue([]);
        mockPrisma.moodBucket.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.moodBucket.upsert.mockResolvedValue({});
    });

    describe("isRetryablePrismaError", () => {
        it("handles all supported Prisma error types and messages", () => {
            const privateService = asPrivate(service);
            const knownRetryable = new prismaTypes.PrismaClientKnownRequestError(
                "known retryable",
                { code: "P1001" }
            );
            const knownNonRetryable = new prismaTypes.PrismaClientKnownRequestError(
                "known non-retryable",
                { code: "P2002" }
            );
            const rustPanic = new prismaTypes.PrismaClientRustPanicError("panic");
            const unknownRetryable =
                new prismaTypes.PrismaClientUnknownRequestError(
                "Engine has already exited"
            );
            const unknownNonRetryable =
                new prismaTypes.PrismaClientUnknownRequestError("other unknown");

            expect(privateService.isRetryablePrismaError(knownRetryable)).toBe(true);
            expect(privateService.isRetryablePrismaError(knownNonRetryable)).toBe(false);
            expect(privateService.isRetryablePrismaError(rustPanic)).toBe(true);
            expect(privateService.isRetryablePrismaError(unknownRetryable)).toBe(true);
            expect(privateService.isRetryablePrismaError(unknownNonRetryable)).toBe(false);
            expect(
                privateService.isRetryablePrismaError(
                    new Error("Can't reach database server")
                )
            ).toBe(true);
            expect(privateService.isRetryablePrismaError(new Error("boom"))).toBe(false);
        });
    });

    describe("withPrismaRetry", () => {
        it("returns immediately on first successful attempt", async () => {
            const privateService = asPrivate(service);
            const op = jest.fn().mockResolvedValue("ok");
            await expect(privateService.withPrismaRetry("op", op)).resolves.toBe("ok");
            expect(op).toHaveBeenCalledTimes(1);
            expect(mockPrisma.$connect).not.toHaveBeenCalled();
        });

        it("retries retryable error then succeeds", async () => {
            const privateService = asPrivate(service);
            const timeoutSpy = jest
                .spyOn(global, "setTimeout")
                .mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
                    if (typeof handler === "function") handler();
                    return 0 as unknown as ReturnType<typeof setTimeout>;
                }) as typeof setTimeout);

            const op = jest
                .fn()
                .mockRejectedValueOnce(new Error("Response from the Engine was empty"))
                .mockResolvedValueOnce("done");

            await expect(privateService.withPrismaRetry("op", op)).resolves.toBe("done");
            expect(op).toHaveBeenCalledTimes(2);
            expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
            timeoutSpy.mockRestore();
        });

        it("throws immediately for non-retryable errors", async () => {
            const privateService = asPrivate(service);
            const err = new Error("fatal");
            const op = jest.fn().mockRejectedValue(err);

            await expect(privateService.withPrismaRetry("op", op)).rejects.toBe(err);
            expect(op).toHaveBeenCalledTimes(1);
            expect(mockPrisma.$connect).not.toHaveBeenCalled();
        });

        it("throws after max retry attempts are exhausted", async () => {
            const privateService = asPrivate(service);
            const timeoutSpy = jest
                .spyOn(global, "setTimeout")
                .mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
                    if (typeof handler === "function") handler();
                    return 0 as unknown as ReturnType<typeof setTimeout>;
                }) as typeof setTimeout);

            const err = new Error("Connection reset");
            const op = jest.fn().mockRejectedValue(err);

            await expect(privateService.withPrismaRetry("op", op)).rejects.toBe(err);
            expect(op).toHaveBeenCalledTimes(3);
            expect(mockPrisma.$connect).toHaveBeenCalledTimes(2);
            timeoutSpy.mockRestore();
        });

        it("throws synthesized error when retries disabled and lastError is not Error", async () => {
            const privateService = asPrivate(service);
            Object.defineProperty(service as unknown as object, "PRISMA_RETRY_ATTEMPTS", {
                value: 0,
            });
            const op = jest.fn().mockRejectedValue("string error");

            await expect(privateService.withPrismaRetry("op", op)).rejects.toThrow(
                "[MoodBucket] op failed after retries"
            );
            expect(op).not.toHaveBeenCalled();
        });
    });

    describe("calculateMoodScores and rules", () => {
        it("uses enhanced primary rules when reliable enhanced version prefix is present", () => {
            const enhancedScores = service.calculateMoodScores(
                makeTrack({
                    analysisMode: "enhanced",
                    analysisVersion: "2.1b6-enhanced-v3-hotfix",
                    moodHappy: 0.9,
                    moodSad: 0.1,
                    valence: 0.2,
                    energy: 0.2,
                })
            );

            const nonEnhancedScores = service.calculateMoodScores(
                makeTrack({
                    analysisMode: "enhanced",
                    analysisVersion: "2.1b5-enhanced-v2",
                    moodHappy: 0.9,
                    moodSad: 0.1,
                    valence: 0.2,
                    energy: 0.2,
                })
            );

            expect(enhancedScores.happy).toBeGreaterThan(0.5);
            expect(nonEnhancedScores.happy).toBe(0);
        });

        it("uses mood tags when individual mood fields are absent", () => {
            const scores = service.calculateMoodScores(
                makeTrack({
                    moodHappy: null,
                    moodSad: null,
                    moodRelaxed: null,
                    moodAggressive: null,
                    moodParty: null,
                    moodAcoustic: null,
                    moodElectronic: null,
                    valence: null,
                    energy: null,
                    arousal: null,
                    danceability: null,
                    acousticness: null,
                    instrumentalness: null,
                    bpm: null,
                    keyScale: null,
                    moodTags: ["HAPPY", "upbeat", "joyful"],
                })
            );

            expect(scores.happy).toBeCloseTo(0.7, 5);
            expect(scores.sad).toBe(0);
        });

        it("falls back to rules when neither individual moods nor mood tags exist", () => {
            const scores = service.calculateMoodScores(
                makeTrack({
                    moodHappy: null,
                    moodSad: null,
                    moodTags: [],
                    valence: 0.8,
                    energy: 0.9,
                })
            );

            expect(scores.happy).toBeGreaterThan(0.5);
        });

        it("returns zero scores when mood tags have no keyword matches", () => {
            const scores = service.calculateMoodScores(
                makeTrack({
                    moodHappy: null,
                    moodSad: null,
                    moodTags: ["mysterious", "cinematic"],
                    valence: null,
                    energy: null,
                })
            );

            expect(Object.values(scores).every((score) => score === 0)).toBe(true);
        });

        it("evaluates mood rules across string and numeric constraint branches", () => {
            const privateService = asPrivate(service);
            expect(
                privateService.evaluateMoodRules(
                    makeTrack({ keyScale: "minor" }),
                    { keyScale: "minor" }
                )
            ).toBe(1);

            expect(
                privateService.evaluateMoodRules(
                    makeTrack({ keyScale: "major" }),
                    { keyScale: "minor" }
                )
            ).toBe(0);

            expect(
                privateService.evaluateMoodRules(makeTrack({ energy: 0.5 }), {
                    energy: { min: 0.4, max: 0.6 },
                })
            ).toBe(1);

            expect(
                privateService.evaluateMoodRules(makeTrack({ energy: 0.1 }), {
                    energy: { min: 0.4, max: 0.6 },
                })
            ).toBe(0);

            expect(
                privateService.evaluateMoodRules(makeTrack({ energy: 0.9 }), {
                    energy: { min: 0.4, max: 0.6 },
                })
            ).toBe(0);

            expect(
                privateService.evaluateMoodRules(makeTrack({ valence: 0.9 }), {
                    valence: { min: 0.6 },
                })
            ).toBeCloseTo(0.65, 5);

            expect(
                privateService.evaluateMoodRules(makeTrack({ valence: 0.2 }), {
                    valence: { min: 0.6 },
                })
            ).toBe(0);

            expect(
                privateService.evaluateMoodRules(makeTrack({ arousal: 0.2 }), {
                    arousal: { max: 0.5 },
                })
            ).toBeCloseTo(0.65, 5);

            expect(
                privateService.evaluateMoodRules(makeTrack({ arousal: 0.8 }), {
                    arousal: { max: 0.5 },
                })
            ).toBe(0);

            expect(
                privateService.evaluateMoodRules(makeTrack({ energy: null }), {
                    energy: { min: 0.6 },
                })
            ).toBe(0);
        });
    });

    describe("getMoodMix and user mix flows", () => {
        it("throws for invalid mood value", async () => {
            const invalidMood = "invalid" as unknown as (typeof VALID_MOODS)[number];
            await expect(service.getMoodMix(invalidMood)).rejects.toThrow(
                "Invalid mood: invalid"
            );
        });

        it("returns null when mood pool has fewer than eight tracks", async () => {
            mockPrisma.moodBucket.findMany.mockResolvedValue(
                Array.from({ length: 7 }, (_, i) => ({ trackId: `t-${i}`, score: 0.8 }))
            );

            await expect(service.getMoodMix("happy")).resolves.toBeNull();
            expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
        });

        it("returns valid mix and applies artist diversity pipeline", async () => {
            const buckets = Array.from({ length: 10 }, (_, i) => ({
                trackId: `track-${i + 1}`,
                score: 1 - i * 0.05,
            }));
            const tracks = buckets.map((bucket, i) => ({
                id: bucket.trackId,
                album: {
                    coverUrl: i < 5 ? `cover-${i + 1}.jpg` : null,
                    artist: { id: i < 3 ? "artist-a" : `artist-${i}` },
                },
            }));
            mockPrisma.moodBucket.findMany.mockResolvedValue(buckets);
            mockPrisma.track.findMany.mockResolvedValue(tracks);

            const mix = await service.getMoodMix("chill", 8);
            expect(mix).not.toBeNull();
            if (!mix) {
                throw new Error("Expected non-null mix");
            }
            expect(mix.mood).toBe("chill");
            expect(mix.trackCount).toBe(10);
            expect(mix.coverUrls.length).toBeLessThanOrEqual(4);
            expect((applyArtistCap as jest.Mock).mock.calls[0][1]).toEqual(
                expect.objectContaining({ maxPerArtist: 2, targetCount: 8 })
            );
            expect(separateArtists).toHaveBeenCalled();
        });

        it("saveUserMoodMix returns null when mix generation fails", async () => {
            jest.spyOn(service, "getMoodMix").mockResolvedValue(null);
            await expect(service.saveUserMoodMix("user-1", "focus")).resolves.toBeNull();
            expect(mockPrisma.userMoodMix.upsert).not.toHaveBeenCalled();
        });

        it("getUserMoodMix returns null for missing and invalid persisted moods", async () => {
            mockPrisma.userMoodMix.findUnique.mockResolvedValueOnce(null);
            await expect(service.getUserMoodMix("u1")).resolves.toBeNull();

            mockPrisma.userMoodMix.findUnique.mockResolvedValueOnce({
                mood: "not-real",
                generatedAt: new Date(),
                trackIds: ["a"],
                coverUrls: [],
            });
            await expect(service.getUserMoodMix("u1")).resolves.toBeNull();
        });

        it("getUserMoodMix returns valid response for saved mood", async () => {
            mockPrisma.userMoodMix.findUnique.mockResolvedValue({
                mood: "party",
                generatedAt: new Date("2026-01-01T00:00:00.000Z"),
                trackIds: ["t1", "t2"],
                coverUrls: ["c1"],
            });

            const mix = await service.getUserMoodMix("u2");
            expect(mix).toEqual(
                expect.objectContaining({
                    type: "mood",
                    mood: "party",
                    trackCount: 2,
                    name: `Your ${MOOD_CONFIG.party.name} Mix`,
                })
            );
        });
    });

    describe("backfillAllTracks and assignTrackToMoods", () => {
        it("returns zeroes when first backfill batch is empty", async () => {
            mockPrisma.track.findMany.mockResolvedValueOnce([]);
            await expect(service.backfillAllTracks(10)).resolves.toEqual({
                processed: 0,
                assigned: 0,
            });
            expect(mockPrisma.moodBucket.upsert).not.toHaveBeenCalled();
        });

        it("backfills multiple batches and only upserts moods with score > 0", async () => {
            mockPrisma.track.findMany
                .mockResolvedValueOnce([
                    makeTrack({
                        id: "b1",
                        moodHappy: null,
                        moodSad: null,
                        moodTags: ["happy"],
                    }),
                ])
                .mockResolvedValueOnce([
                    makeTrack({
                        id: "b2",
                        moodHappy: null,
                        moodSad: null,
                        moodRelaxed: null,
                        moodAggressive: null,
                        moodParty: null,
                        moodAcoustic: null,
                        moodElectronic: null,
                        moodTags: [],
                        valence: null,
                        energy: null,
                        arousal: null,
                        danceability: null,
                        acousticness: null,
                        instrumentalness: null,
                        bpm: null,
                        keyScale: null,
                    }),
                ])
                .mockResolvedValueOnce([]);

            const result = await service.backfillAllTracks(1);
            expect(result.processed).toBe(2);
            expect(result.assigned).toBe(1);
            expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ skip: 0, take: 1 })
            );
            expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ skip: 1, take: 1 })
            );
            expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({ skip: 2, take: 1 })
            );
            expect(mockPrisma.moodBucket.upsert).toHaveBeenCalledTimes(1);
        });

        it("assignTrackToMoods returns empty when track not found or analysis not complete", async () => {
            mockPrisma.track.findUnique.mockResolvedValueOnce(null);
            await expect(service.assignTrackToMoods("missing")).resolves.toEqual([]);

            mockPrisma.track.findUnique.mockResolvedValueOnce(
                makeTrack({ analysisStatus: "processing" })
            );
            await expect(service.assignTrackToMoods("processing")).resolves.toEqual([]);

            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });

        it("assignTrackToMoods issues only delete operations when all scores are zero", async () => {
            mockPrisma.track.findUnique.mockResolvedValue(
                makeTrack({
                    moodHappy: null,
                    moodSad: null,
                    moodRelaxed: null,
                    moodAggressive: null,
                    moodParty: null,
                    moodAcoustic: null,
                    moodElectronic: null,
                    moodTags: [],
                    valence: null,
                    energy: null,
                    arousal: null,
                    danceability: null,
                    acousticness: null,
                    instrumentalness: null,
                    bpm: null,
                    keyScale: null,
                })
            );

            const assigned = await service.assignTrackToMoods("zero-track");
            expect(assigned).toEqual([]);
            expect(mockPrisma.moodBucket.upsert).not.toHaveBeenCalled();
            expect(mockPrisma.moodBucket.deleteMany).toHaveBeenCalledTimes(
                VALID_MOODS.length
            );
            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        });

        it("assignTrackToMoods issues upserts for positive scores and deletes for zeros", async () => {
            mockPrisma.track.findUnique.mockResolvedValue(
                makeTrack({
                    moodHappy: null,
                    moodSad: null,
                    moodTags: ["happy", "party"],
                })
            );

            const assigned = await service.assignTrackToMoods("mixed-track");
            expect(assigned).toEqual(expect.arrayContaining(["happy", "party"]));
            expect(mockPrisma.moodBucket.upsert).toHaveBeenCalledTimes(2);
            expect(mockPrisma.moodBucket.deleteMany).toHaveBeenCalledTimes(
                VALID_MOODS.length - 2
            );
            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        });
    });

    describe("exports sanity", () => {
        it("exports all mood keys as valid moods", () => {
            expect(VALID_MOODS.sort()).toEqual(Object.keys(MOOD_CONFIG).sort());
        });
    });
});
