const tracks = [
    {
        id: "track-1",
        title: "Track One",
        filePath: "artist/track.flac",
        origin: "LOCAL",
        removedAt: null,
        vibeAnalysisStatus: "completed" as string | null,
        vibeAnalysisGeneration: 0,
        vibeAnalysisRetryCount: 0,
        embeddingSpaceIds: new Set(["space-active"]),
    },
];

function targetGateMatches(
    or: Array<{
        vibeAnalysisStatus: string | null;
        embeddings?: { none: { spaceId: string } };
    }>,
): boolean {
    return or.some((candidate) => {
        if (candidate.vibeAnalysisStatus !== tracks[0].vibeAnalysisStatus) {
            return false;
        }
        const targetSpaceId = candidate.embeddings?.none.spaceId;
        return (
            !targetSpaceId || !tracks[0].embeddingSpaceIds.has(targetSpaceId)
        );
    });
}

const mockTrackFindMany = jest.fn(async (args: any) => {
    const statuses = args.where.OR;
    if (!targetGateMatches(statuses)) return [];
    return [{ id: tracks[0].id, filePath: tracks[0].filePath }];
});
const mockTrackFindFirst = jest.fn(async () => ({
    id: tracks[0].id,
    title: tracks[0].title,
    vibeAnalysisStatus: tracks[0].vibeAnalysisStatus,
    vibeAnalysisGeneration: tracks[0].vibeAnalysisGeneration,
    vibeAnalysisRetryCount: tracks[0].vibeAnalysisRetryCount,
}));
const mockTrackUpdateMany = jest.fn(async (args: any) => {
    const matchesTargetGate = Array.isArray(args.where.OR)
        ? targetGateMatches(args.where.OR)
        : args.where.vibeAnalysisStatus === tracks[0].vibeAnalysisStatus;
    const matchesGeneration =
        args.where.vibeAnalysisGeneration === undefined ||
        args.where.vibeAnalysisGeneration === tracks[0].vibeAnalysisGeneration;
    if (!matchesTargetGate || !matchesGeneration) {
        return { count: 0 };
    }
    tracks[0].vibeAnalysisStatus = args.data.vibeAnalysisStatus;
    tracks[0].vibeAnalysisRetryCount =
        args.data.vibeAnalysisRetryCount ?? tracks[0].vibeAnalysisRetryCount;
    return { count: 1 };
});
const mockTrackUpdate = jest.fn(async (args: any) => {
    tracks[0].vibeAnalysisStatus = args.data.vibeAnalysisStatus;
});

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: (args: unknown) => mockTrackFindMany(args),
            findFirst: () => mockTrackFindFirst(),
            updateMany: (args: unknown) => mockTrackUpdateMany(args),
            update: (args: unknown) => mockTrackUpdate(args),
        },
    },
}));

jest.mock("../../utils/annQuery", () => ({ runAnnQuery: jest.fn() }));

jest.mock("../vibeProvider", () => ({
    embedAudio: jest.fn(),
    VibeProviderError: class VibeProviderError extends Error {},
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { del: jest.fn(async () => 1) },
}));

jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: jest.fn(async () => ({ id: "space-new-active" })),
    getVibeEmbeddingTargetSpaceId: jest.fn(async () => "space-new-active"),
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: () => logger,
    };
    return { logger };
});

import { findLocalTracksNeedingActiveEmbedding } from "../trackEmbeddings";
import { createVibeEmbedJobProcessor } from "../vibeEmbedJobs";

describe("target-space selection through claim", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tracks[0].vibeAnalysisStatus = "completed";
        tracks[0].vibeAnalysisGeneration = 0;
        tracks[0].vibeAnalysisRetryCount = 0;
        tracks[0].embeddingSpaceIds = new Set(["space-active"]);
    });

    function createProcessor() {
        return createVibeEmbedJobProcessor({
            targetSpaceId: "space-new-active",
            targetSpaceDim: 2,
            prisma: {
                track: {
                    findFirst: mockTrackFindFirst,
                    updateMany: mockTrackUpdateMany,
                    update: mockTrackUpdate,
                },
            },
            embedAudio: jest.fn(async () => [0.6, 0.8]),
            upsertTrackEmbedding: jest.fn(
                async (_trackId, _vector, spaceId) => {
                    tracks[0].embeddingSpaceIds.add(spaceId);
                },
            ),
            failureService: {
                recordFailure: jest.fn(async () => undefined),
                resolveByEntity: jest.fn(async () => false),
            },
            releaseReservation: jest.fn(async () => undefined),
            recordOutcome: jest.fn(),
            describeFailure: jest.fn(() => "failed"),
            isTransientFailure: jest.fn(() => false),
            isRetryEligible: jest.fn(async () => true),
            scheduleRetry: jest.fn(async () => undefined),
            now: () => new Date("2026-08-16T12:00:00.000Z"),
        });
    }

    it("self-heals a completed post-cutover tail into the new active space", async () => {
        const selected = await findLocalTracksNeedingActiveEmbedding(
            25,
            "space-new-active",
        );

        expect(selected).toEqual([
            { id: "track-1", filePath: "artist/track.flac" },
        ]);
        await expect(
            createProcessor()(
                JSON.stringify({
                    trackId: selected[0].id,
                    filePath: selected[0].filePath,
                }),
            ),
        ).resolves.toBe("stored");
        expect(tracks[0].embeddingSpaceIds).toContain("space-new-active");
    });

    it("does not select or claim a completed track with an active-space vector", async () => {
        tracks[0].embeddingSpaceIds.add("space-new-active");

        await expect(
            findLocalTracksNeedingActiveEmbedding(25, "space-new-active"),
        ).resolves.toEqual([]);

        await expect(
            createProcessor()(
                JSON.stringify({
                    trackId: "track-1",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("stale_claim");
    });
});
