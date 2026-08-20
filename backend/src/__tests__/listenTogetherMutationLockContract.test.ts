describe("listen together mutation lock", () => {
    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    it("serializes overlapping mutations for one group", async () => {
        const logger: any = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        jest.doMock("../config", () => ({
            config: {
                listenTogether: {
                    mutationLockEnabled: false,
                    mutationLockTtlMs: 3000,
                    mutationLockPrefix: "listen-together:mutation-lock",
                },
            },
        }));
        jest.doMock("../utils/logger", () => ({ logger }));
        jest.doMock("../utils/ioredis", () => ({
            createIORedisClient: jest.fn(),
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            withGroupMutationLock,
            shutdownGroupMutationLock,
        } = require("../services/listenTogetherMutationLock");
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;
        let markFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = withGroupMutationLock("group-1", "first", async () => {
            events.push("first:start");
            markFirstStarted();
            await firstGate;
            events.push("first:end");
        });
        await firstStarted;
        const second = withGroupMutationLock("group-1", "second", async () => {
            events.push("second:start");
            events.push("second:end");
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(events).toEqual(["first:start"]);
        releaseFirst();
        await Promise.all([first, second]);

        expect(events).toEqual([
            "first:start",
            "first:end",
            "second:start",
            "second:end",
        ]);
        shutdownGroupMutationLock();
    });
});
