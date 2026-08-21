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
        onMemberPresence: jest.fn(),
        onMemberLeft: jest.fn(),
        onGroupEnded: jest.fn(),
        onReadyGateCompletion: jest.fn(),
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
        const stateStore: any = {
            validatePublication: jest.fn(async () => true),
            getSnapshot: jest.fn(async () => null),
        };
        const localTails = new Map<string, Promise<void>>();
        const withLocalGroupMutationBoundary = jest.fn(
            async <T>(groupId: string, operation: () => Promise<T>) => {
                const previous = localTails.get(groupId) ?? Promise.resolve();
                let release: () => void = () => undefined;
                const current = new Promise<void>((resolve) => {
                    release = resolve;
                });
                localTails.set(
                    groupId,
                    previous.then(() => current),
                );
                await previous;
                try {
                    return await operation();
                } finally {
                    release();
                }
            },
        );

        jest.doMock("crypto", () => ({
            randomUUID: () => "node-1",
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    stateSyncEnabled:
                        process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED !==
                        "false",
                    stateSyncChannel:
                        process.env.LISTEN_TOGETHER_STATE_SYNC_CHANNEL ||
                        "listen-together:state-sync",
                },
            },
        }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore: stateStore,
        }));
        jest.doMock("../listenTogetherMutationLock", () => ({
            withLocalGroupMutationBoundary,
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
            stateStore,
            withLocalGroupMutationBoundary,
            async emitMessage(channel: string, message: string) {
                if (messageHandler) {
                    messageHandler(channel, message);
                }
                await new Promise((resolve) => setImmediate(resolve));
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
        await listenTogetherClusterSync.publishMembership("g1", {
            hostUserId: "host",
            members: [],
        });
        await listenTogetherClusterSync.publishEnded("g1");

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
        await listenTogetherClusterSync.publishMembership("g1", {
            hostUserId: "host",
            members: [],
        });
        await listenTogetherClusterSync.publishEnded("g1");

        expect(createIORedisClient).toHaveBeenCalledTimes(1);
        expect(subClient.subscribe).toHaveBeenCalledWith(
            "listen-together:state-sync",
        );
        expect(pubClient.publish).toHaveBeenCalledWith(
            "listen-together:state-sync",
            expect.stringContaining('"groupId":"g1"'),
        );
        expect(pubClient.publish).toHaveBeenCalledWith(
            "listen-together:state-sync",
            expect.stringContaining('"type":"group-membership"'),
        );
        expect(pubClient.publish).toHaveBeenCalledWith(
            "listen-together:state-sync",
            expect.stringContaining('"type":"group-ended"'),
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

        await emitMessage("listen-together:state-sync", "{not-json");
        await emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g1",
                originNodeId: "node-1",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            }),
        );
        await emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "not-a-snapshot",
                groupId: "g1",
                originNodeId: "node-2",
                snapshot: { id: "g1", playback: {}, members: [] },
                ts: Date.now(),
            }),
        );
        await emitMessage(
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
        await emitMessage(
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

    it("dispatches ended events from other nodes", async () => {
        const { listenTogetherClusterSync, emitMessage } = loadClusterSync();
        const snapshotHandler = jest.fn();
        const endedHandler = jest.fn();
        await listenTogetherClusterSync.start(snapshotHandler, endedHandler);

        await emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-ended",
                groupId: "g-ended",
                originNodeId: "node-2",
                ts: Date.now(),
            }),
        );

        expect(endedHandler).toHaveBeenCalledWith("g-ended");
        expect(snapshotHandler).not.toHaveBeenCalled();
    });

    it("serializes same-group consumption through the local mutation tail", async () => {
        const { listenTogetherClusterSync, emitMessage } = loadClusterSync();
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;
        let markFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const handler = jest.fn(async (incoming: GroupSnapshot) => {
            events.push(`${incoming.playback.stateVersion}:start`);
            if (incoming.playback.stateVersion === 1) {
                markFirstStarted();
                await new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                });
            }
            events.push(`${incoming.playback.stateVersion}:end`);
        });
        await listenTogetherClusterSync.start(handler);
        const event = (stateVersion: number) =>
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g-serialized",
                originNodeId: "node-2",
                fencingToken: stateVersion,
                publicationId: `publication-${stateVersion}`,
                snapshot: {
                    id: "g-serialized",
                    playback: { stateVersion, serverTime: stateVersion },
                    members: [],
                },
                ts: Date.now(),
            });

        const first = emitMessage("listen-together:state-sync", event(1));
        await firstStarted;
        const second = emitMessage("listen-together:state-sync", event(2));
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toEqual(["1:start"]);

        releaseFirst();
        await Promise.all([first, second]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toEqual(["1:start", "1:end", "2:start", "2:end"]);
    });

    it("applies only reloaded authority when an event is fenced after compute", async () => {
        const { listenTogetherClusterSync, emitMessage, stateStore } =
            loadClusterSync();
        const stale = {
            id: "g-race",
            playback: { stateVersion: 1, serverTime: 1 },
            members: [],
        } as unknown as GroupSnapshot;
        const current = {
            ...stale,
            playback: { stateVersion: 2, serverTime: 2 },
        } as unknown as GroupSnapshot;
        stateStore.validatePublication
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        stateStore.getSnapshot.mockResolvedValueOnce(current);
        const appliedVersions: number[] = [];
        const handler = jest.fn((snapshot: GroupSnapshot) => () => {
            appliedVersions.push(snapshot.playback.stateVersion);
        });
        await listenTogetherClusterSync.start(handler);

        await emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-snapshot",
                groupId: "g-race",
                originNodeId: "node-2",
                fencingToken: 1,
                publicationId: "publication-1",
                snapshot: stale,
                ts: Date.now(),
            }),
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(handler).toHaveBeenNthCalledWith(1, stale);
        expect(handler).toHaveBeenNthCalledWith(2, current);
        expect(appliedVersions).toEqual([2]);
    });

    it("applies a peer membership transfer without replacing playback", async () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-membership-peer", {
            name: "Peer Group",
            joinCode: "PEER01",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "old-host",
            hostUsername: "Old Host",
            queue: [track("kept")],
            currentTimeMs: 12_000,
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
        });
        groupManager.addMember("g-membership-peer", "new-host", "New Host");
        const playbackBefore = groupManager.get("g-membership-peer")!.playback;
        const queueBefore = playbackBefore.queue;
        const versionBefore = playbackBefore.stateVersion;
        const { listenTogetherClusterSync, emitMessage } = loadClusterSync();
        const membershipHandler = jest.fn((groupId, membership) =>
            groupManager.applyCommittedMembership(
                groupId,
                membership.members,
                membership.hostUserId,
            ),
        );
        await listenTogetherClusterSync.start(
            jest.fn(),
            jest.fn(),
            membershipHandler,
        );

        await emitMessage(
            "listen-together:state-sync",
            JSON.stringify({
                type: "group-membership",
                groupId: "g-membership-peer",
                originNodeId: "node-2",
                membership: {
                    hostUserId: "new-host",
                    members: [
                        {
                            userId: "new-host",
                            username: "New Host",
                            isHost: true,
                            joinedAt: "2026-08-20T12:01:00.000Z",
                            isConnected: false,
                        },
                    ],
                },
                ts: Date.now(),
            }),
        );

        expect(membershipHandler).toHaveBeenCalledTimes(1);
        expect(groupManager.get("g-membership-peer")!.playback.queue).toBe(
            queueBefore,
        );
        expect(
            groupManager.get("g-membership-peer")!.playback.stateVersion,
        ).toBe(versionBefore);
        expect(() =>
            groupManager.play("g-membership-peer", "new-host"),
        ).not.toThrow();
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

    it("logs and propagates publishSnapshot failures for queued retry", async () => {
        const { listenTogetherClusterSync, pubClient, logger } =
            loadClusterSync();
        const handler = jest.fn();
        await listenTogetherClusterSync.start(handler);

        pubClient.publish.mockRejectedValueOnce(new Error("publish failed"));
        await expect(
            listenTogetherClusterSync.publishSnapshot("g1", {
                id: "g1",
                playback: {},
                members: [],
            }),
        ).rejects.toThrow("publish failed");

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

        await emitMessage(
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

        await emitMessage(
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

        const [groupId, completion] =
            callbacks.onReadyGateCompletion.mock.calls[0];
        groupManager.handleReadyGateCompletion(
            groupId,
            completion.currentIndex,
            completion.stateVersion,
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
