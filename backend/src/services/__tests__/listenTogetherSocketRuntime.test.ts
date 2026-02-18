describe("listen together socket runtime behavior", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupListenTogetherSocketMocks() {
        let ioInstance: any = null;
        let serverOptions: any = null;
        const namespace = {
            use: jest.fn(),
            on: jest.fn(),
            to: jest.fn(() => ({ emit: jest.fn() })),
        };
        const logger: any = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const jwtVerify: any = jest.fn(() => ({
            userId: "user-1",
            username: "User One",
            role: "USER",
            tokenVersion: 1,
        }));
        const prismaUserFindUnique: any = jest.fn(async () => ({
            id: "user-1",
            username: "User One",
            role: "USER",
            tokenVersion: 1,
        }));

        class MockServer {
            public adapter = jest.fn();
            public close = jest.fn();
            public of = jest.fn(() => namespace);
            constructor(_httpServer: unknown, _options: unknown) {
                ioInstance = this;
                serverOptions = _options;
            }
        }

        const mutationLockClient = {
            set: jest.fn(async () => "OK"),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
            duplicate: jest.fn(),
        };
        const adapterSubClient = {
            disconnect: jest.fn(),
        };
        const adapterPubClient = {
            set: jest.fn(async () => "OK"),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
            duplicate: jest.fn(() => adapterSubClient),
        };

        const createIORedisClient = jest.fn((name: string) => {
            if (name.includes("socket-adapter-pub")) return adapterPubClient;
            return mutationLockClient;
        });

        const listenTogetherClusterSync: any = {
            isEnabled: jest.fn(() => false),
            start: jest.fn(async () => undefined),
            publishSnapshot: jest.fn(async () => undefined),
            stop: jest.fn(async () => undefined),
        };
        const listenTogetherStateStore: any = {
            isEnabled: jest.fn(() => true),
            getSnapshot: jest.fn(async () => null),
            setSnapshot: jest.fn(async () => undefined),
            deleteSnapshot: jest.fn(async () => undefined),
            stop: jest.fn(),
        };
        const groupManager: any = {
            setCallbacks: jest.fn(),
            applyExternalSnapshot: jest.fn(),
            snapshotById: jest.fn(() => null),
            removeSocket: jest.fn(),
            socketCount: jest.fn(() => 0),
            addSocket: jest.fn(),
            play: jest.fn(),
            pause: jest.fn(),
            seek: jest.fn(),
            next: jest.fn(),
            previous: jest.fn(),
            setTrack: jest.fn(),
            modifyQueue: jest.fn(),
            reportReady: jest.fn(),
        };
        const joinGroupById = jest.fn(async () => ({
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [],
            playback: { status: "paused", index: 0, positionMs: 0 },
        }));
        const leaveGroup = jest.fn(async () => undefined);
        const validateLocalTracks = jest.fn(async () => [{ id: "track-1" }]);
        class MockGroupError extends Error {
            constructor(
                public code: string,
                message: string
            ) {
                super(message);
            }
        }

        jest.doMock("socket.io", () => ({ Server: MockServer }));
        jest.doMock("jsonwebtoken", () => ({
            __esModule: true,
            default: {
                verify: jwtVerify,
            },
        }));
        jest.doMock("../../utils/db", () => ({
            prisma: {
                user: {
                    findUnique: prismaUserFindUnique,
                },
            },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("../../utils/ioredis", () => ({ createIORedisClient }));
        jest.doMock("../listenTogetherClusterSync", () => ({
            listenTogetherClusterSync,
        }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore,
        }));
        jest.doMock("../listenTogetherManager", () => ({
            groupManager,
            GroupError: MockGroupError,
        }));
        jest.doMock("../listenTogether", () => ({
            joinGroupById,
            leaveGroup,
            validateLocalTracks,
        }));
        jest.doMock(
            "@socket.io/redis-adapter",
            () => ({
                createAdapter: jest.fn(() => "redis-adapter"),
            }),
            { virtual: true }
        );

        return {
            getIO: () => ioInstance,
            getServerOptions: () => serverOptions,
            namespace,
            createIORedisClient,
            adapterPubClient,
            adapterSubClient,
            mutationLockClient,
            listenTogetherClusterSync,
            listenTogetherStateStore,
            groupManager,
            joinGroupById,
            leaveGroup,
            validateLocalTracks,
            logger,
            jwtVerify,
            prismaUserFindUnique,
            MockGroupError,
        };
    }

    function bootstrapConnectedSocket(mocks: ReturnType<typeof setupListenTogetherSocketMocks>) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        const connectionCall = mocks.namespace.on.mock.calls.find(
            (call: unknown[]) => call[0] === "connection"
        );
        const connectionHandler = connectionCall[1];

        const eventHandlers: Record<string, (...args: any[]) => any> = {};
        const socket: any = {
            id: "sock-1",
            data: {
                userId: "user-1",
                username: "User One",
                groupId: null,
            },
            on: jest.fn((event: string, cb: (...args: any[]) => any) => {
                eventHandlers[event] = cb;
            }),
            emit: jest.fn(),
            join: jest.fn(async () => undefined),
            leave: jest.fn(),
            handshake: { auth: { token: "token" } },
        };

        connectionHandler(socket);
        return { socketService, eventHandlers, socket };
    }

    it("initializes and shuts down listen-together socket namespace cleanly", () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");

        expect(socketService.getListenTogetherIO()).toBeNull();

        const io = socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);
        expect(io).toBeTruthy();
        expect(socketService.getListenTogetherIO()).toBe(io);
        expect(mocks.namespace.use).toHaveBeenCalledTimes(1);
        expect(mocks.namespace.on).toHaveBeenCalledWith(
            "connection",
            expect.any(Function)
        );

        socketService.shutdownListenTogetherSocket();

        expect(mocks.getIO()?.close).toHaveBeenCalledTimes(1);
        expect(mocks.listenTogetherClusterSync.stop).toHaveBeenCalledTimes(1);
        expect(mocks.listenTogetherStateStore.stop).toHaveBeenCalledTimes(1);
        expect(mocks.adapterPubClient.disconnect).toHaveBeenCalledTimes(1);
        expect(mocks.adapterSubClient.disconnect).toHaveBeenCalledTimes(1);
        expect(mocks.mutationLockClient.disconnect).toHaveBeenCalledTimes(1);
        expect(socketService.getListenTogetherIO()).toBeNull();
    });

    it("handles join, playback, queue, ready, ping, and leave socket events with expected acks", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        const connectionCall = mocks.namespace.on.mock.calls.find(
            (call: unknown[]) => call[0] === "connection"
        );
        expect(connectionCall).toBeTruthy();
        const connectionHandler = connectionCall[1];

        const eventHandlers: Record<string, (...args: any[]) => any> = {};
        const socket: any = {
            id: "sock-1",
            data: {
                userId: "user-1",
                username: "User One",
                groupId: null,
            },
            on: jest.fn((event: string, cb: (...args: any[]) => any) => {
                eventHandlers[event] = cb;
            }),
            emit: jest.fn(),
            join: jest.fn(async () => undefined),
            leave: jest.fn(),
            handshake: { auth: { token: "token" } },
        };

        connectionHandler(socket);

        const missingJoinAck = jest.fn();
        await eventHandlers["join-group"]({}, missingJoinAck);
        expect(missingJoinAck).toHaveBeenCalledWith({
            error: "groupId is required",
        });

        const joinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, joinAck);
        expect(mocks.joinGroupById).toHaveBeenCalledWith(
            "user-1",
            "User One",
            "group-1"
        );
        expect(mocks.groupManager.addSocket).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            "sock-1"
        );
        expect(joinAck).toHaveBeenCalledWith({ ok: true });

        const playbackAck = jest.fn();
        await eventHandlers["playback"]({ action: "pause" }, playbackAck);
        expect(mocks.groupManager.pause).toHaveBeenCalledWith(
            "group-1",
            "user-1"
        );
        expect(playbackAck).toHaveBeenCalledWith({ ok: true });

        const queueInvalidAck = jest.fn();
        await eventHandlers["queue"]({ action: "add", trackIds: [] }, queueInvalidAck);
        expect(queueInvalidAck).toHaveBeenCalledWith({
            error: "trackIds required",
        });

        mocks.validateLocalTracks.mockResolvedValueOnce([]);
        const queueNoTracksAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: ["bad-track"] },
            queueNoTracksAck
        );
        expect(queueNoTracksAck).toHaveBeenCalledWith({
            error: "No valid local tracks found",
        });

        mocks.validateLocalTracks.mockResolvedValueOnce([{ id: "track-1" }]);
        const queueAddAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: ["track-1"] },
            queueAddAck
        );
        expect(mocks.groupManager.modifyQueue).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            { action: "add", items: [{ id: "track-1" }] }
        );
        expect(queueAddAck).toHaveBeenCalledWith({ ok: true });

        const readyAck = jest.fn();
        await eventHandlers["ready"](readyAck);
        expect(mocks.groupManager.reportReady).toHaveBeenCalledWith(
            "group-1",
            "user-1"
        );
        expect(readyAck).toHaveBeenCalledWith({ ok: true });

        const pingAck = jest.fn();
        eventHandlers["lt-ping"](pingAck);
        expect(pingAck).toHaveBeenCalledWith(
            expect.objectContaining({
                serverTime: expect.any(Number),
            })
        );

        const leaveAck = jest.fn();
        await eventHandlers["leave-group"](leaveAck);
        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");
        expect(leaveAck).toHaveBeenCalledWith({ ok: true });

        socketService.shutdownListenTogetherSocket();
    });

    it("fails module initialization when JWT_SECRET and SESSION_SECRET are missing", () => {
        process.env = { ...originalEnv };
        delete process.env.JWT_SECRET;
        delete process.env.SESSION_SECRET;
        setupListenTogetherSocketMocks();

        expect(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require("../listenTogetherSocket");
        }).toThrow("JWT_SECRET or SESSION_SECRET is required for Socket.IO auth");
    });

    it("handles auth middleware success and failure branches", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        const authMiddleware = mocks.namespace.use.mock.calls[0][0];
        const makeSocket = (token?: string) => ({
            handshake: { auth: token ? { token } : {} },
            data: {},
        });

        const missingTokenNext = jest.fn();
        await authMiddleware(makeSocket(), missingTokenNext);
        expect(missingTokenNext.mock.calls[0][0].message).toBe(
            "Authentication required"
        );

        mocks.prismaUserFindUnique.mockResolvedValueOnce(null);
        const missingUserNext = jest.fn();
        await authMiddleware(makeSocket("token"), missingUserNext);
        expect(missingUserNext.mock.calls[0][0].message).toBe("User not found");

        mocks.jwtVerify.mockReturnValueOnce({
            userId: "user-1",
            username: "User One",
            role: "USER",
            tokenVersion: 99,
        });
        mocks.prismaUserFindUnique.mockResolvedValueOnce({
            id: "user-1",
            username: "User One",
            role: "USER",
            tokenVersion: 1,
        });
        const expiredTokenNext = jest.fn();
        await authMiddleware(makeSocket("token"), expiredTokenNext);
        expect(expiredTokenNext.mock.calls[0][0].message).toBe("Token expired");

        mocks.jwtVerify.mockImplementationOnce(() => {
            throw new Error("bad token");
        });
        const invalidTokenNext = jest.fn();
        await authMiddleware(makeSocket("token"), invalidTokenNext);
        expect(invalidTokenNext.mock.calls[0][0].message).toBe("Invalid token");

        const successSocket: any = makeSocket("token");
        const successNext = jest.fn();
        await authMiddleware(successSocket, successNext);
        expect(successNext).toHaveBeenCalledWith();
        expect(successSocket.data).toEqual({
            userId: "user-1",
            username: "User One",
            groupId: null,
        });
    });

    it("covers setup branches for disabled adapter/locks and cluster-sync startup failure", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
            LISTEN_TOGETHER_ALLOW_POLLING: "true",
        };
        const mocks = setupListenTogetherSocketMocks();
        mocks.listenTogetherClusterSync.isEnabled.mockReturnValue(true);
        mocks.listenTogetherClusterSync.start.mockRejectedValueOnce(
            new Error("sync startup failed")
        );
        mocks.listenTogetherStateStore.isEnabled.mockReturnValue(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        await Promise.resolve();

        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/WS] Redis adapter disabled via LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=false"
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/MutationLock] Disabled via LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=false"
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/StateStore] Disabled via LISTEN_TOGETHER_STATE_STORE_ENABLED=false"
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/WS] Transport policy: websocket + polling fallback"
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Failed to start cluster sync; proceeding with pod-local state",
            expect.any(Error)
        );
    });

    it("handles redis-adapter initialization failures and state-store-disabled warning", () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        mocks.createIORedisClient.mockImplementation((name: string) => {
            if (name.includes("socket-adapter-pub")) {
                throw new Error("adapter redis unavailable");
            }
            return mocks.mutationLockClient;
        });
        mocks.listenTogetherStateStore.isEnabled.mockReturnValue(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/WS] Failed to initialize Redis adapter; continuing in single-pod fanout mode",
            expect.any(Error)
        );
    });

    it("wires manager callbacks to socket broadcasts and snapshot publication", () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        const snapshot = {
            id: "group-1",
            members: [],
            playback: { queue: [], currentIndex: 0, isPlaying: false },
        };

        mocks.groupManager.snapshotById.mockReturnValue(snapshot);

        callbacks.onGroupState("group-1", snapshot);
        callbacks.onPlaybackDelta("group-1", { isPlaying: true });
        callbacks.onQueueDelta("group-1", { queue: [] });
        callbacks.onWaiting("group-1", { trackId: "track-1", currentIndex: 0 });
        callbacks.onPlayAt("group-1", {
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 1,
        });
        callbacks.onMemberJoined("group-1", { userId: "u1", username: "User 1" });
        callbacks.onMemberLeft("group-1", { userId: "u2", username: "User 2" });
        callbacks.onGroupEnded("group-1", "ended");

        expect(mocks.namespace.to).toHaveBeenCalledWith("group-1");
        expect(mocks.listenTogetherStateStore.setSnapshot).toHaveBeenCalled();
        expect(mocks.listenTogetherClusterSync.publishSnapshot).toHaveBeenCalled();
        expect(mocks.listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1"
        );
    });

    it("covers playback/queue/ready error branches and conflict handling", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const noGroupPlaybackAck = jest.fn();
        await eventHandlers["playback"]({ action: "pause" }, noGroupPlaybackAck);
        expect(noGroupPlaybackAck).toHaveBeenCalledWith({
            error: "Not in a group",
        });

        socket.data.groupId = "group-1";

        const seekMissingAck = jest.fn();
        await eventHandlers["playback"]({ action: "seek" }, seekMissingAck);
        expect(seekMissingAck).toHaveBeenCalledWith({
            error: "positionMs required for seek",
        });

        const setTrackMissingAck = jest.fn();
        await eventHandlers["playback"]({ action: "set-track" }, setTrackMissingAck);
        expect(setTrackMissingAck).toHaveBeenCalledWith({
            error: "index required for set-track",
        });

        const unknownPlaybackAck = jest.fn();
        await eventHandlers["playback"]({ action: "boom" }, unknownPlaybackAck);
        expect(unknownPlaybackAck).toHaveBeenCalledWith({
            error: "Unknown action: boom",
        });

        mocks.mutationLockClient.set.mockResolvedValueOnce("NOPE");
        const conflictPlaybackAck = jest.fn();
        await eventHandlers["playback"]({ action: "play" }, conflictPlaybackAck);
        expect(conflictPlaybackAck).toHaveBeenCalledWith({
            error: "Another group update is in progress. Please retry.",
        });

        const noGroupQueueAck = jest.fn();
        socket.data.groupId = null;
        await eventHandlers["queue"]({ action: "clear" }, noGroupQueueAck);
        expect(noGroupQueueAck).toHaveBeenCalledWith({
            error: "Not in a group",
        });

        socket.data.groupId = "group-1";
        const removeMissingIndexAck = jest.fn();
        await eventHandlers["queue"](
            { action: "remove" },
            removeMissingIndexAck
        );
        expect(removeMissingIndexAck).toHaveBeenCalledWith({
            error: "index required",
        });

        const reorderMissingAck = jest.fn();
        await eventHandlers["queue"](
            { action: "reorder", fromIndex: 1 },
            reorderMissingAck
        );
        expect(reorderMissingAck).toHaveBeenCalledWith({
            error: "fromIndex and toIndex required",
        });

        const unknownQueueAck = jest.fn();
        await eventHandlers["queue"]({ action: "unknown" }, unknownQueueAck);
        expect(unknownQueueAck).toHaveBeenCalledWith({
            error: "Unknown action: unknown",
        });

        mocks.mutationLockClient.set.mockResolvedValueOnce("NOPE");
        const conflictQueueAck = jest.fn();
        await eventHandlers["queue"]({ action: "clear" }, conflictQueueAck);
        expect(conflictQueueAck).toHaveBeenCalledWith({
            error: "Another group update is in progress. Please retry.",
        });

        socket.data.groupId = null;
        await eventHandlers["ready"]({ some: "payload" });

        socket.data.groupId = "group-1";
        mocks.mutationLockClient.set.mockResolvedValueOnce("NOPE");
        const readyConflictAck = jest.fn();
        await eventHandlers["ready"]({ payload: true }, readyConflictAck);
        expect(readyConflictAck).toHaveBeenCalledWith({
            error: "Ready report failed",
        });

        socketService.shutdownListenTogetherSocket();
    });

    it("handles disconnect cleanup timers, reconnect grace behavior, and leave-group failure ack", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValueOnce(0);
        await eventHandlers["disconnect"]("transport close");
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValueOnce(1);
        await eventHandlers["disconnect"]("transport close");
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.leaveGroup).toHaveBeenCalledTimes(1);

        socket.data.groupId = "group-1";
        socket.leave.mockImplementationOnce(() => {
            throw new Error("leave failed");
        });
        const leaveAck = jest.fn();
        await eventHandlers["leave-group"](leaveAck);
        expect(leaveAck).toHaveBeenCalledWith({
            error: "Failed to leave group",
        });

        socket.data.groupId = "group-1";
        socket.leave.mockImplementationOnce(() => undefined);
        mocks.groupManager.socketCount.mockReturnValueOnce(0);
        mocks.leaveGroup.mockRejectedValueOnce(new Error("cleanup failed"));
        await eventHandlers["disconnect"]("transport close");
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/WS] Failed stale-member cleanup for User One (group-1):",
            expect.any(Error)
        );

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("covers playback and queue success branches plus join-room handoff", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers } = bootstrapConnectedSocket(mocks);

        const originCallback = mocks.getServerOptions().cors.origin;
        const corsAck = jest.fn();
        originCallback("https://example.test", corsAck);
        expect(corsAck).toHaveBeenCalledWith(null, true);

        const firstJoinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, firstJoinAck);
        expect(firstJoinAck).toHaveBeenCalledWith({ ok: true });

        mocks.listenTogetherStateStore.getSnapshot.mockResolvedValueOnce({
            id: "group-1",
            members: [],
            playback: { queue: [], currentIndex: 0, isPlaying: false },
        });
        mocks.mutationLockClient.eval.mockRejectedValueOnce(
            new Error("release failed")
        );
        const nextAck = jest.fn();
        await eventHandlers["playback"]({ action: "next" }, nextAck);
        expect(nextAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.applyExternalSnapshot).toHaveBeenCalled();
        expect(mocks.groupManager.next).toHaveBeenCalledWith("group-1", "user-1");
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/MutationLock] Failed to release lock for playback:next (group-1)",
            expect.any(Error)
        );

        const previousAck = jest.fn();
        await eventHandlers["playback"]({ action: "previous" }, previousAck);
        expect(previousAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.previous).toHaveBeenCalledWith("group-1", "user-1");

        const setTrackAck = jest.fn();
        await eventHandlers["playback"](
            { action: "set-track", index: 2 },
            setTrackAck
        );
        expect(setTrackAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.setTrack).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            2
        );

        const queueRemoveAck = jest.fn();
        await eventHandlers["queue"]({ action: "remove", index: 0 }, queueRemoveAck);
        expect(queueRemoveAck).toHaveBeenCalledWith({ ok: true });

        const queueReorderAck = jest.fn();
        await eventHandlers["queue"](
            { action: "reorder", fromIndex: 0, toIndex: 1 },
            queueReorderAck
        );
        expect(queueReorderAck).toHaveBeenCalledWith({ ok: true });

        const queueClearAck = jest.fn();
        await eventHandlers["queue"]({ action: "clear" }, queueClearAck);
        expect(queueClearAck).toHaveBeenCalledWith({ ok: true });

        mocks.joinGroupById.mockResolvedValueOnce({
            groupId: "group-2",
            hostUserId: "user-1",
            members: [],
            queue: [],
            playback: { status: "paused", index: 0, positionMs: 0 },
        });
        const handoffJoinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-2" }, handoffJoinAck);
        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");
        expect(handoffJoinAck).toHaveBeenCalledWith({ ok: true });

        socketService.shutdownListenTogetherSocket();
    });

    it("covers join-group failure, explicit leave logger path, and mutation-lock acquire failures", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        mocks.joinGroupById.mockRejectedValueOnce(new Error("join failed"));
        const failedJoinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, failedJoinAck);
        expect(failedJoinAck).toHaveBeenCalledWith({ error: "Failed to join group" });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/WS] join-group error:",
            expect.any(Error)
        );

        socket.data.groupId = "group-1";
        mocks.leaveGroup.mockRejectedValueOnce(new Error("leave failed"));
        const leaveAck = jest.fn();
        await eventHandlers["leave-group"](leaveAck);
        expect(leaveAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/WS] Error leaving group:",
            expect.any(Error)
        );

        socket.data.groupId = "group-1";
        mocks.mutationLockClient.set.mockRejectedValueOnce(new Error("redis down"));
        const lockFailureAck = jest.fn();
        await eventHandlers["playback"]({ action: "play" }, lockFailureAck);
        expect(lockFailureAck).toHaveBeenCalledWith({
            error: "Group coordination temporarily unavailable. Please retry.",
        });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/MutationLock] Failed to acquire lock for playback:play (group-1)",
            expect.any(Error)
        );

        socketService.shutdownListenTogetherSocket();
    });

    it("covers reconnect observability, pending cleanup dedupe, and shutdown timer clearing", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "1",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const joinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, joinAck);
        expect(joinAck).toHaveBeenCalledWith({ ok: true });

        mocks.groupManager.socketCount.mockReturnValue(0);
        await eventHandlers["disconnect"]("network");
        socket.data.groupId = "group-1";
        await eventHandlers["disconnect"]("network");

        await jest.advanceTimersByTimeAsync(5);
        const reconnectAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, reconnectAck);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("[ListenTogether/SLO] Reconnect latency"),
        );

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValue(1);
        await eventHandlers["disconnect"]("network");
        await jest.advanceTimersByTimeAsync(60_000);

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValue(0);
        await eventHandlers["disconnect"]("network");
        const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
        socketService.shutdownListenTogetherSocket();
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
        jest.useRealTimers();
    });

    it("logs periodic observability summaries when conflict volume reaches threshold", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        socket.data.groupId = "group-1";
        for (let index = 0; index < 25; index += 1) {
            mocks.mutationLockClient.set.mockResolvedValueOnce("NOPE");
            const ack = jest.fn();
            await eventHandlers["playback"]({ action: "play" }, ack);
        }

        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                "[ListenTogether/Observability] reason=conflict"
            )
        );

        socketService.shutdownListenTogetherSocket();
    });

    it("uses direct mutation path with lock disabled and covers play/seek success actions", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        socket.data.groupId = "group-1";
        const playAck = jest.fn();
        await eventHandlers["playback"]({ action: "play" }, playAck);
        expect(playAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.play).toHaveBeenCalledWith("group-1", "user-1");

        const seekAck = jest.fn();
        await eventHandlers["playback"](
            { action: "seek", positionMs: 1200 },
            seekAck
        );
        expect(seekAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.seek).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            1200
        );

        expect(mocks.mutationLockClient.set).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
    });

    it("logs adapter state-store warning and applies snapshots from cluster-sync callbacks", () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        mocks.listenTogetherStateStore.isEnabled.mockReturnValue(false);
        mocks.listenTogetherClusterSync.isEnabled.mockReturnValue(true);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "[ListenTogether/WS] Cross-pod fanout is enabled, but authoritative session snapshots are disabled (LISTEN_TOGETHER_STATE_STORE_ENABLED=false); GroupManager state remains pod-local in-memory between mutations."
        );

        const clusterHandler = mocks.listenTogetherClusterSync.start.mock.calls[0][0];
        const snapshot = { id: "group-1", playback: {}, members: [] };
        clusterHandler(snapshot);
        expect(mocks.groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            snapshot
        );
    });

    it("records reconnect samples under SLO and skips stale cleanup when sockets remain connected", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "5000",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const initialJoinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, initialJoinAck);
        expect(initialJoinAck).toHaveBeenCalledWith({ ok: true });

        mocks.groupManager.socketCount.mockReturnValueOnce(0);
        await eventHandlers["disconnect"]("network");
        await jest.advanceTimersByTimeAsync(20);
        const reconnectAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, reconnectAck);
        expect(reconnectAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("exceeded target"),
        );

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValueOnce(0).mockReturnValueOnce(1);
        await eventHandlers["disconnect"]("network");
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.leaveGroup).not.toHaveBeenCalled();

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });
});
