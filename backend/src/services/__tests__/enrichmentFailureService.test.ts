const logger = {
    info: jest.fn(),
    debug: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger,
}));

const prisma = {
    enrichmentFailure: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    artist: {
        findUnique: jest.fn(),
    },
    track: {
        findUnique: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import { enrichmentFailureService } from "../enrichmentFailureService";

describe("enrichmentFailureService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe("recordFailure", () => {
        it("creates a new failure when no existing record is found", async () => {
            const metadata = {
                source: "worker",
                details: {
                    attempt: 1,
                },
            };

            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce(null);
            prisma.enrichmentFailure.create.mockResolvedValueOnce({
                id: "failure-1",
                entityType: "artist",
                entityId: "artist-1",
                entityName: "Artist One",
                errorMessage: "fetch failed",
                errorCode: "E_FETCH",
                retryCount: 1,
                maxRetries: 3,
                metadata,
            });

            const result = await enrichmentFailureService.recordFailure({
                entityType: "artist",
                entityId: "artist-1",
                entityName: "Artist One",
                errorMessage: "fetch failed",
                errorCode: "E_FETCH",
                metadata,
            });

            expect(prisma.enrichmentFailure.findUnique).toHaveBeenCalledWith({
                where: {
                    entityType_entityId: {
                        entityType: "artist",
                        entityId: "artist-1",
                    },
                },
            });
            expect(prisma.enrichmentFailure.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    entityType: "artist",
                    entityId: "artist-1",
                    entityName: "Artist One",
                    errorMessage: "fetch failed",
                    errorCode: "E_FETCH",
                    retryCount: 1,
                    maxRetries: 3,
                    metadata,
                }),
            });
            expect(
                prisma.enrichmentFailure.create.mock.calls[0][0].data.metadata
            ).not.toBe(metadata);
            expect(result).toEqual(
                expect.objectContaining({
                    id: "failure-1",
                    retryCount: 1,
                })
            );
        });

        it("updates an existing failure, caps retry count, and falls back to existing metadata", async () => {
            const existingMetadata = {
                previous: true,
            };

            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce({
                id: "failure-2",
                retryCount: 3,
                maxRetries: 3,
                metadata: existingMetadata,
            });
            prisma.enrichmentFailure.update.mockResolvedValueOnce({
                id: "failure-2",
                retryCount: 3,
                metadata: existingMetadata,
            });

            const result = await enrichmentFailureService.recordFailure({
                entityType: "track",
                entityId: "track-9",
                errorMessage: "timeout",
                errorCode: "E_TIMEOUT",
            });

            expect(prisma.enrichmentFailure.update).toHaveBeenCalledWith({
                where: { id: "failure-2" },
                data: {
                    errorMessage: "timeout",
                    errorCode: "E_TIMEOUT",
                    retryCount: 3,
                    lastFailedAt: expect.any(Date),
                    metadata: existingMetadata,
                },
            });
            expect(result).toEqual(
                expect.objectContaining({
                    id: "failure-2",
                    retryCount: 3,
                    metadata: existingMetadata,
                })
            );
        });

        it("creates a new failure with null metadata when metadata is omitted", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce(null);
            prisma.enrichmentFailure.create.mockResolvedValueOnce({
                id: "failure-null-metadata",
                entityType: "audio",
                entityId: "audio-99",
                entityName: null,
                errorMessage: "transcode failed",
                errorCode: null,
                retryCount: 1,
                maxRetries: 3,
                metadata: null,
            });

            const result = await enrichmentFailureService.recordFailure({
                entityType: "audio",
                entityId: "audio-99",
                errorMessage: "transcode failed",
            });

            expect(prisma.enrichmentFailure.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    entityType: "audio",
                    entityId: "audio-99",
                    errorMessage: "transcode failed",
                    retryCount: 1,
                    maxRetries: 3,
                    metadata: null,
                }),
            });
            expect(result).toEqual(expect.objectContaining({ metadata: null }));
        });
    });

    describe("getFailures", () => {
        it("applies default unresolved/unskipped filters and returns failures with total", async () => {
            const failures = [{ id: "f1" }];
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce(failures);
            prisma.enrichmentFailure.count.mockResolvedValueOnce(11);

            const result = await enrichmentFailureService.getFailures();

            expect(prisma.enrichmentFailure.findMany).toHaveBeenCalledWith({
                where: {
                    skipped: false,
                    resolved: false,
                },
                orderBy: { lastFailedAt: "desc" },
                take: 100,
                skip: 0,
            });
            expect(prisma.enrichmentFailure.count).toHaveBeenCalledWith({
                where: {
                    skipped: false,
                    resolved: false,
                },
            });
            expect(result).toEqual({ failures, total: 11 });
        });

        it("supports includeSkipped/includeResolved/entityType filters and pagination", async () => {
            const failures = [{ id: "f-track" }];
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce(failures);
            prisma.enrichmentFailure.count.mockResolvedValueOnce(1);

            const result = await enrichmentFailureService.getFailures({
                entityType: "track",
                includeSkipped: true,
                includeResolved: true,
                limit: 25,
                offset: 50,
            });

            expect(prisma.enrichmentFailure.findMany).toHaveBeenCalledWith({
                where: {
                    entityType: "track",
                },
                orderBy: { lastFailedAt: "desc" },
                take: 25,
                skip: 50,
            });
            expect(prisma.enrichmentFailure.count).toHaveBeenCalledWith({
                where: {
                    entityType: "track",
                },
            });
            expect(result).toEqual({ failures, total: 1 });
        });
    });

    it("aggregates unresolved and unskipped counts by entity type", async () => {
        prisma.enrichmentFailure.count
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(4)
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(6);

        const result = await enrichmentFailureService.getFailureCounts();

        expect(prisma.enrichmentFailure.count).toHaveBeenNthCalledWith(1, {
            where: {
                entityType: "artist",
                resolved: false,
                skipped: false,
            },
        });
        expect(prisma.enrichmentFailure.count).toHaveBeenNthCalledWith(2, {
            where: {
                entityType: "track",
                resolved: false,
                skipped: false,
            },
        });
        expect(prisma.enrichmentFailure.count).toHaveBeenNthCalledWith(3, {
            where: {
                entityType: "audio",
                resolved: false,
                skipped: false,
            },
        });
        expect(prisma.enrichmentFailure.count).toHaveBeenNthCalledWith(4, {
            where: {
                entityType: "vibe",
                resolved: false,
                skipped: false,
            },
        });
        expect(result).toEqual({
            artist: 3,
            track: 4,
            audio: 5,
            vibe: 6,
            total: 18,
        });
    });

    it("passes through count for skipFailures", async () => {
        prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 2 });

        const result = await enrichmentFailureService.skipFailures(["a", "b"]);

        expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["a", "b"] } },
            data: {
                skipped: true,
                skippedAt: expect.any(Date),
            },
        });
        expect(result).toBe(2);
    });

    it("passes through count for resolveFailures", async () => {
        prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 7 });

        const result = await enrichmentFailureService.resolveFailures(["x"]);

        expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["x"] } },
            data: {
                resolved: true,
                resolvedAt: expect.any(Date),
            },
        });
        expect(result).toBe(7);
    });

    it("passes through count for resetRetryCount", async () => {
        prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 4 });

        const result = await enrichmentFailureService.resetRetryCount(["r1", "r2"]);

        expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["r1", "r2"] } },
            data: {
                retryCount: 0,
            },
        });
        expect(result).toBe(4);
    });

    it("passes through count for deleteFailures", async () => {
        prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 3 });

        const result = await enrichmentFailureService.deleteFailures(["d1"]);

        expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["d1"] } },
        });
        expect(result).toBe(3);
    });

    describe("clearAllFailures", () => {
        it("clears unresolved/unskipped failures and logs without type filter", async () => {
            prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 9 });

            const result = await enrichmentFailureService.clearAllFailures();

            expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
                where: {
                    resolved: false,
                    skipped: false,
                },
            });
            expect(logger.info).toHaveBeenCalledWith(
                "Cleared 9 enrichment failures"
            );
            expect(result).toBe(9);
        });

        it("applies optional entity type filter and logs typed clear", async () => {
            prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 2 });

            const result = await enrichmentFailureService.clearAllFailures("audio");

            expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
                where: {
                    resolved: false,
                    skipped: false,
                    entityType: "audio",
                },
            });
            expect(logger.info).toHaveBeenCalledWith(
                "Cleared 2 enrichment failures of type audio"
            );
            expect(result).toBe(2);
        });
    });

    it("removes old resolved failures before cutoff and logs cleanup details", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00.000Z"));
        prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 5 });

        const result = await enrichmentFailureService.cleanupOldResolved(10);

        const callArg = prisma.enrichmentFailure.deleteMany.mock.calls[0][0];
        expect(callArg.where.resolved).toBe(true);
        expect(callArg.where.resolvedAt.lt).toBeInstanceOf(Date);
        expect(callArg.where.resolvedAt.lt.toISOString()).toBe(
            "2026-02-07T12:00:00.000Z"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[Enrichment Failures] Cleaned up 5 old resolved failures"
        );
        expect(result).toBe(5);
    });

    describe("hasExceededRetries", () => {
        it("returns true when retryCount is at or above maxRetries", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce({
                retryCount: 3,
                maxRetries: 3,
            });

            const result = await enrichmentFailureService.hasExceededRetries(
                "artist",
                "artist-1"
            );

            expect(prisma.enrichmentFailure.findUnique).toHaveBeenCalledWith({
                where: {
                    entityType_entityId: {
                        entityType: "artist",
                        entityId: "artist-1",
                    },
                },
            });
            expect(result).toBe(true);
        });

        it("supports strict threshold boundaries above maxRetries", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce({
                retryCount: 5,
                maxRetries: 3,
            });

            const result = await enrichmentFailureService.hasExceededRetries(
                "audio",
                "audio-1"
            );

            expect(result).toBe(true);
        });

        it("returns false when retryCount is below maxRetries", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce({
                retryCount: 1,
                maxRetries: 3,
            });

            const result = await enrichmentFailureService.hasExceededRetries(
                "track",
                "track-2"
            );

            expect(result).toBe(false);
        });

        it("returns false when no failure exists", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce(null);

            const result = await enrichmentFailureService.hasExceededRetries(
                "track",
                "track-1"
            );

            expect(result).toBe(false);
        });
    });

    it("clears a failure by entity type and entity id", async () => {
        prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 1 });

        await enrichmentFailureService.clearFailure("vibe", "track-42");

        expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
            where: {
                entityType: "vibe",
                entityId: "track-42",
            },
        });
    });

    describe("resolveByEntity", () => {
        it("resolves existing failures and emits debug log", async () => {
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 2 });

            const result = await enrichmentFailureService.resolveByEntity(
                "audio",
                "track-99"
            );

            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
                where: {
                    entityType: "audio",
                    entityId: "track-99",
                    resolved: false,
                },
                data: {
                    resolved: true,
                    resolvedAt: expect.any(Date),
                },
            });
            expect(logger.debug).toHaveBeenCalledWith(
                "[Enrichment Failures] Resolved 2 failures for audio:track-99"
            );
            expect(result).toBe(true);
        });

        it("returns false when no failures are resolved and skips debug log", async () => {
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 0 });

            const result = await enrichmentFailureService.resolveByEntity(
                "vibe",
                "vibe-99"
            );

            expect(result).toBe(false);
            expect(logger.debug).not.toHaveBeenCalled();
        });
    });

    describe("cleanupOrphanedFailures", () => {
        it("resolves orphaned artist/track/audio/vibe entries and returns counts", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                { id: "f1", entityType: "artist", entityId: "artist-1" },
                { id: "f2", entityType: "track", entityId: "track-1" },
                { id: "f3", entityType: "audio", entityId: "audio-1" },
                { id: "f4", entityType: "vibe", entityId: "vibe-1" },
            ]);
            prisma.artist.findUnique
                .mockResolvedValueOnce({ id: "artist-1" })
                .mockResolvedValueOnce(null);
            prisma.track.findUnique
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: "track-audio-1" });
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 2 });

            const result =
                await enrichmentFailureService.cleanupOrphanedFailures();

            expect(prisma.artist.findUnique).toHaveBeenCalledWith({
                where: { id: "artist-1" },
                select: { id: true },
            });
            expect(prisma.track.findUnique).toHaveBeenCalledWith({
                where: { id: "track-1" },
                select: { id: true },
            });
            expect(prisma.track.findUnique).toHaveBeenCalledWith({
                where: { id: "audio-1" },
                select: { id: true },
            });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["f2", "f4"] },
                },
                data: {
                    resolved: true,
                    resolvedAt: expect.any(Date),
                },
            });
            expect(result).toEqual({ cleaned: 2, checked: 4 });
            expect(logger.debug).toHaveBeenCalledWith(
                "[Enrichment Failures] Cleaned up 2 orphaned failures"
            );
        });

        it("returns zero counts and does not resolve when there are no orphans", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([]);
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({ count: 0 });

            const result =
                await enrichmentFailureService.cleanupOrphanedFailures();

            expect(prisma.enrichmentFailure.updateMany).not.toHaveBeenCalled();
            expect(result).toEqual({ cleaned: 0, checked: 0 });
            expect(logger.debug).not.toHaveBeenCalled();
        });
    });
});
