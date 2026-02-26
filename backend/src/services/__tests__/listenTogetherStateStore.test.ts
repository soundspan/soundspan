describe("listenTogetherStateStore", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadStateStore(options?: {
        enabled?: boolean;
        keyPrefix?: string;
        ttlSeconds?: string;
        getValue?: string | null;
        getError?: string;
        evalError?: string;
        delError?: string;
    }) {
        process.env = { ...originalEnv };

        if (options?.enabled === false) {
            process.env.LISTEN_TOGETHER_STATE_STORE_ENABLED = "false";
        } else {
            delete process.env.LISTEN_TOGETHER_STATE_STORE_ENABLED;
        }

        if (options?.keyPrefix) {
            process.env.LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX =
                options.keyPrefix;
        } else {
            delete process.env.LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX;
        }

        if (options?.ttlSeconds) {
            process.env.LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS =
                options.ttlSeconds;
        } else {
            delete process.env.LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS;
        }

        const redisClient = {
            get: jest.fn().mockImplementation(async () => {
                if (options?.getError) {
                    throw new Error(options.getError);
                }
                return options?.getValue ?? null;
            }),
            eval: jest.fn().mockImplementation(async () => {
                if (options?.evalError) {
                    throw new Error(options.evalError);
                }
                return 1;
            }),
            del: jest.fn().mockImplementation(async () => {
                if (options?.delError) {
                    throw new Error(options.delError);
                }
                return 1;
            }),
            disconnect: jest.fn(),
        };

        const createIORedisClient = jest.fn(() => redisClient);
        const logger = {
            warn: jest.fn(),
        };

        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { listenTogetherStateStore } = require("../listenTogetherStateStore");

        return {
            listenTogetherStateStore,
            createIORedisClient,
            redisClient,
            logger,
        };
    }

    it("does not access redis when state store is disabled", async () => {
        const { listenTogetherStateStore, createIORedisClient } = loadStateStore({
            enabled: false,
        });

        expect(listenTogetherStateStore.isEnabled()).toBe(false);
        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();
        await expect(
            listenTogetherStateStore.setSnapshot("group-1", {
                id: "group-1",
                playback: {},
                members: [],
            })
        ).resolves.toBeUndefined();
        await expect(
            listenTogetherStateStore.deleteSnapshot("group-1")
        ).resolves.toBeUndefined();
        expect(createIORedisClient).not.toHaveBeenCalled();
    });

    it("returns a valid snapshot and uses configured key prefix + ttl", async () => {
        const snapshot = {
            id: "group-1",
            playback: { playing: true, stateVersion: 12, serverTime: 34_567 },
            members: [{ id: "u1" }],
        };
        const { listenTogetherStateStore, redisClient } = loadStateStore({
            keyPrefix: "test-prefix",
            ttlSeconds: "123",
            getValue: JSON.stringify(snapshot),
        });

        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toEqual(snapshot);
        await listenTogetherStateStore.setSnapshot("group-1", snapshot);

        expect(redisClient.get).toHaveBeenCalledWith("test-prefix:group-1");
        expect(redisClient.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            "test-prefix:group-1",
            JSON.stringify(snapshot),
            "123",
            "12",
            "34567"
        );
    });

    it("ignores malformed or mismatched snapshots and logs warnings", async () => {
        const { listenTogetherStateStore, logger, redisClient } = loadStateStore({
            getValue: JSON.stringify({
                id: "other-group",
                playback: {},
                members: [],
            }),
        });

        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("mismatched id")
        );

        redisClient.get.mockResolvedValueOnce(JSON.stringify({ foo: "bar" }));
        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("malformed snapshot")
        );
    });

    it("swallows redis errors for get/set/delete and logs warnings", async () => {
        const { listenTogetherStateStore, logger } = loadStateStore({
            getError: "redis-get-down",
            evalError: "redis-set-down",
            delError: "redis-del-down",
        });
        const snapshot = { id: "group-1", playback: {}, members: [] };

        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();
        await expect(
            listenTogetherStateStore.setSnapshot("group-1", snapshot)
        ).resolves.toBeUndefined();
        await expect(
            listenTogetherStateStore.deleteSnapshot("group-1")
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to fetch snapshot"),
            expect.any(Error)
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to persist snapshot"),
            expect.any(Error)
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to delete snapshot"),
            expect.any(Error)
        );
    });

    it("passes stateVersion/serverTime ordering values to compare-and-set writes", async () => {
        const { listenTogetherStateStore, redisClient } = loadStateStore({
            keyPrefix: "ordering-prefix",
            ttlSeconds: "42",
        });
        const snapshot = {
            id: "group-1",
            playback: {
                stateVersion: 99,
                serverTime: 123_456_789,
            },
            members: [],
        };

        await listenTogetherStateStore.setSnapshot("group-1", snapshot);

        expect(redisClient.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            "ordering-prefix:group-1",
            JSON.stringify(snapshot),
            "42",
            "99",
            "123456789"
        );
    });

    it("disconnects redis client on stop", async () => {
        const { listenTogetherStateStore, redisClient } = loadStateStore({
            getValue: null,
        });

        await listenTogetherStateStore.getSnapshot("group-1");
        listenTogetherStateStore.stop();

        expect(redisClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("rejects non-object snapshots missing playback/members shape", async () => {
        const { listenTogetherStateStore, redisClient } = loadStateStore({
            getValue: "null",
        });

        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();

        redisClient.get.mockResolvedValueOnce(JSON.stringify({ id: "group-1" }));
        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({ id: "group-1", playback: {}, members: {} })
        );
        await expect(
            listenTogetherStateStore.getSnapshot("group-1")
        ).resolves.toBeNull();
    });

    it("no-ops stop when redis client has not been initialized", async () => {
        const { listenTogetherStateStore, redisClient } = loadStateStore();

        listenTogetherStateStore.stop();
        expect(redisClient.disconnect).not.toHaveBeenCalled();
    });
});
