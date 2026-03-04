describe("trackMappingStaleness worker", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    async function flushMicrotasks(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
    }

    function loadWorker(options?: {
        env?: Record<string, string>;
    }) {
        process.env = {
            ...originalEnv,
            ...options?.env,
        };

        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const findMany = jest.fn();
        const markStale = jest.fn();

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/db", () => ({
            prisma: {
                trackMapping: {
                    findMany,
                },
            },
        }));
        jest.doMock("../../services/trackMappingService", () => ({
            trackMappingService: {
                markStale,
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../trackMappingStaleness");

        return {
            module: module as {
                startTrackMappingStalenessWorker: () => void;
                stopTrackMappingStalenessWorker: () => void;
            },
            logger,
            findMany,
            markStale,
        };
    }

    it("starts once, parses interval, and marks stale mappings with missing targets", async () => {
        jest.useFakeTimers();
        const setIntervalSpy = jest.spyOn(global, "setInterval");
        const { module, logger, findMany, markStale } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1500" },
        });

        findMany.mockResolvedValueOnce([
            {
                id: "mapping-stale",
                trackTidalId: "tidal-1",
                trackYtMusicId: null,
                trackTidal: null,
                trackYtMusic: null,
            },
            {
                id: "mapping-valid",
                trackTidalId: null,
                trackYtMusicId: null,
                trackTidal: null,
                trackYtMusic: null,
            },
        ]);
        markStale.mockResolvedValue(undefined);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();
        module.startTrackMappingStalenessWorker();

        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1500);
        expect(findMany).toHaveBeenCalledWith({
            where: { stale: false },
            select: {
                id: true,
                trackTidalId: true,
                trackYtMusicId: true,
                trackTidal: {
                    select: { id: true },
                },
                trackYtMusic: {
                    select: { id: true },
                },
            },
            orderBy: { createdAt: "asc" },
            take: 100,
        });
        expect(markStale).toHaveBeenCalledTimes(1);
        expect(markStale).toHaveBeenCalledWith("mapping-stale");
        expect(logger.info).toHaveBeenCalledWith(
            "[TrackMappingStaleness] Marked 1 stale track mappings"
        );
        expect(logger.info).toHaveBeenCalledWith(
            "[TrackMappingStaleness] Worker started (intervalMs=1500)"
        );

        module.stopTrackMappingStalenessWorker();
    });

    it("falls back to default interval when env is invalid", async () => {
        jest.useFakeTimers();
        const setIntervalSpy = jest.spyOn(global, "setInterval");
        const { module, findMany } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "invalid" },
        });
        findMany.mockResolvedValueOnce([]);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();

        expect(setIntervalSpy).toHaveBeenCalledWith(
            expect.any(Function),
            6 * 60 * 60 * 1000
        );

        module.stopTrackMappingStalenessWorker();
    });

    it("always queries from the first page on each interval run", async () => {
        jest.useFakeTimers();
        const { module, findMany } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1000" },
        });

        findMany
            .mockResolvedValueOnce([
                {
                    id: "first-page",
                    trackTidalId: null,
                    trackYtMusicId: null,
                    trackTidal: null,
                    trackYtMusic: null,
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();

        await jest.advanceTimersByTimeAsync(1000);
        await flushMicrotasks();

        await jest.advanceTimersByTimeAsync(1000);
        await flushMicrotasks();

        expect(findMany).toHaveBeenCalledTimes(3);
        for (const call of findMany.mock.calls) {
            expect(call[0]).toEqual(
                expect.objectContaining({
                    take: 100,
                    orderBy: { createdAt: "asc" },
                })
            );
            expect(Object.prototype.hasOwnProperty.call(call[0], "skip")).toBe(false);
        }

        module.stopTrackMappingStalenessWorker();
    });

    it("warns and continues when marking stale mappings fails", async () => {
        jest.useFakeTimers();
        const { module, logger, findMany, markStale } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1000" },
        });

        const staleError = new Error("mark-stale-failed");
        findMany.mockResolvedValueOnce([
            {
                id: "mapping-1",
                trackTidalId: "tidal-1",
                trackYtMusicId: null,
                trackTidal: null,
                trackYtMusic: null,
            },
            {
                id: "mapping-2",
                trackTidalId: null,
                trackYtMusicId: "yt-1",
                trackTidal: null,
                trackYtMusic: null,
            },
        ]);
        markStale.mockRejectedValueOnce(staleError).mockResolvedValueOnce(undefined);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();

        expect(markStale).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            "[TrackMappingStaleness] Failed to mark stale mapping mapping-1",
            staleError
        );
        expect(logger.info).toHaveBeenCalledWith(
            "[TrackMappingStaleness] Marked 1 stale track mappings"
        );

        module.stopTrackMappingStalenessWorker();
    });

    it("skips overlapping runs while an earlier check is still in flight", async () => {
        jest.useFakeTimers();
        const { module, findMany } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1000" },
        });

        let resolveFindMany: ((value: unknown) => void) | undefined;
        const firstRun = new Promise((resolve) => {
            resolveFindMany = resolve;
        });
        findMany.mockReturnValueOnce(firstRun).mockResolvedValueOnce([]);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1000);
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(1);

        resolveFindMany?.([]);
        await flushMicrotasks();

        await jest.advanceTimersByTimeAsync(1000);
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(2);

        module.stopTrackMappingStalenessWorker();
    });

    it("can be stopped and restarted without carrying pagination state", async () => {
        jest.useFakeTimers();
        const { module, findMany } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1000" },
        });

        findMany
            .mockResolvedValueOnce([
                {
                    id: "mapping-1",
                    trackTidalId: null,
                    trackYtMusicId: null,
                    trackTidal: null,
                    trackYtMusic: null,
                },
            ])
            .mockResolvedValueOnce([]);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();
        module.stopTrackMappingStalenessWorker();

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();

        expect(findMany).toHaveBeenCalledTimes(2);
        expect(Object.prototype.hasOwnProperty.call(findMany.mock.calls[0][0], "skip")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(findMany.mock.calls[1][0], "skip")).toBe(false);

        module.stopTrackMappingStalenessWorker();
    });

    it("can be stopped and restarted while a prior run is in flight", async () => {
        jest.useFakeTimers();
        const { module, findMany } = loadWorker({
            env: { TRACK_MAPPING_STALENESS_INTERVAL_MS: "1000" },
        });

        let resolveFirstRun: ((value: unknown) => void) | undefined;
        const firstRun = new Promise((resolve) => {
            resolveFirstRun = resolve;
        });

        findMany.mockReturnValueOnce(firstRun).mockResolvedValueOnce([]);

        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(1);

        module.stopTrackMappingStalenessWorker();
        module.startTrackMappingStalenessWorker();
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(1);

        resolveFirstRun?.([]);
        await flushMicrotasks();

        await jest.advanceTimersByTimeAsync(1000);
        await flushMicrotasks();
        expect(findMany).toHaveBeenCalledTimes(2);
        expect(Object.prototype.hasOwnProperty.call(findMany.mock.calls[1][0], "skip")).toBe(false);

        module.stopTrackMappingStalenessWorker();
    });
});
