describe("discoverCron worker", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadDiscoverCron() {
        process.env = { ...originalEnv };

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const prisma = {
            userDiscoverConfig: {
                findMany: jest.fn(),
            },
        };
        const discoverQueue = {
            add: jest.fn(),
            removeRepeatable: jest.fn(),
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../queues", () => ({ discoverQueue }));
        jest.doMock("../../config", () => ({
            config: { discover: { mode: "strict" } },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../discoverCron");

        return { module, logger, prisma, discoverQueue };
    }

    it("queues weekly discover jobs for all enabled users with dedupe job ids", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-16T12:00:00.000Z"));
        const { module, prisma, discoverQueue } = loadDiscoverCron();

        prisma.userDiscoverConfig.findMany.mockResolvedValueOnce([
            { userId: "u1", playlistSize: 25 },
            { userId: "u2", playlistSize: 25 },
        ]);
        discoverQueue.add.mockResolvedValue(undefined);

        await module.processDiscoverCronTick();

        expect(prisma.userDiscoverConfig.findMany).toHaveBeenCalledWith({
            where: { enabled: true },
            select: { userId: true, playlistSize: true },
        });
        expect(discoverQueue.add).toHaveBeenCalledTimes(2);
        expect(discoverQueue.add.mock.calls[0][0]).toBe("discover-recommendation");
        expect(discoverQueue.add.mock.calls[0][1]).toEqual({ userId: "u1" });
        expect(discoverQueue.add.mock.calls[0][2]).toEqual({
            jobId: "discover:cron:2026-02-16:u1",
        });
    });

    it("registers and removes repeatable cron scheduler with success/failure logging", async () => {
        const { module, discoverQueue, logger } = loadDiscoverCron();

        discoverQueue.add.mockResolvedValueOnce(undefined);
        module.startDiscoverWeeklyCron();
        await Promise.resolve();
        await Promise.resolve();

        expect(discoverQueue.add).toHaveBeenCalledWith(
            "discover-cron-tick",
            {},
            expect.objectContaining({
                jobId: "discover:cron:tick",
                repeat: { cron: "0 20 * * 0" },
                removeOnComplete: true,
                removeOnFail: 10,
            })
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "Discover Weekly repeatable scheduler registered"
        );

        discoverQueue.removeRepeatable.mockResolvedValueOnce(undefined);
        module.stopDiscoverWeeklyCron();
        await Promise.resolve();
        await Promise.resolve();
        expect(discoverQueue.removeRepeatable).toHaveBeenCalledWith(
            "discover-cron-tick",
            { cron: "0 20 * * 0" }
        );

        discoverQueue.add.mockRejectedValueOnce(new Error("add-failed"));
        module.startDiscoverWeeklyCron();
        await Promise.resolve();
        await Promise.resolve();
        expect(logger.error).toHaveBeenCalledWith(
            "Discover Weekly repeatable scheduler registration failed:",
            "add-failed"
        );

        discoverQueue.removeRepeatable.mockRejectedValueOnce(
            new Error("remove-failed")
        );
        module.stopDiscoverWeeklyCron();
        await Promise.resolve();
        await Promise.resolve();
        expect(logger.warn).toHaveBeenCalledWith(
            "Discover Weekly repeatable scheduler remove failed:",
            "remove-failed"
        );
    });
});
