jest.mock("../../config", () => ({
    config: {
        vibeProviderUrl: "http://provider:8090",
        redisUrl: "redis://mock:6379",
        internalApiSecret: "test-secret",
    },
}));

const mockJobDebug = jest.fn();
const mockLogger = {
    debug: (...args: unknown[]) => mockJobDebug(...args),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => mockLogger,
};

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import {
    createVibeEmbedJobProcessor,
    isTransientVibeProviderFailure,
} from "../vibeEmbedJobs";
import {
    VibeProviderBackpressureError,
    VibeProviderContractError,
    VibeProviderRequestError,
    VibeProviderServerError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "../vibeProvider";
import {
    EmbeddingTargetInvalidatedError,
    VibeEmbeddingGenerationMismatchError,
} from "../trackEmbeddings";

describe("vibe provider retry classification", () => {
    it.each([
        new VibeProviderTimeoutError(),
        new VibeProviderUnavailableError(),
        new VibeProviderServerError(503),
        new VibeProviderBackpressureError(429),
    ])("classifies %s as transient", (error) => {
        expect(isTransientVibeProviderFailure(error)).toBe(true);
    });

    it.each([
        new VibeProviderContractError(),
        new VibeProviderRequestError(404),
        new Error("database write failed"),
    ])("classifies %s as terminal", (error) => {
        expect(isTransientVibeProviderFailure(error)).toBe(false);
    });
});

describe("vibe embed job processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function createHarness() {
        const prisma = {
            track: {
                findFirst: jest.fn(),
                updateMany: jest.fn(async () => ({ count: 1 })),
                update: jest.fn(async () => undefined),
            },
        };
        const embedAudio = jest.fn(async () => [0.6, 0.8]);
        const upsertTrackEmbedding = jest.fn(async () => undefined);
        const recordFailure = jest.fn(async () => undefined);
        const resolveByEntity = jest.fn(async () => false);
        const releaseReservation = jest.fn(async () => undefined);
        const recordOutcome = jest.fn();
        const describeFailure = jest.fn((error: unknown) =>
            error instanceof Error ? error.message : "Embedding failed",
        );
        const isTransientFailure = jest.fn(() => false);
        const isRetryEligible = jest.fn(async () => true);
        const scheduleRetry = jest.fn(async () => undefined);
        const now = jest.fn(() => new Date("2026-08-16T12:00:00.000Z"));
        const processJob = createVibeEmbedJobProcessor({
            targetSpaceId: "space-provider",
            targetSpaceDim: 2,
            prisma,
            embedAudio,
            upsertTrackEmbedding,
            failureService: { recordFailure, resolveByEntity },
            releaseReservation,
            recordOutcome,
            describeFailure,
            isTransientFailure,
            isRetryEligible,
            scheduleRetry,
            now,
        });

        return {
            prisma,
            embedAudio,
            upsertTrackEmbedding,
            recordFailure,
            resolveByEntity,
            releaseReservation,
            recordOutcome,
            isTransientFailure,
            isRetryEligible,
            scheduleRetry,
            processJob,
        };
    }

    it("claims, embeds, stores, and completes an active track", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-1",
            title: "Track One",
        });

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-1",
                    filePath: "artist/track.flac",
                    duration: 180,
                }),
            ),
        ).resolves.toBe("stored");

        expect(harness.prisma.track.updateMany).toHaveBeenNthCalledWith(1, {
            where: {
                id: "track-1",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisGeneration: 0,
                OR: [
                    { vibeAnalysisStatus: "pending" },
                    {
                        vibeAnalysisStatus: null,
                        embeddings: { none: { spaceId: "space-provider" } },
                    },
                    {
                        vibeAnalysisStatus: "completed",
                        embeddings: { none: { spaceId: "space-provider" } },
                    },
                ],
            },
            data: {
                vibeAnalysisStatus: "processing",
                vibeAnalysisStartedAt: new Date("2026-08-16T12:00:00.000Z"),
                vibeAnalysisStatusUpdatedAt: new Date(
                    "2026-08-16T12:00:00.000Z",
                ),
            },
        });
        expect(harness.releaseReservation).toHaveBeenCalledWith("track-1");
        expect(harness.embedAudio).toHaveBeenCalledWith("artist/track.flac", {
            id: "space-provider",
            dim: 2,
        });
        expect(harness.upsertTrackEmbedding).toHaveBeenCalledWith(
            "track-1",
            [0.6, 0.8],
            "space-provider",
            {
                generation: 0,
                completedAt: new Date("2026-08-16T12:00:00.000Z"),
            },
        );
        expect(harness.prisma.track.updateMany).toHaveBeenCalledTimes(1);
        expect(harness.resolveByEntity).toHaveBeenCalledWith("vibe", "track-1");
        expect(harness.recordOutcome).toHaveBeenCalledWith("stored");
    });

    it("records provider failures with the sidecar field contract", async () => {
        const harness = createHarness();
        const longMessage = "x".repeat(600);
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-2",
            title: "Track Two",
        });
        harness.embedAudio.mockRejectedValue(new Error(longMessage));

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-2",
                    filePath: "artist/broken.flac",
                }),
            ),
        ).resolves.toBe("embed_failed");

        const truncated = longMessage.slice(0, 500);
        expect(harness.prisma.track.updateMany).toHaveBeenCalledWith({
            where: {
                id: "track-2",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisStatus: "processing",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisGeneration: 0,
            },
            data: {
                vibeAnalysisStatus: "failed",
                vibeAnalysisError: truncated,
                vibeAnalysisRetryCount: { increment: 1 },
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: new Date(
                    "2026-08-16T12:00:00.000Z",
                ),
            },
        });
        expect(harness.recordFailure).toHaveBeenCalledWith({
            entityType: "vibe",
            entityId: "track-2",
            entityName: "Track Two",
            errorMessage: truncated,
            errorCode: "VIBE_EMBEDDING_FAILED",
        });
        expect(harness.upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(harness.recordOutcome).toHaveBeenCalledWith("embed_failed");
    });

    it("resets transient provider failures to pending below the retry bound", async () => {
        const harness = createHarness();
        const transient = new Error("provider unavailable");
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-retry",
            title: "Retry Track",
            vibeAnalysisRetryCount: 0,
        });
        harness.embedAudio.mockRejectedValue(transient);
        harness.isTransientFailure.mockReturnValue(true);

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-retry",
                    filePath: "artist/retry.flac",
                }),
            ),
        ).resolves.toBe("embed_failed");

        expect(harness.prisma.track.updateMany).toHaveBeenLastCalledWith({
            where: {
                id: "track-retry",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisStatus: "processing",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisGeneration: 0,
            },
            data: {
                vibeAnalysisStatus: "pending",
                vibeAnalysisError: "provider unavailable",
                vibeAnalysisRetryCount: { increment: 1 },
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: new Date(
                    "2026-08-16T12:00:00.000Z",
                ),
            },
        });
        expect(harness.recordFailure).not.toHaveBeenCalled();
        expect(harness.scheduleRetry).toHaveBeenCalledWith(
            "track-retry",
            new Date("2026-08-16T12:00:30.000Z"),
        );
    });

    it("skips a pending candidate until its retry not-before passes", async () => {
        const harness = createHarness();
        harness.isRetryEligible.mockResolvedValue(false);

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-delayed",
                    filePath: "artist/delayed.flac",
                }),
            ),
        ).resolves.toBe("stale_claim");

        expect(harness.releaseReservation).toHaveBeenCalledWith(
            "track-delayed",
        );
        expect(harness.prisma.track.findFirst).not.toHaveBeenCalled();
        expect(harness.embedAudio).not.toHaveBeenCalled();
    });

    it.each([
        { retryAfterMs: 1_000, expectedDelayMs: 30_000 },
        { retryAfterMs: 900_000, expectedDelayMs: 300_000 },
    ])(
        "bounds provider Retry-After $retryAfterMs to $expectedDelayMs milliseconds",
        async ({ retryAfterMs, expectedDelayMs }) => {
            const harness = createHarness();
            harness.prisma.track.findFirst.mockResolvedValue({
                id: "track-backpressure",
                title: "Backpressure Track",
                vibeAnalysisRetryCount: 0,
            });
            harness.embedAudio.mockRejectedValue(
                new VibeProviderBackpressureError(
                    429,
                    "queue full",
                    retryAfterMs,
                ),
            );
            harness.isTransientFailure.mockReturnValue(true);

            await harness.processJob(
                JSON.stringify({
                    trackId: "track-backpressure",
                    filePath: "artist/backpressure.flac",
                }),
            );

            expect(harness.scheduleRetry).toHaveBeenCalledWith(
                "track-backpressure",
                new Date(
                    Date.parse("2026-08-16T12:00:00.000Z") + expectedDelayMs,
                ),
            );
        },
    );

    it("marks transient provider failures terminal at the retry bound", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-exhausted",
            title: "Exhausted Track",
            vibeAnalysisRetryCount: 2,
        });
        harness.embedAudio.mockRejectedValue(new Error("provider timeout"));
        harness.isTransientFailure.mockReturnValue(true);

        await harness.processJob(
            JSON.stringify({
                trackId: "track-exhausted",
                filePath: "artist/exhausted.flac",
            }),
        );

        expect(harness.prisma.track.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    vibeAnalysisStatus: "failed",
                    vibeAnalysisRetryCount: { increment: 1 },
                }),
            }),
        );
        expect(harness.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({ entityId: "track-exhausted" }),
        );
        expect(harness.scheduleRetry).not.toHaveBeenCalled();
    });

    it.each(["not-json", JSON.stringify({ filePath: "track.flac" })])(
        "drops malformed payload without a parseable track ID: %s",
        async (payload) => {
            const harness = createHarness();

            await expect(harness.processJob(payload)).resolves.toBe(
                "invalid_payload",
            );

            expect(harness.prisma.track.findFirst).not.toHaveBeenCalled();
            expect(harness.prisma.track.update).not.toHaveBeenCalled();
            expect(harness.releaseReservation).not.toHaveBeenCalled();
            expect(harness.embedAudio).not.toHaveBeenCalled();
            expect(harness.recordOutcome).toHaveBeenCalledWith(
                "invalid_payload",
            );
        },
    );

    it.each([
        { filePath: null },
        { filePath: "" },
        { filePath: "artist/track.flac", duration: -1 },
    ])(
        "fails malformed payload for a parseable track ID: %o",
        async (fields) => {
            const harness = createHarness();
            harness.prisma.track.findFirst.mockResolvedValue({
                id: "track-3",
                title: "Track Three",
            });

            await expect(
                harness.processJob(
                    JSON.stringify({ trackId: "track-3", ...fields }),
                ),
            ).resolves.toBe("invalid_payload");

            expect(harness.prisma.track.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "track-3",
                    origin: "LOCAL",
                    removedAt: null,
                    vibeAnalysisGeneration: 0,
                    OR: [
                        { vibeAnalysisStatus: null },
                        { vibeAnalysisStatus: "pending" },
                        { vibeAnalysisStatus: "processing" },
                    ],
                    embeddings: { none: { spaceId: "space-provider" } },
                },
                data: {
                    vibeAnalysisStatus: "failed",
                    vibeAnalysisError: "Invalid vibe embedding job payload",
                    vibeAnalysisRetryCount: { increment: 1 },
                    vibeAnalysisStatusUpdatedAt: new Date(
                        "2026-08-16T12:00:00.000Z",
                    ),
                },
            });
            expect(harness.recordFailure).toHaveBeenCalledWith({
                entityType: "vibe",
                entityId: "track-3",
                entityName: "Track Three",
                errorMessage: "Invalid vibe embedding job payload",
                errorCode: "VIBE_EMBEDDING_FAILED",
            });
            expect(harness.releaseReservation).toHaveBeenCalledWith("track-3");
            expect(harness.embedAudio).not.toHaveBeenCalled();
            expect(harness.recordOutcome).toHaveBeenCalledWith(
                "invalid_payload",
            );
        },
    );

    it("never demotes a completed track on an invalid payload", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-3",
            title: "Track Three",
            vibeAnalysisStatus: "completed",
            embeddings: [],
        });

        await expect(
            harness.processJob(JSON.stringify({ trackId: "track-3" })),
        ).resolves.toBe("invalid_payload");

        expect(harness.recordFailure).not.toHaveBeenCalled();
        expect(harness.prisma.track.updateMany).not.toHaveBeenCalled();
        expect(harness.releaseReservation).toHaveBeenCalledWith("track-3");
    });

    it("never demotes a track with a target-space vector on an invalid payload", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-stored",
            title: "Stored Track",
            vibeAnalysisStatus: "pending",
            embeddings: [{ spaceId: "space-provider" }],
        });

        await harness.processJob(JSON.stringify({ trackId: "track-stored" }));

        expect(harness.prisma.track.updateMany).not.toHaveBeenCalled();
        expect(harness.recordFailure).not.toHaveBeenCalled();
        expect(harness.recordOutcome).toHaveBeenCalledWith("invalid_payload");
    });

    it.each(["../x", "/music/x", "..\\x", "artist/\0x"])(
        "rejects unsafe file path %p before calling the provider",
        async (filePath) => {
            const harness = createHarness();
            harness.prisma.track.findFirst.mockResolvedValue({
                id: "track-path",
                title: "Unsafe Track",
            });

            await expect(
                harness.processJob(
                    JSON.stringify({ trackId: "track-path", filePath }),
                ),
            ).resolves.toBe("invalid_payload");

            expect(harness.embedAudio).not.toHaveBeenCalled();
            expect(harness.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({
                    entityId: "track-path",
                    errorMessage: "Invalid vibe embedding job payload",
                }),
            );
            expect(harness.releaseReservation).toHaveBeenCalledWith(
                "track-path",
            );
            expect(harness.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({
                    entityId: "track-path",
                    errorMessage: "Invalid vibe embedding job payload",
                }),
            );
        },
    );

    it("short-circuits missing or removed tracks before inference", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue(null);

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "removed-track",
                    filePath: "artist/removed.flac",
                }),
            ),
        ).resolves.toBe("track_missing");

        expect(harness.prisma.track.findFirst).toHaveBeenCalledWith({
            where: {
                id: "removed-track",
                origin: "LOCAL",
                removedAt: null,
            },
            select: {
                id: true,
                title: true,
                vibeAnalysisRetryCount: true,
                vibeAnalysisStatus: true,
                vibeAnalysisGeneration: true,
            },
        });
        expect(harness.releaseReservation).toHaveBeenCalledWith(
            "removed-track",
        );
        expect(harness.embedAudio).not.toHaveBeenCalled();
        expect(harness.recordOutcome).toHaveBeenCalledWith("track_missing");
    });

    it("records a stale claim when an existing track no longer matches the claim CAS", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-stale",
            title: "Stale Track",
        });
        harness.prisma.track.updateMany.mockResolvedValue({ count: 0 });

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-stale",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("stale_claim");

        expect(harness.releaseReservation).toHaveBeenCalledWith("track-stale");
        expect(harness.embedAudio).not.toHaveBeenCalled();
        expect(harness.recordOutcome).toHaveBeenCalledWith("stale_claim");
        expect(mockJobDebug).toHaveBeenCalledWith(
            "Skipped stale vibe embedding job claim",
            { trackId: "track-stale" },
        );
    });

    it("claims completed tracks missing the target-space vector", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-migrating",
            title: "Migrating Track",
            vibeAnalysisStatus: "completed",
            vibeAnalysisRetryCount: 3,
            vibeAnalysisGeneration: 7,
        });

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-migrating",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("stored");

        expect(harness.prisma.track.updateMany).toHaveBeenNthCalledWith(1, {
            where: {
                id: "track-migrating",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisGeneration: 7,
                OR: [
                    { vibeAnalysisStatus: "pending" },
                    {
                        vibeAnalysisStatus: null,
                        embeddings: { none: { spaceId: "space-provider" } },
                    },
                    {
                        vibeAnalysisStatus: "completed",
                        embeddings: { none: { spaceId: "space-provider" } },
                    },
                ],
            },
            data: expect.objectContaining({
                vibeAnalysisStatus: "processing",
                vibeAnalysisRetryCount: 0,
            }),
        });
    });

    it("gives a pending 2.2 track a fresh DCLAP retry budget", async () => {
        const harness = createHarness();
        const transient = new Error("provider unavailable");
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-historic-retries",
            title: "Historic Retries",
            vibeAnalysisStatus: "pending",
            vibeAnalysisRetryCount: 3,
            vibeAnalysisGeneration: 4,
        });
        harness.embedAudio.mockRejectedValue(transient);
        harness.isTransientFailure.mockReturnValue(true);

        await harness.processJob(
            JSON.stringify({
                trackId: "track-historic-retries",
                filePath: "artist/retry.flac",
            }),
        );

        expect(harness.prisma.track.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                data: expect.objectContaining({ vibeAnalysisRetryCount: 0 }),
            }),
        );
        expect(harness.prisma.track.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    vibeAnalysisRetryCount: 0,
                    vibeAnalysisGeneration: 4,
                }),
                data: expect.objectContaining({
                    vibeAnalysisStatus: "pending",
                    vibeAnalysisRetryCount: { increment: 1 },
                }),
            }),
        );
        expect(harness.recordFailure).not.toHaveBeenCalled();
    });

    it("rejects an old completion after force increments the generation and re-embeds", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst
            .mockResolvedValueOnce({
                id: "track-force-race",
                title: "Force Race",
                vibeAnalysisStatus: "pending",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisGeneration: 0,
            })
            .mockResolvedValueOnce({
                id: "track-force-race",
                title: "Force Race",
                vibeAnalysisStatus: "pending",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisGeneration: 1,
            });
        harness.prisma.track.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });
        harness.upsertTrackEmbedding
            .mockRejectedValueOnce(
                new VibeEmbeddingGenerationMismatchError("track-force-race", 0),
            )
            .mockResolvedValueOnce(undefined);
        const payload = JSON.stringify({
            trackId: "track-force-race",
            filePath: "artist/force.flac",
        });

        await expect(harness.processJob(payload)).resolves.toBe("stale_claim");
        await expect(harness.processJob(payload)).resolves.toBe("stored");

        expect(harness.upsertTrackEmbedding).toHaveBeenCalledTimes(2);
        expect(harness.resolveByEntity).toHaveBeenCalledTimes(1);
        expect(harness.prisma.track.updateMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    vibeAnalysisGeneration: 1,
                }),
            }),
        );
    });

    it("does not reclaim a completed track already stored in the target space", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-backfilled",
            title: "Backfilled Track",
        });
        harness.prisma.track.updateMany.mockResolvedValue({ count: 0 });

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-backfilled",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("stale_claim");

        expect(harness.embedAudio).not.toHaveBeenCalled();
        expect(harness.upsertTrackEmbedding).not.toHaveBeenCalled();
    });

    it("marks a pending track failed for an invalid payload", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-invalid",
            title: "Invalid Track",
            vibeAnalysisStatus: "pending",
            embeddings: [],
        });

        await harness.processJob(JSON.stringify({ trackId: "track-invalid" }));

        expect(harness.prisma.track.updateMany).toHaveBeenCalledWith({
            where: {
                id: "track-invalid",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisGeneration: 0,
                OR: [
                    { vibeAnalysisStatus: null },
                    { vibeAnalysisStatus: "pending" },
                    { vibeAnalysisStatus: "processing" },
                ],
                embeddings: { none: { spaceId: "space-provider" } },
            },
            data: expect.objectContaining({ vibeAnalysisStatus: "failed" }),
        });
    });

    it("treats a removed track during transactional finalization as stale", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValueOnce({
            id: "track-4",
            title: "Track Four",
        });
        harness.upsertTrackEmbedding.mockRejectedValueOnce(
            new VibeEmbeddingGenerationMismatchError("track-4", 0),
        );

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-4",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("stale_claim");

        expect(harness.embedAudio).toHaveBeenCalledTimes(1);
        expect(harness.upsertTrackEmbedding).toHaveBeenCalledTimes(1);
        expect(harness.recordOutcome).toHaveBeenCalledWith("stale_claim");
    });

    it("resets and surfaces a target invalidation without marking the track failed", async () => {
        const harness = createHarness();
        const error = new EmbeddingTargetInvalidatedError("space-provider");
        harness.prisma.track.findFirst.mockResolvedValueOnce({
            id: "track-retired-target",
            title: "Retired Target",
            vibeAnalysisGeneration: 6,
        });
        harness.upsertTrackEmbedding.mockRejectedValueOnce(error);

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-retired-target",
                    filePath: "artist/track.flac",
                }),
            ),
        ).rejects.toBe(error);

        expect(harness.prisma.track.updateMany).toHaveBeenLastCalledWith({
            where: {
                id: "track-retired-target",
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisStatus: "processing",
                vibeAnalysisGeneration: 6,
            },
            data: expect.objectContaining({
                vibeAnalysisStatus: "pending",
                vibeAnalysisStartedAt: null,
            }),
        });
        expect(harness.recordFailure).not.toHaveBeenCalled();
    });
});
