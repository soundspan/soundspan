describe("listenTogetherClusterSync", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadClusterSync(options?: { enabled?: boolean }) {
        process.env = { ...originalEnv };
        if (options?.enabled === false) {
            process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED = "false";
        } else {
            delete process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED;
        }
        delete process.env.LISTEN_TOGETHER_STATE_SYNC_CHANNEL;

        let messageHandler: ((channel: string, message: string) => void) | null =
            null;

        const subClient = {
            on: jest.fn((event: string, handler: (channel: string, message: string) => void) => {
                if (event === "message") {
                    messageHandler = handler;
                }
            }),
            subscribe: jest.fn(async () => 1),
            unsubscribe: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };

        const pubClient = {
            duplicate: jest.fn(() => subClient),
            publish: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };

        const createIORedisClient = jest.fn(() => pubClient);
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
        };

        jest.doMock("crypto", () => ({
            randomUUID: () => "node-1",
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { listenTogetherClusterSync } = require("../listenTogetherClusterSync");

        return {
            listenTogetherClusterSync,
            createIORedisClient,
            pubClient,
            subClient,
            logger,
            emitMessage(channel: string, message: string) {
                if (messageHandler) {
                    messageHandler(channel, message);
                }
            },
        };
    }

    it("does nothing when disabled", async () => {
        const { listenTogetherClusterSync, createIORedisClient } = loadClusterSync({
            enabled: false,
        });
        const handler = jest.fn();

        expect(listenTogetherClusterSync.isEnabled()).toBe(false);
        await listenTogetherClusterSync.start(handler);
        await listenTogetherClusterSync.publishSnapshot("g1", {
            id: "g1",
            playback: {},
            members: [],
        });

        expect(createIORedisClient).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it("starts once, subscribes to channel, and publishes snapshots", async () => {
        const {
            listenTogetherClusterSync,
            createIORedisClient,
            subClient,
            pubClient,
            logger,
        } = loadClusterSync();
        const handler = jest.fn();
        const snapshot = { id: "g1", playback: { playing: true }, members: [] };

        await listenTogetherClusterSync.start(handler);
        await listenTogetherClusterSync.start(jest.fn());
        await listenTogetherClusterSync.publishSnapshot("g1", snapshot);

        expect(createIORedisClient).toHaveBeenCalledTimes(1);
        expect(subClient.subscribe).toHaveBeenCalledWith(
            "listen-together:state-sync"
        );
        expect(pubClient.publish).toHaveBeenCalledWith(
            "listen-together:state-sync",
            expect.stringContaining("\"groupId\":\"g1\"")
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Enabled on channel")
        );
    });

    it("dispatches only valid snapshots from other nodes", async () => {
        const { listenTogetherClusterSync, emitMessage, logger } = loadClusterSync();
        const handler = jest.fn();

        await listenTogetherClusterSync.start(handler);

        emitMessage("listen-together:state-sync", "{not-json");
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-1",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            })
        );
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "not-a-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            })
        );
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "different", playback: {}, members: [] },
                ts: Date.now(),
            })
        );
        const validSnapshot = { id: "g2", playback: { t: 1 }, members: [] };
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g2",
                originNodeId: "node-2",
                snapshot: validSnapshot,
                ts: Date.now(),
            })
        );

        expect(logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Ignoring invalid sync message"
        );
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(validSnapshot);
    });

    it("unsubscribes and disconnects clients on stop", async () => {
        const { listenTogetherClusterSync, subClient, pubClient } = loadClusterSync();
        const handler = jest.fn();

        await listenTogetherClusterSync.start(handler);
        await listenTogetherClusterSync.stop();

        expect(subClient.unsubscribe).toHaveBeenCalledWith(
            "listen-together:state-sync"
        );
        expect(subClient.disconnect).toHaveBeenCalledTimes(1);
        expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("logs a warning when publishSnapshot fails", async () => {
        const { listenTogetherClusterSync, pubClient, logger } = loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);

        pubClient.publish.mockRejectedValueOnce(new Error("publish failed"));
        await listenTogetherClusterSync.publishSnapshot("g1", {
            id: "g1",
            playback: {},
            members: [],
        });

        expect(logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Failed to publish snapshot for group g1",
            expect.any(Error)
        );
    });

    it("ignores messages when no handler is registered", async () => {
        const { listenTogetherClusterSync, emitMessage, logger } = loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);
        await listenTogetherClusterSync.stop();

        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            })
        );

        expect(handler).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Ignoring invalid sync message"
        );
    });

    it("ignores events on unrelated channels", async () => {
        const { listenTogetherClusterSync, emitMessage } = loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);

        emitMessage(
            "different-channel",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            })
        );

        expect(handler).not.toHaveBeenCalled();
    });

    it("still disconnects clients when unsubscribe fails during stop", async () => {
        const { listenTogetherClusterSync, subClient, pubClient } = loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);

        subClient.unsubscribe.mockRejectedValueOnce(new Error("unsubscribe failed"));
        await listenTogetherClusterSync.stop();

        expect(subClient.disconnect).toHaveBeenCalledTimes(1);
        expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
    });
});
