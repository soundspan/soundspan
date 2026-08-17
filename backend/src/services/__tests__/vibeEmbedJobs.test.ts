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

import { createVibeEmbedJobProcessor } from "../vibeEmbedJobs";

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
        const now = jest.fn(() => new Date("2026-08-16T12:00:00.000Z"));
        const processJob = createVibeEmbedJobProcessor({
            prisma,
            embedAudio,
            upsertTrackEmbedding,
            failureService: { recordFailure, resolveByEntity },
            releaseReservation,
            recordOutcome,
            describeFailure,
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

        expect(harness.prisma.track.updateMany).toHaveBeenCalledWith({
            where: {
                id: "track-1",
                origin: "LOCAL",
                removedAt: null,
                OR: [
                    { vibeAnalysisStatus: null },
                    { vibeAnalysisStatus: "pending" },
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
        expect(harness.embedAudio).toHaveBeenCalledWith("artist/track.flac");
        expect(harness.upsertTrackEmbedding).toHaveBeenCalledWith(
            "track-1",
            [0.6, 0.8],
        );
        expect(harness.prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                vibeAnalysisStatus: "completed",
                vibeAnalysisError: null,
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: new Date(
                    "2026-08-16T12:00:00.000Z",
                ),
            },
        });
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
                OR: [
                    { vibeAnalysisStatus: null },
                    { vibeAnalysisStatus: "pending" },
                    { vibeAnalysisStatus: "processing" },
                ],
            },
            data: {
                vibeAnalysisStatus: "failed",
                vibeAnalysisError: truncated,
                vibeAnalysisRetryCount: { increment: 1 },
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
                    OR: [
                        { vibeAnalysisStatus: null },
                        { vibeAnalysisStatus: "pending" },
                        { vibeAnalysisStatus: "processing" },
                    ],
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

    it("never demotes a settled track on an invalid payload", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst.mockResolvedValue({
            id: "track-3",
            title: "Track Three",
        });
        harness.prisma.track.updateMany.mockResolvedValue({ count: 0 });

        await expect(
            harness.processJob(JSON.stringify({ trackId: "track-3" })),
        ).resolves.toBe("invalid_payload");

        expect(harness.recordFailure).not.toHaveBeenCalled();
        expect(harness.releaseReservation).toHaveBeenCalledWith("track-3");
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
            select: { id: true, title: true },
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

    it("does not store when the track is removed during inference", async () => {
        const harness = createHarness();
        harness.prisma.track.findFirst
            .mockResolvedValueOnce({ id: "track-4", title: "Track Four" })
            .mockResolvedValueOnce(null);

        await expect(
            harness.processJob(
                JSON.stringify({
                    trackId: "track-4",
                    filePath: "artist/track.flac",
                }),
            ),
        ).resolves.toBe("track_missing");

        expect(harness.embedAudio).toHaveBeenCalledTimes(1);
        expect(harness.upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(harness.recordOutcome).toHaveBeenCalledWith("track_missing");
    });
});
