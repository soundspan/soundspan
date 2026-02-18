describe("audioAnalysisCleanupService", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadAudioCleanupService() {
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const prisma = {
            track: {
                findMany: jest.fn(),
                update: jest.fn(),
                count: jest.fn(),
            },
            $queryRaw: jest.fn(),
        };
        const enrichmentFailureService = {
            recordFailure: jest.fn(),
        };

        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("../../utils/db", () => ({
            prisma,
        }));
        jest.doMock("../enrichmentFailureService", () => ({
            enrichmentFailureService,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../audioAnalysisCleanup");

        return {
            service: module.audioAnalysisCleanupService as {
                cleanupStaleProcessing: () => Promise<{
                    reset: number;
                    permanentlyFailed: number;
                    recovered: number;
                }>;
                isCircuitOpen: () => boolean;
                recordSuccess: () => void;
                getStats: () => Promise<{
                    pending: number;
                    processing: number;
                    completed: number;
                    failed: number;
                    circuitOpen: boolean;
                    circuitState: string;
                    failureCount: number;
                }>;
            },
            prisma,
            enrichmentFailureService,
            logger,
        };
    }

    function staleTrack(overrides: Record<string, unknown> = {}) {
        return {
            id: "track-1",
            title: "Test Track",
            filePath: "/music/test.mp3",
            analysisRetryCount: 0,
            album: {
                artist: {
                    name: "Test Artist",
                },
            },
            ...overrides,
        };
    }

    it("returns zeros when no stale tracks are found", async () => {
        const { service, prisma } = loadAudioCleanupService();
        prisma.track.findMany.mockResolvedValueOnce([]);

        const result = await service.cleanupStaleProcessing();

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                analysisStatus: "processing",
                OR: [
                    { analysisStartedAt: { lt: expect.any(Date) } },
                    { analysisStartedAt: null, updatedAt: { lt: expect.any(Date) } },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });
        expect(result).toEqual({ reset: 0, permanentlyFailed: 0, recovered: 0 });
    });

    it("resets stale tracks for retry when under max retry threshold", async () => {
        const { service, prisma } = loadAudioCleanupService();
        prisma.track.findMany.mockResolvedValueOnce([staleTrack()]);
        prisma.$queryRaw.mockResolvedValueOnce([{ count: BigInt(0) }]);
        prisma.track.update.mockResolvedValue({});

        const result = await service.cleanupStaleProcessing();

        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                analysisStatus: "pending",
                analysisStartedAt: null,
                analysisRetryCount: 1,
                analysisError: "Reset after stale processing (attempt 1/3)",
            },
        });
        expect(result).toEqual({ reset: 1, permanentlyFailed: 0, recovered: 0 });
    });

    it("marks tracks permanently failed at max retries and records enrichment failure", async () => {
        const { service, prisma, enrichmentFailureService } =
            loadAudioCleanupService();
        prisma.track.findMany.mockResolvedValueOnce([
            staleTrack({ analysisRetryCount: 2 }),
        ]);
        prisma.$queryRaw.mockResolvedValueOnce([{ count: BigInt(0) }]);
        prisma.track.update.mockResolvedValue({});
        enrichmentFailureService.recordFailure.mockResolvedValue({});

        const result = await service.cleanupStaleProcessing();

        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                analysisStatus: "failed",
                analysisError: "Exceeded 3 retry attempts (stale processing)",
                analysisRetryCount: 3,
                analysisStartedAt: null,
            },
        });
        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith({
            entityType: "audio",
            entityId: "track-1",
            entityName: "Test Artist - Test Track",
            errorMessage:
                "Analysis timed out 3 times - track may be corrupted or unsupported",
            errorCode: "MAX_RETRIES_EXCEEDED",
            metadata: {
                filePath: "/music/test.mp3",
                retryCount: 3,
            },
        });
        expect(result).toEqual({ reset: 0, permanentlyFailed: 1, recovered: 0 });
    });

    it("recovers stale tracks that already have embeddings and clears failure counter", async () => {
        const { service, prisma } = loadAudioCleanupService();
        prisma.track.findMany
            .mockResolvedValueOnce([staleTrack()])
            .mockResolvedValueOnce([staleTrack({ id: "track-2", title: "Recovered" })]);
        prisma.$queryRaw
            .mockResolvedValueOnce([{ count: BigInt(0) }])
            .mockResolvedValueOnce([{ count: BigInt(1) }]);
        prisma.track.update.mockResolvedValue({});
        prisma.track.count.mockResolvedValue(0);

        const firstRun = await service.cleanupStaleProcessing();
        const secondRun = await service.cleanupStaleProcessing();
        const stats = await service.getStats();

        expect(firstRun).toEqual({ reset: 1, permanentlyFailed: 0, recovered: 0 });
        expect(secondRun).toEqual({ reset: 0, permanentlyFailed: 0, recovered: 1 });
        expect(prisma.track.update).toHaveBeenLastCalledWith({
            where: { id: "track-2" },
            data: {
                analysisStatus: "completed",
                analysisError: null,
                analysisStartedAt: null,
            },
        });
        expect(stats.failureCount).toBe(0);
    });

    it("opens circuit breaker after repeated cleanup failures and transitions through half-open recovery", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T00:00:00.000Z"));
        const { service, prisma } = loadAudioCleanupService();

        prisma.track.findMany.mockResolvedValue([staleTrack()]);
        prisma.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
        prisma.track.update.mockResolvedValue({});
        prisma.track.count.mockResolvedValue(0);

        for (let i = 0; i < 30; i++) {
            await service.cleanupStaleProcessing();
        }

        let stats = await service.getStats();
        expect(stats.circuitState).toBe("open");
        expect(stats.failureCount).toBe(30);
        expect(service.isCircuitOpen()).toBe(true);

        jest.setSystemTime(new Date("2026-02-17T00:06:00.000Z"));
        expect(service.isCircuitOpen()).toBe(false);

        service.recordSuccess();
        stats = await service.getStats();
        expect(stats.circuitState).toBe("closed");
        expect(stats.failureCount).toBe(0);
    });
});
