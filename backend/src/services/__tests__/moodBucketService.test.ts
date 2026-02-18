import { MoodBucketService } from "../moodBucketService";
import { prisma, Prisma } from "../../utils/db";

jest.mock("../../utils/db", () => ({
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
            code = "P0000";
        },
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError:
            class PrismaClientUnknownRequestError extends Error {},
    },
    prisma: {
        $connect: jest.fn(),
        $transaction: jest.fn(),
        moodBucket: {
            findMany: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
            count: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
        },
        userMoodMix: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: <T>(items: T[]) => items,
}));

type MockTrack = {
    id: string;
    album: {
        coverUrl: string | null;
        artist: {
            id: string;
        };
    };
};

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function getMaxPerArtist(trackIds: string[], tracksById: Map<string, MockTrack>): number {
    const counts = new Map<string, number>();
    for (const trackId of trackIds) {
        const track = tracksById.get(trackId);
        if (!track) continue;
        const artistId = track.album.artist.id;
        counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
    }
    return Math.max(...Array.from(counts.values()));
}

describe("MoodBucketService.getMoodMix", () => {
    let service: MoodBucketService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new MoodBucketService();
    });

    it("enforces artist diversity for mood mixes when pool is sufficient", async () => {
        const moodBuckets = Array.from({ length: 30 }, (_, i) => ({
            trackId: `mood-track-${i + 1}`,
            score: 0.9 - i * 0.01,
        }));
        const tracks: MockTrack[] = moodBuckets.map((bucket, index) => ({
            id: bucket.trackId,
            album: {
                coverUrl: `cover-${bucket.trackId}.jpg`,
                artist: {
                    id: index < 6 ? "dominant-artist" : `artist-${index}`,
                },
            },
        }));

        (mockPrisma.moodBucket.findMany as jest.Mock).mockResolvedValue(moodBuckets);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

        const mix = await service.getMoodMix("chill", 15);
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);

        const tracksById = new Map(tracks.map((track) => [track.id, track]));
        expect(getMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("returns available tracks in sparse pools via fallback fill", async () => {
        const moodBuckets = Array.from({ length: 8 }, (_, i) => ({
            trackId: `sparse-track-${i + 1}`,
            score: 0.8 - i * 0.01,
        }));
        const tracks: MockTrack[] = moodBuckets.map((bucket, index) => ({
            id: bucket.trackId,
            album: {
                coverUrl: `cover-${bucket.trackId}.jpg`,
                artist: {
                    id: index < 6 ? "dominant-artist" : `artist-${index}`,
                },
            },
        }));

        (mockPrisma.moodBucket.findMany as jest.Mock).mockResolvedValue(moodBuckets);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

        const mix = await service.getMoodMix("party", 15);
        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(8);
    });

    it("returns null when mood bucket pool is below minimum threshold", async () => {
        (mockPrisma.moodBucket.findMany as jest.Mock).mockResolvedValue(
            Array.from({ length: 7 }, (_, i) => ({
                trackId: `too-few-${i + 1}`,
                score: 0.7,
            }))
        );

        const mix = await service.getMoodMix("happy", 10);
        expect(mix).toBeNull();
    });

    it("throws when mood is not a supported mood preset", async () => {
        await expect(service.getMoodMix("not-a-mood" as any)).rejects.toThrow(
            "Invalid mood: not-a-mood"
        );
    });
});

