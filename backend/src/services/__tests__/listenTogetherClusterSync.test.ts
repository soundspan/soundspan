import {
    groupManager,
    type GroupSnapshot,
    type ManagerCallbacks,
    type SyncQueueItem,
} from "../listenTogetherManager";

describe("listenTogetherClusterSync", () => {
    const originalEnv = process.env;

    const track = (id: string): SyncQueueItem => ({
        id,
        title: `Track ${id}`,
        duration: 180,
        artist: { id: `artist-${id}`, name: `Artist ${id}` },
        album: { id: `album-${id}`, title: `Album ${id}`, coverArt: null },
    });

    const createCallbacks = (): jest.Mocked<ManagerCallbacks> => ({
        onGroupState: jest.fn(),
        onPlaybackDelta: jest.fn(),
        onQueueDelta: jest.fn(),
        onWaiting: jest.fn(),
        onPlayAt: jest.fn(),
        onMemberJoined: jest.fn(),
        onMemberLeft: jest.fn(),
        onGroupEnded: jest.fn(),
    });

    function resetGroupManager(): void {
        for (const groupId of groupManager.allGroupIds()) {
            groupManager.remove(groupId);
        }
    }

    function createWaitingGroup(groupId: string): GroupSnapshot {
        groupManager.create(groupId, {
            name: "Ready Group",
            joinCode: "READY1",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("one"), track("two")],
            createdAt: new Date(),
        });
        groupManager.addMember(groupId, "guest", "Guest");
        groupManager.addSocket(groupId, "host", "host-socket");
        groupManager.addSocket(groupId, "guest", "guest-socket");
        return groupManager.setTrack(groupId, "host", 1, true).snapshot;
    }

    afterEach(() => {
        jest.useRealTimers();
        resetGroupManager();
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

        let messageHandler:
            | ((channel: string, message: string) => void)
            | null = null;

        const subClient = {
            on: jest.fn(
                (
                    event: string,
                    handler: (channel: string, message: string) => void,
                ) => {
                    if (event === "message") {
                        messageHandler = handler;
                    }
                },
            ),
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
        const {
            listenTogetherClusterSync,
        } = require("../listenTogetherClusterSync");

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
        const { listenTogetherClusterSync, createIORedisClient } =
            loadClusterSync({
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
            "listen-together:state-sync",
        );
        expect(pubClient.publish).toHaveBeenCalledWith(
            "listen-together:state-sync",
            expect.stringContaining('"groupId":"g1"'),
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Enabled on channel"),
        );
    });

    it("dispatches only valid snapshots from other nodes", async () => {
        const { listenTogetherClusterSync, emitMessage, logger } =
            loadClusterSync();
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
            }),
        );
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "not-a-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            }),
        );
        emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "different", playback: {}, members: [] },
                ts: Date.now(),
            }),
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
            }),
        );

        expect(logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Ignoring invalid sync message",
        );
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(validSnapshot);
    });

    it("unsubscribes and disconnects clients on stop", async () => {
        const { listenTogetherClusterSync, subClient, pubClient } =
            loadClusterSync();
        const handler = jest.fn();

        await listenTogetherClusterSync.start(handler);
        await listenTogetherClusterSync.stop();

        expect(subClient.unsubscribe).toHaveBeenCalledWith(
            "listen-together:state-sync",
        );
        expect(subClient.disconnect).toHaveBeenCalledTimes(1);
        expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("logs a warning when publishSnapshot fails", async () => {
        const { listenTogetherClusterSync, pubClient, logger } =
            loadClusterSync();
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
            expect.any(Error),
        );
    });

    it("ignores messages when no handler is registered", async () => {
        const { listenTogetherClusterSync, emitMessage, logger } =
            loadClusterSync();
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
            }),
        );

        expect(handler).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Ignoring invalid sync message",
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
            }),
        );

        expect(handler).not.toHaveBeenCalled();
    });

    it("still disconnects clients when unsubscribe fails during stop", async () => {
        const { listenTogetherClusterSync, subClient, pubClient } =
            loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);

        subClient.unsubscribe.mockRejectedValueOnce(
            new Error("unsubscribe failed"),
        );
        await listenTogetherClusterSync.stop();

        expect(subClient.disconnect).toHaveBeenCalledTimes(1);
        expect(pubClient.disconnect).toHaveBeenCalledTimes(1);
    });

    it("preserves ready votes across the mutation-lock snapshot round trip", () => {
        jest.useFakeTimers({ now: new Date("2026-08-11T00:00:00.000Z") });
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        createWaitingGroup("g-ready-round-trip");
        expect(groupManager.reportReady("g-ready-round-trip", "host")).toBe(
            false,
        );
        const storedSnapshot = groupManager.snapshotById("g-ready-round-trip");
        expect(storedSnapshot?.readyUserIds).toEqual(["host"]);

        groupManager.applyExternalSnapshot(storedSnapshot as GroupSnapshot);
        expect(groupManager.reportReady("g-ready-round-trip", "guest")).toBe(
            true,
        );

        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
        expect(groupManager.snapshotById("g-ready-round-trip")?.syncState).toBe(
            "playing",
        );
        expect(jest.now()).toBe(new Date("2026-08-11T00:00:00.000Z").getTime());
    });

    it("unions local ready votes when an older snapshot is rehydrated", () => {
        jest.useFakeTimers({ now: new Date("2026-08-11T00:00:00.000Z") });
        groupManager.setCallbacks(createCallbacks());
        const waitingSnapshot = createWaitingGroup("g-ready-stale");
        groupManager.reportReady("g-ready-stale", "host");

        groupManager.applyExternalSnapshot({
            ...waitingSnapshot,
            readyUserIds: [],
            playback: {
                ...waitingSnapshot.playback,
                stateVersion: waitingSnapshot.playback.stateVersion - 1,
            },
        });

        expect(groupManager.get("g-ready-stale")?.readyUserIds).toEqual(
            new Set(["host"]),
        );
        expect(
            groupManager.get("g-ready-stale")?.members.get("host")?.isReady,
        ).toBe(true);
    });

    it("accepts old snapshots without ready votes as an empty ready set", () => {
        jest.useFakeTimers({ now: new Date("2026-08-11T00:00:00.000Z") });
        groupManager.setCallbacks(createCallbacks());
        createWaitingGroup("g-ready-old-format");
        groupManager.reportReady("g-ready-old-format", "host");

        const current = groupManager.snapshotById("g-ready-old-format");
        expect(current).toBeDefined();
        const oldFormatSnapshot = { ...current } as Partial<GroupSnapshot>;
        delete oldFormatSnapshot.readyUserIds;
        groupManager.remove("g-ready-old-format");

        expect(() =>
            groupManager.applyExternalSnapshot(
                oldFormatSnapshot as GroupSnapshot,
            ),
        ).not.toThrow();
        expect(groupManager.get("g-ready-old-format")?.readyUserIds.size).toBe(
            0,
        );
        expect(
            Array.from(
                groupManager.get("g-ready-old-format")?.members.values() ?? [],
            ).every((member) => !member.isReady),
        ).toBe(true);
    });
});
