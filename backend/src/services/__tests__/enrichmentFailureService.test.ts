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
        findMany: jest.fn(),
    },
    track: {
        findMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import { enrichmentFailureService } from "../enrichmentFailureService";
import { sanitizeEnrichmentErrorSummary } from "../../utils/enrichmentErrorSummary";

describe("sanitizeEnrichmentErrorSummary", () => {
    it("strips a Windows path with spaces without leaking suffix fragments", () => {
        expect(
            sanitizeEnrichmentErrorSummary(
                "failed at C:\\Music\\Artist Name\\song.flac",
            ),
        ).toBe("failed at [path] [path]");
        expect(
            sanitizeEnrichmentErrorSummary(
                "failed at C:\\Music\\Artist Name\\song.flac",
            ),
        ).not.toContain("song.flac");
    });

    it("strips a UNC path with spaces", () => {
        expect(
            sanitizeEnrichmentErrorSummary(
                "failed at \\\\server\\share\\Artist Name\\song.flac",
            ),
        ).toBe("failed at [path] [path]");
    });

    it("strips a POSIX path with spaces", () => {
        expect(
            sanitizeEnrichmentErrorSummary(
                "failed at /srv/music/Artist Name/song.flac",
            ),
        ).toBe("failed at [path] [path]");
    });

    it("sanitizes a message that contains only a path", () => {
        expect(
            sanitizeEnrichmentErrorSummary("C:\\Music\\private\\song.flac"),
        ).toBe("[path]");
    });

    it("keeps a URL host while stripping credentials and path", () => {
        expect(
            sanitizeEnrichmentErrorSummary(
                "request to https://user:pass@example.test/jobs/1 failed",
            ),
        ).toBe("request to https://example.test/[...] failed");
    });

    it("keeps a URL host while stripping its path", () => {
        expect(
            sanitizeEnrichmentErrorSummary(
                "request to https://example.test/jobs/1 failed",
            ),
        ).toBe("request to https://example.test/[...] failed");
    });

    it.each([
        "data:,super-secret",
        "data:text,super-secret",
        "C:private.txt",
        ":leading-secret",
        "'data:,super-secret'",
        "(data:,super-secret)",
    ])("redacts colon-prefixed payload token %s", (token) => {
        expect(sanitizeEnrichmentErrorSummary(token)).toBe("[redacted]");
    });

    it("retains a bare trailing-colon word", () => {
        expect(sanitizeEnrichmentErrorSummary("Error:")).toBe("Error:");
    });

    it("collapses whitespace and caps the summary at 200 characters", () => {
        const summary = sanitizeEnrichmentErrorSummary(
            `  decoder\n\tfailed ${"x".repeat(300)}  `,
        );

        expect(summary).toHaveLength(200);
        expect(summary?.startsWith("decoder failed ")).toBe(true);
        expect(summary).not.toContain("\n");
    });

    it("caps summaries at 200 code points without splitting an emoji", () => {
        const summary = sanitizeEnrichmentErrorSummary(
            `${"a".repeat(199)}😀 trailing`,
        );

        expect(summary).toBe(`${"a".repeat(199)}😀`);
        expect(Array.from(summary ?? "")).toHaveLength(200);
    });

    it("handles a long all-alphabetic message", () => {
        expect(sanitizeEnrichmentErrorSummary("a".repeat(100_000))).toBe(
            "a".repeat(200),
        );
    });

    it("preserves null when no message was recorded", () => {
        expect(sanitizeEnrichmentErrorSummary(null)).toBeNull();
    });
});

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
                prisma.enrichmentFailure.create.mock.calls[0][0].data.metadata,
            ).not.toBe(metadata);
            expect(result).toEqual(
                expect.objectContaining({
                    id: "failure-1",
                    retryCount: 1,
                }),
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
                    resolved: false,
                    resolvedAt: null,
                    metadata: existingMetadata,
                },
            });
            expect(result).toEqual(
                expect.objectContaining({
                    id: "failure-2",
                    retryCount: 3,
                    metadata: existingMetadata,
                }),
            );
        });

        it("reopens a resolved failure when the entity fails again", async () => {
            let row: Record<string, unknown> | null = null;
            prisma.enrichmentFailure.findUnique.mockImplementation(
                async () => row,
            );
            prisma.enrichmentFailure.create.mockImplementation(
                async ({ data }) => {
                    row = {
                        id: "failure-reopened",
                        ...data,
                        resolved: false,
                        resolvedAt: null,
                    };
                    return row;
                },
            );
            prisma.enrichmentFailure.updateMany.mockImplementation(
                async ({ data }) => {
                    row = row === null ? null : { ...row, ...data };
                    return { count: row === null ? 0 : 1 };
                },
            );
            prisma.enrichmentFailure.update.mockImplementation(
                async ({ data }) => {
                    row = row === null ? null : { ...row, ...data };
                    return row;
                },
            );

            const recorded = await enrichmentFailureService.recordFailure({
                entityType: "audio",
                entityId: "track-reopened",
                errorMessage: "first failure",
            });
            await enrichmentFailureService.resolveFailures([recorded.id]);
            expect(row).toEqual(
                expect.objectContaining({
                    resolved: true,
                    resolvedAt: expect.any(Date),
                }),
            );

            const rerecorded = await enrichmentFailureService.recordFailure({
                entityType: "audio",
                entityId: "track-reopened",
                errorMessage: "failed again",
            });

            expect(rerecorded).toEqual(
                expect.objectContaining({
                    resolved: false,
                    resolvedAt: null,
                    lastFailedAt: expect.any(Date),
                }),
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

        const result = await enrichmentFailureService.resetRetryCount([
            "r1",
            "r2",
        ]);

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
            prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({
                count: 9,
            });

            const result = await enrichmentFailureService.clearAllFailures();

            expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
                where: {
                    resolved: false,
                    skipped: false,
                },
            });
            expect(logger.info).toHaveBeenCalledWith(
                "Cleared 9 enrichment failures",
            );
            expect(result).toBe(9);
        });

        it("applies optional entity type filter and logs typed clear", async () => {
            prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({
                count: 2,
            });

            const result =
                await enrichmentFailureService.clearAllFailures("audio");

            expect(prisma.enrichmentFailure.deleteMany).toHaveBeenCalledWith({
                where: {
                    resolved: false,
                    skipped: false,
                    entityType: "audio",
                },
            });
            expect(logger.info).toHaveBeenCalledWith(
                "Cleared 2 enrichment failures of type audio",
            );
            expect(result).toBe(2);
        });
    });

    it("removes old resolved failures before cutoff and logs cleanup details", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-02-17T12:00:00.000Z"),
        );
        prisma.enrichmentFailure.deleteMany.mockResolvedValueOnce({ count: 5 });

        const result = await enrichmentFailureService.cleanupOldResolved(10);

        const callArg = prisma.enrichmentFailure.deleteMany.mock.calls[0][0];
        expect(callArg.where.resolved).toBe(true);
        expect(callArg.where.resolvedAt.lt).toBeInstanceOf(Date);
        expect(callArg.where.resolvedAt.lt.toISOString()).toBe(
            "2026-02-07T12:00:00.000Z",
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[Enrichment Failures] Cleaned up 5 old resolved failures",
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
                "artist-1",
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
                "audio-1",
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
                "track-2",
            );

            expect(result).toBe(false);
        });

        it("returns false when no failure exists", async () => {
            prisma.enrichmentFailure.findUnique.mockResolvedValueOnce(null);

            const result = await enrichmentFailureService.hasExceededRetries(
                "track",
                "track-1",
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
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 2,
            });

            const result = await enrichmentFailureService.resolveByEntity(
                "audio",
                "track-99",
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
                "[Enrichment Failures] Resolved 2 failures for audio:track-99",
            );
            expect(result).toBe(true);
        });

        it("returns false when no failures are resolved and skips debug log", async () => {
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 0,
            });

            const result = await enrichmentFailureService.resolveByEntity(
                "vibe",
                "vibe-99",
            );

            expect(result).toBe(false);
            expect(logger.debug).not.toHaveBeenCalled();
        });
    });

    describe("reconcileWithLiveState", () => {
        it("resolves vibe failures when tracks recovered or disappeared and keeps live failures", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                { id: "v-recovered", entityType: "vibe", entityId: "v-1" },
                { id: "v-failed", entityType: "vibe", entityId: "v-2" },
                { id: "v-missing", entityType: "vibe", entityId: "v-3" },
            ]);
            prisma.track.findMany.mockResolvedValueOnce([
                { id: "v-1", vibeAnalysisStatus: "completed", removedAt: null },
                { id: "v-2", vibeAnalysisStatus: "failed", removedAt: null },
            ]);
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 2,
            });

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(prisma.track.findMany).toHaveBeenCalledWith({
                where: { id: { in: ["v-1", "v-2", "v-3"] } },
                select: { id: true, vibeAnalysisStatus: true, removedAt: true },
            });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["v-recovered", "v-missing"] },
                    resolved: false,
                    skipped: false,
                    lastFailedAt: { lt: expect.any(Date) },
                },
                data: {
                    resolved: true,
                    resolvedAt: expect.any(Date),
                },
            });
            expect(result).toEqual({ resolved: 2, checked: 3 });
        });

        it("does not resolve a row re-failed after reconciliation started", async () => {
            const startedAt = new Date("2026-08-21T12:00:00.000Z");
            const row = {
                id: "v-raced",
                resolved: false,
                skipped: false,
                lastFailedAt: new Date(startedAt.getTime() + 1),
            };
            jest.useFakeTimers().setSystemTime(startedAt);
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                { id: row.id, entityType: "vibe", entityId: "track-raced" },
            ]);
            prisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "track-raced",
                    vibeAnalysisStatus: "completed",
                    removedAt: null,
                },
            ]);
            prisma.enrichmentFailure.updateMany.mockImplementationOnce(
                async ({ where, data }) => {
                    const canResolve =
                        !row.resolved &&
                        !row.skipped &&
                        row.lastFailedAt < where.lastFailedAt.lt;
                    if (canResolve) Object.assign(row, data);
                    return { count: canResolve ? 1 : 0 };
                },
            );

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(row.resolved).toBe(false);
            expect(result).toEqual({ resolved: 0, checked: 1 });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        lastFailedAt: { lt: startedAt },
                    }),
                }),
            );
        });

        it("resolves audio failures when tracks recovered or disappeared and keeps live failures", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                { id: "a-recovered", entityType: "audio", entityId: "a-1" },
                { id: "a-failed", entityType: "audio", entityId: "a-2" },
                { id: "a-missing", entityType: "audio", entityId: "a-3" },
            ]);
            prisma.track.findMany.mockResolvedValueOnce([
                { id: "a-1", analysisStatus: "completed", removedAt: null },
                { id: "a-2", analysisStatus: "failed", removedAt: null },
            ]);
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 2,
            });

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(prisma.track.findMany).toHaveBeenCalledWith({
                where: { id: { in: ["a-1", "a-2", "a-3"] } },
                select: { id: true, analysisStatus: true, removedAt: true },
            });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        id: { in: ["a-recovered", "a-missing"] },
                    }),
                }),
            );
            expect(result).toEqual({ resolved: 2, checked: 3 });
        });

        it("resolves track failures after terminal tags or disappearance", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                { id: "t-tagged", entityType: "track", entityId: "t-1" },
                { id: "t-no-mood", entityType: "track", entityId: "t-2" },
                { id: "t-not-found", entityType: "track", entityId: "t-3" },
                { id: "t-empty", entityType: "track", entityId: "t-4" },
                { id: "t-null", entityType: "track", entityId: "t-5" },
                { id: "t-missing", entityType: "track", entityId: "t-6" },
            ]);
            prisma.track.findMany.mockResolvedValueOnce([
                { id: "t-1", lastfmTags: ["dreamy"], removedAt: null },
                { id: "t-2", lastfmTags: ["_no_mood_tags"], removedAt: null },
                { id: "t-3", lastfmTags: ["_not_found"], removedAt: null },
                { id: "t-4", lastfmTags: [], removedAt: null },
                { id: "t-5", lastfmTags: null, removedAt: null },
            ]);
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 4,
            });

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(prisma.track.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
                },
                select: { id: true, lastfmTags: true, removedAt: true },
            });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        id: {
                            in: [
                                "t-tagged",
                                "t-no-mood",
                                "t-not-found",
                                "t-missing",
                            ],
                        },
                    }),
                }),
            );
            expect(result).toEqual({ resolved: 4, checked: 6 });
        });

        it("resolves artist failures when artists completed or disappeared", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                {
                    id: "artist-completed",
                    entityType: "artist",
                    entityId: "artist-1",
                },
                {
                    id: "artist-failed",
                    entityType: "artist",
                    entityId: "artist-2",
                },
                {
                    id: "artist-missing",
                    entityType: "artist",
                    entityId: "artist-3",
                },
            ]);
            prisma.artist.findMany.mockResolvedValueOnce([
                { id: "artist-1", enrichmentStatus: "completed" },
                { id: "artist-2", enrichmentStatus: "failed" },
            ]);
            prisma.enrichmentFailure.updateMany.mockResolvedValueOnce({
                count: 2,
            });

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(prisma.artist.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["artist-1", "artist-2", "artist-3"] },
                },
                select: { id: true, enrichmentStatus: true },
            });
            expect(prisma.enrichmentFailure.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        id: { in: ["artist-completed", "artist-missing"] },
                    }),
                }),
            );
            expect(result).toEqual({ resolved: 2, checked: 3 });
        });

        it("keeps system-level artist failures for manual resolution", async () => {
            prisma.enrichmentFailure.findMany.mockResolvedValueOnce([
                {
                    id: "artist-system",
                    entityType: "artist",
                    entityId: "system",
                },
            ]);

            const result =
                await enrichmentFailureService.reconcileWithLiveState();

            expect(prisma.artist.findMany).not.toHaveBeenCalled();
            expect(prisma.enrichmentFailure.updateMany).not.toHaveBeenCalled();
            expect(result).toEqual({ resolved: 0, checked: 1 });
        });

        it("cursor-paginates the unresolved scan and bounds live-state lookups", async () => {
            const failures = Array.from({ length: 5 }, (_, index) => ({
                id: `failure-${index}`,
                entityType: "vibe",
                entityId: `track-${index}`,
            }));
            prisma.enrichmentFailure.findMany
                .mockResolvedValueOnce(failures.slice(0, 2))
                .mockResolvedValueOnce(failures.slice(2, 4))
                .mockResolvedValueOnce(failures.slice(4));
            prisma.track.findMany.mockImplementation(async ({ where }) =>
                where.id.in.map((id: string) => ({
                    id,
                    vibeAnalysisStatus: "failed",
                    removedAt: null,
                })),
            );

            const result =
                await enrichmentFailureService.reconcileWithLiveState(2);

            expect(prisma.enrichmentFailure.findMany).toHaveBeenCalledTimes(3);
            expect(prisma.enrichmentFailure.findMany).toHaveBeenNthCalledWith(
                1,
                {
                    where: {
                        resolved: false,
                        skipped: false,
                        lastFailedAt: { lt: expect.any(Date) },
                    },
                    select: { id: true, entityType: true, entityId: true },
                    orderBy: { id: "asc" },
                    take: 2,
                },
            );
            expect(prisma.enrichmentFailure.findMany).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    cursor: { id: "failure-1" },
                    skip: 1,
                    orderBy: { id: "asc" },
                    take: 2,
                }),
            );
            expect(prisma.enrichmentFailure.findMany).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({
                    cursor: { id: "failure-3" },
                    skip: 1,
                    orderBy: { id: "asc" },
                    take: 2,
                }),
            );
            expect(prisma.track.findMany).toHaveBeenCalledTimes(3);
            for (const [query] of prisma.track.findMany.mock.calls) {
                expect(query.where.id.in.length).toBeLessThanOrEqual(2);
            }
            expect(prisma.enrichmentFailure.updateMany).not.toHaveBeenCalled();
            expect(result).toEqual({ resolved: 0, checked: 5 });
        });

        it("shares one in-process reconciliation across concurrent callers", async () => {
            let releaseFailures: ((value: never[]) => void) | undefined;
            prisma.enrichmentFailure.findMany.mockImplementationOnce(
                () =>
                    new Promise<never[]>((resolve) => {
                        releaseFailures = resolve;
                    }),
            );

            const first = enrichmentFailureService.reconcileWithLiveState();
            const second = enrichmentFailureService.reconcileWithLiveState();
            releaseFailures?.([]);

            await expect(Promise.all([first, second])).resolves.toEqual([
                { resolved: 0, checked: 0 },
                { resolved: 0, checked: 0 },
            ]);
            expect(prisma.enrichmentFailure.findMany).toHaveBeenCalledTimes(1);
        });
    });
});