describe("MoodBucketService.calculateMoodScores aggressive gating", () => {
    let service: MoodBucketService;

    beforeEach(() => {
        service = new MoodBucketService();
    });

    it("does not classify mellow tracks as aggressive from borderline moodAggressive alone", () => {
        const scores = service.calculateMoodScores({
            id: "mellow-track",
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3",
            moodHappy: 0.2,
            moodSad: 0.3,
            moodRelaxed: 0.82,
            moodAggressive: 0.56,
            moodParty: 0.2,
            moodAcoustic: 0.6,
            moodElectronic: 0.1,
            valence: 0.35,
            energy: 0.22,
            arousal: 0.24,
            danceability: 0.2,
            acousticness: 0.7,
            instrumentalness: 0.5,
            bpm: 78,
            keyScale: "minor",
            moodTags: ["chill", "relaxed"],
        });

        expect(scores.aggressive).toBe(0);
    });

    it("classifies truly high-intensity tracks as aggressive", () => {
        const scores = service.calculateMoodScores({
            id: "intense-track",
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3",
            moodHappy: 0.2,
            moodSad: 0.2,
            moodRelaxed: 0.14,
            moodAggressive: 0.88,
            moodParty: 0.62,
            moodAcoustic: 0.1,
            moodElectronic: 0.7,
            valence: 0.48,
            energy: 0.91,
            arousal: 0.87,
            danceability: 0.71,
            acousticness: 0.08,
            instrumentalness: 0.2,
            bpm: 148,
            keyScale: "minor",
            moodTags: ["aggressive", "intense"],
        });

        expect(scores.aggressive).toBeGreaterThan(0.5);
    });

    it("uses mood tags when numeric mood fields are not populated", () => {
        const scores = service.calculateMoodScores({
            id: "tagged-track",
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3",
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
            moodTags: ["Happy", "Party", "acoustic"],
        });

        expect(scores.happy).toBe(0.3);
        expect(scores.party).toBe(0.3);
        expect(scores.acoustic).toBe(0.3);
        expect(scores.sad).toBe(0);
    });
});

describe("MoodBucketService resilience runtime", () => {
    let service: MoodBucketService;

    beforeEach(() => {
        jest.resetAllMocks();
        service = new MoodBucketService();
        (mockPrisma.$connect as jest.Mock).mockResolvedValue(undefined);
        (mockPrisma.$transaction as jest.Mock).mockResolvedValue([]);
        (mockPrisma.moodBucket.upsert as jest.Mock).mockResolvedValue({});
        (mockPrisma.moodBucket.deleteMany as jest.Mock).mockResolvedValue({
            count: 0,
        });
    });

    function mockImmediateTimers() {
        return jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((handler: (...args: any[]) => void) => {
                if (typeof handler === "function") {
                    handler();
                }
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);
    }

    function completedTrackForRetry() {
        return {
            id: "track-1",
            analysisStatus: "completed",
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3",
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
            moodTags: ["happy", "upbeat"],
        };
    }

    it("retries transient Prisma engine-empty failures in assignTrackToMoods", async () => {
        const setTimeoutSpy = mockImmediateTimers();

        (mockPrisma.track.findUnique as jest.Mock)
            .mockRejectedValueOnce(new Error("Response from the Engine was empty"))
            .mockResolvedValueOnce(completedTrackForRetry());

        const assigned = await service.assignTrackToMoods("track-1");

        expect(assigned).toContain("happy");
        expect(mockPrisma.track.findUnique).toHaveBeenCalledTimes(2);
        expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockPrisma.moodBucket.upsert).toHaveBeenCalled();

        setTimeoutSpy.mockRestore();
    });

    it("retries Prisma known and rust panic transient failures before success", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        const knownTransient = new (Prisma as any).PrismaClientKnownRequestError(
            "too many clients"
        );
        knownTransient.code = "P2037";
        const rustPanic = new (Prisma as any).PrismaClientRustPanicError(
            "panic"
        );

        (mockPrisma.track.findUnique as jest.Mock)
            .mockRejectedValueOnce(knownTransient)
            .mockRejectedValueOnce(rustPanic)
            .mockResolvedValueOnce(completedTrackForRetry());

        await expect(service.assignTrackToMoods("track-1")).resolves.toContain(
            "happy"
        );

        expect(mockPrisma.$connect).toHaveBeenCalledTimes(2);
        expect(mockPrisma.track.findUnique).toHaveBeenCalledTimes(3);
        setTimeoutSpy.mockRestore();
    });

    it("retries Prisma unknown request transient failures before success", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        const unknownTransient = new (Prisma as any).PrismaClientUnknownRequestError(
            "Engine has already exited"
        );
        (mockPrisma.track.findUnique as jest.Mock)
            .mockRejectedValueOnce(unknownTransient)
            .mockResolvedValueOnce(completedTrackForRetry());

        await expect(service.assignTrackToMoods("track-1")).resolves.toContain(
            "happy"
        );
        expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
        expect(mockPrisma.track.findUnique).toHaveBeenCalledTimes(2);
        setTimeoutSpy.mockRestore();
    });

    it("does not retry non-retryable known Prisma errors", async () => {
        const nonRetryable = new (Prisma as any).PrismaClientKnownRequestError(
            "unique constraint"
        );
        nonRetryable.code = "P2002";
        (mockPrisma.track.findUnique as jest.Mock).mockRejectedValueOnce(
            nonRetryable
        );

        await expect(service.assignTrackToMoods("track-1")).rejects.toBe(
            nonRetryable
        );
        expect(mockPrisma.track.findUnique).toHaveBeenCalledTimes(1);
        expect(mockPrisma.$connect).not.toHaveBeenCalled();
    });

    it("returns empty moods when track is missing or not completed", async () => {
        (mockPrisma.track.findUnique as jest.Mock).mockResolvedValueOnce({
            ...completedTrackForRetry(),
            analysisStatus: "processing",
        });

        await expect(service.assignTrackToMoods("track-1")).resolves.toEqual([]);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("backfills analyzed tracks and upserts mood assignments", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-backfill-1",
                    analysisMode: "enhanced",
                    analysisVersion: "2.1b6-enhanced-v3",
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
                    moodTags: ["happy"],
                },
            ])
            .mockResolvedValueOnce([]);

        const result = await service.backfillAllTracks(1);

        expect(result).toEqual({ processed: 1, assigned: 1 });
        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ skip: 0, take: 1 })
        );
        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ skip: 1, take: 1 })
        );
        expect(mockPrisma.moodBucket.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    trackId_mood: {
                        trackId: "track-backfill-1",
                        mood: "happy",
                    },
                },
            })
        );
    });

    it("clears all mood buckets for a track", async () => {
        await service.clearTrackMoods("track-clear-1");

        expect(mockPrisma.moodBucket.deleteMany).toHaveBeenCalledWith({
            where: { trackId: "track-clear-1" },
        });
    });

    it("retries clearTrackMoods after transient connection resets", async () => {
        const setTimeoutSpy = mockImmediateTimers();
        (mockPrisma.moodBucket.deleteMany as jest.Mock)
            .mockRejectedValueOnce(new Error("Connection reset"))
            .mockResolvedValueOnce({ count: 1 });

        await expect(service.clearTrackMoods("track-clear-2")).resolves.toBe(
            undefined
        );
        expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
        expect(mockPrisma.moodBucket.deleteMany).toHaveBeenCalledTimes(2);
        setTimeoutSpy.mockRestore();
    });

    it("returns null for saved mixes with invalid mood references", async () => {
        (mockPrisma.userMoodMix.findUnique as jest.Mock).mockResolvedValue({
            mood: "not-a-mood",
            generatedAt: new Date("2026-01-01T00:00:00.000Z"),
            trackIds: ["track-1"],
            coverUrls: [],
        });

        const mix = await service.getUserMoodMix("user-1");
        expect(mix).toBeNull();
    });

    it("returns null when requested user mix cannot be regenerated", async () => {
        jest.spyOn(service, "getMoodMix").mockResolvedValue(null);
        await expect(service.saveUserMoodMix("user-1", "chill")).resolves.toBeNull();
    });

    it("throws generic retry exhaustion error when retry attempts are disabled", async () => {
        Object.defineProperty(service as any, "PRISMA_RETRY_ATTEMPTS", {
            value: 0,
        });
        (mockPrisma.moodBucket.deleteMany as jest.Mock).mockResolvedValue({
            count: 0,
        });

        await expect(service.clearTrackMoods("track-clear-3")).rejects.toThrow(
            "[MoodBucket] clearTrackMoods.deleteMany failed after retries"
        );
    });
});
