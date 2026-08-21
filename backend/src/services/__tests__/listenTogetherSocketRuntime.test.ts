import { DeterministicRedisServer } from "./support/deterministicRedis";
import {
    LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
    LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT,
    LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
    LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT,
} from "../listenTogetherRedisScripts";

describe("listen together socket runtime behavior", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupListenTogetherSocketMocks(
        redisServer?: DeterministicRedisServer,
    ) {
        let ioInstance: any = null;
        let serverOptions: any = null;
        const roomEmit = jest.fn();
        const namespace = {
            use: jest.fn(),
            on: jest.fn(),
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: roomEmit })),
            in: jest.fn(() => ({ fetchSockets: jest.fn(async () => []) })),
            sockets: new Map(),
        };
        const logger: any = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        logger.child = jest.fn(() => logger);
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
            pendingDeletionAt: null,
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

        let nextFencingToken = 0;
        const fallbackMutationLockClient = {
            set: jest.fn(async () => "OK"),
            incr: jest.fn(async () => {
                nextFencingToken += 1;
                return nextFencingToken;
            }),
            eval: jest.fn(async (script: string) => {
                if (
                    script.includes("listen-together:acquire-lease-and-fence")
                ) {
                    nextFencingToken += 1;
                    return [1, nextFencingToken];
                }
                return 1;
            }),
            disconnect: jest.fn(),
            duplicate: jest.fn(),
        };
        const adapterSubClient = {
            disconnect: jest.fn(),
        };
        const fallbackAdapterPubClient = {
            set: jest.fn(async () => "OK"),
            incr: jest.fn(async () => 1),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
            duplicate: jest.fn(() => adapterSubClient),
        };

        const mutationLockClient: any = redisServer
            ? redisServer.createClient()
            : fallbackMutationLockClient;
        const adapterPubClient: any = redisServer
            ? redisServer.createClient()
            : fallbackAdapterPubClient;
        const createIORedisClient = jest.fn((name: string) => {
            if (name.includes("socket-adapter-pub")) return adapterPubClient;
            return mutationLockClient;
        });
        let socialPresenceCallback:
            | ((event: Record<string, unknown>) => void)
            | null = null;
        const unsubscribeSocialPresenceUpdates = jest.fn();
        const subscribeSocialPresenceUpdates = jest.fn(
            (callback: (event: Record<string, unknown>) => void) => {
                socialPresenceCallback = callback;
                return unsubscribeSocialPresenceUpdates;
            },
        );

        const listenTogetherClusterSync: any = {
            isEnabled: jest.fn(() => false),
            start: jest.fn(async () => undefined),
            publishSnapshot: jest.fn(async () => undefined),
            publishMembership: jest.fn(async () => undefined),
            publishEnded: jest.fn(async () => undefined),
            publishUserRevocation: jest.fn(async () => undefined),
            stop: jest.fn(async () => undefined),
        };
        const listenTogetherStateStore: any = {
            isEnabled: jest.fn(() => true),
            getSnapshot: jest.fn(async () => ({
                id: "group-1",
                joinCode: "ABC123",
                members: [],
                playback: { queue: [], stateVersion: 1 },
            })),
            setSnapshot: jest.fn(async () => "accepted"),
            deleteSnapshot: jest.fn(async () => "accepted"),
            claimFence: jest.fn(async () => "accepted"),
            stop: jest.fn(),
        };
        const groupManager: any = {
            setCallbacks: jest.fn(),
            has: jest.fn(() => true),
            hasMember: jest.fn(() => true),
            get: jest.fn((groupId: string) => ({
                id: groupId,
                joinCode: "ABC123",
            })),
            snapshot: jest.fn((_group: unknown) => ({
                id: "group-1",
                joinCode: "ABC123",
                playback: { queue: [], stateVersion: 1 },
                members: [],
            })),
            applyExternalSnapshot: jest.fn(),
            applyCommittedMembership: jest.fn(() => []),
            evictLocalMember: jest.fn(),
            remove: jest.fn(),
            snapshotById: jest.fn(() => null),
            setUnavailableIndices: jest.fn(),
            removeSocket: jest.fn(),
            socketCount: jest.fn(() => 0),
            addSocket: jest.fn(() => true),
            play: jest.fn(),
            pause: jest.fn(),
            seek: jest.fn(),
            next: jest.fn(),
            previous: jest.fn(),
            setTrack: jest.fn(),
            modifyQueue: jest.fn(() => ({
                queue: [{ id: "track-1" }],
                currentIndex: 0,
                trackId: "track-1",
                stateVersion: 1,
            })),
            reportReady: jest.fn(),
            handleReadyGateCompletion: jest.fn(),
            rearmReadyGateCompletion: jest.fn(),
            handleBoundaryWatchdog: jest.fn(),
            invalidate: jest.fn(),
            markPublicationConfirmed: jest.fn(),
        };
        const joinGroupById = jest.fn(async () => ({
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [],
            playback: { status: "paused", index: 0, positionMs: 0 },
        }));
        const leaveGroup = jest.fn(async () => undefined);
        const validateQueueTracks = jest.fn(async () => [{ id: "track-1" }]);
        const resolveQueueForUser = jest.fn(async () => new Map());
        const publishAvailabilityForGroup = jest.fn(async () => false);
        const trackMappingService = {
            markStale: jest.fn(async () => undefined),
        };
        class MockGroupError extends Error {
            constructor(
                public code: string,
                message: string,
                public readonly retryable: boolean = code === "CONFLICT" ||
                    code === "UNAVAILABLE",
            ) {
                super(message);
            }
        }

        // Mutable config mock so tests can exercise ALLOWED_ORIGINS allowlist
        // semantics ([] = unset → deny cross-origin in production).
        const positiveIntEnvOr = (
            value: string | undefined,
            fallback: number,
        ): number => {
            const parsed = Number.parseInt(value || `${fallback}`, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const configMock = {
            nodeEnv: "production",
            allowedOrigins: [] as boolean | string[],
            listenTogether: {
                reconnectSloMs: positiveIntEnvOr(
                    process.env.LISTEN_TOGETHER_RECONNECT_SLO_MS,
                    5000,
                ),
                allowPolling:
                    process.env.LISTEN_TOGETHER_ALLOW_POLLING === "true",
                redisAdapterEnabled:
                    process.env.LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED !==
                    "false",
                mutationLockEnabled:
                    process.env.LISTEN_TOGETHER_MUTATION_LOCK_ENABLED !==
                    "false",
                stateStoreEnabled: true,
                stateSyncEnabled:
                    process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED !== "false",
                mutationLockTtlMs: positiveIntEnvOr(
                    process.env.LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS,
                    3000,
                ),
                mutationLockRenewIntervalMs: positiveIntEnvOr(
                    process.env.LISTEN_TOGETHER_MUTATION_LOCK_RENEW_INTERVAL_MS,
                    1000,
                ),
                publicationDeadlineMs: positiveIntEnvOr(
                    process.env.LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
                    750,
                ),
                mutationLockPrefix:
                    process.env.LISTEN_TOGETHER_MUTATION_LOCK_PREFIX ||
                    "listen-together:mutation-lock",
            },
        };
        configMock.listenTogether.stateStoreEnabled =
            process.env.LISTEN_TOGETHER_STATE_STORE_ENABLED !== "false";
        listenTogetherStateStore.isEnabled.mockImplementation(
            () => configMock.listenTogether.stateStoreEnabled,
        );

        jest.doMock("socket.io", () => ({ Server: MockServer }));
        jest.doMock("../../config", () => ({ config: configMock }));
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
        jest.doMock("../socialPresenceEvents", () => ({
            subscribeSocialPresenceUpdates,
        }));
        jest.doMock("../listenTogetherClusterSync", () => ({
            listenTogetherClusterSync,
        }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore,
        }));
        jest.doMock("../listenTogetherManager", () => ({
            groupManager,
            GroupError: MockGroupError,
            MAX_QUEUE_SIZE: 500,
        }));
        jest.doMock("../listenTogetherGroupError", () => ({
            GroupError: MockGroupError,
            groupErrorMessage: (failure: unknown, fallback: string) =>
                failure instanceof MockGroupError ? failure.message : fallback,
        }));
        jest.doMock("../listenTogether", () => ({
            joinGroupById,
            joinGroupByIdAdmitted: joinGroupById,
            leaveGroup,
            leaveGroupAdmitted: leaveGroup,
            validateQueueTracks,
        }));
        jest.doMock("../listenTogetherResolution", () => ({
            resolveQueueForUser,
        }));
        jest.doMock("../listenTogetherAvailabilityPublication", () => ({
            publishAvailabilityForGroup,
            resetAvailabilityPublications: jest.fn(),
            shutdownAvailabilityPublications: jest.fn(),
        }));
        jest.doMock("../trackMappingService", () => ({
            trackMappingService,
        }));
        jest.doMock(
            "@socket.io/redis-adapter",
            () => ({
                createAdapter: jest.fn(() => "redis-adapter"),
            }),
            { virtual: true },
        );

        return {
            getIO: () => ioInstance,
            getServerOptions: () => serverOptions,
            configMock,
            namespace,
            roomEmit,
            createIORedisClient,
            adapterPubClient,
            adapterSubClient,
            mutationLockClient,
            subscribeSocialPresenceUpdates,
            unsubscribeSocialPresenceUpdates,
            emitSocialPresence: (event: Record<string, unknown>) =>
                socialPresenceCallback?.(event),
            listenTogetherClusterSync,
            listenTogetherStateStore,
            groupManager,
            joinGroupById,
            leaveGroup,
            validateQueueTracks,
            resolveQueueForUser,
            publishAvailabilityForGroup,
            trackMappingService,
            logger,
            jwtVerify,
            prismaUserFindUnique,
            MockGroupError,
        };
    }

    function bootstrapConnectedSocket(
        mocks: ReturnType<typeof setupListenTogetherSocketMocks>,
    ) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        const connectionCall = mocks.namespace.on.mock.calls.find(
            (call: unknown[]) => call[0] === "connection",
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
            expect.any(Function),
        );
        expect(mocks.getIO()?.adapter).toHaveBeenCalledWith("redis-adapter");
        expect(mocks.getServerOptions().transports).toEqual(["websocket"]);

        socketService.shutdownListenTogetherSocket();

        expect(mocks.getIO()?.close).toHaveBeenCalledTimes(1);
        expect(mocks.listenTogetherClusterSync.stop).toHaveBeenCalledTimes(1);
        expect(mocks.listenTogetherStateStore.stop).toHaveBeenCalledTimes(1);
        expect(mocks.adapterPubClient.disconnect).toHaveBeenCalledTimes(1);
        expect(mocks.adapterSubClient.disconnect).toHaveBeenCalledTimes(1);
        expect(mocks.mutationLockClient.disconnect).toHaveBeenCalledTimes(1);
        expect(socketService.getListenTogetherIO()).toBeNull();
    });

    it("enforces the Express ALLOWED_ORIGINS allowlist semantics for socket CORS", () => {
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

        const corsOptions = mocks.getServerOptions().cors;
        expect(corsOptions.credentials).toBe(true);

        const evaluate = (origin?: string) => {
            let allowed: unknown;
            corsOptions.origin(origin, (_err: unknown, allow?: unknown) => {
                allowed = allow;
            });
            return allowed;
        };

        // ALLOWED_ORIGINS unset ([]) → deny cross-origin in production.
        expect(evaluate("https://anything.example")).toBe(false);
        // Requests with no Origin header (same-origin) are always allowed.
        expect(evaluate(undefined)).toBe(true);

        // CORS_ALLOW_ALL restores permissive behavior.
        mocks.configMock.allowedOrigins = true;
        expect(evaluate("https://anything.example")).toBe(true);

        // A configured allowlist is enforced.
        mocks.configMock.allowedOrigins = ["https://app.example"];
        expect(evaluate("https://app.example")).toBe(true);
        expect(evaluate("https://evil.example")).toBe(false);
        expect(evaluate(undefined)).toBe(true);

        socketService.shutdownListenTogetherSocket();
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
            (call: unknown[]) => call[0] === "connection",
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
            "group-1",
        );
        expect(mocks.groupManager.addSocket).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            "sock-1",
        );
        expect(joinAck).toHaveBeenCalledWith({ ok: true });

        const playbackAck = jest.fn();
        await eventHandlers["playback"]({ action: "pause" }, playbackAck);
        expect(mocks.groupManager.pause).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );
        expect(playbackAck).toHaveBeenCalledWith({ ok: true });

        const queueInvalidAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: [] },
            queueInvalidAck,
        );
        expect(queueInvalidAck).toHaveBeenCalledWith({
            error: "trackIds required",
        });

        mocks.validateQueueTracks.mockResolvedValueOnce([]);
        const queueNoTracksAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: ["bad-track"] },
            queueNoTracksAck,
        );
        expect(queueNoTracksAck).toHaveBeenCalledWith({
            error: "No valid tracks found",
        });

        mocks.validateQueueTracks.mockResolvedValueOnce([{ id: "track-1" }]);
        const queueAddAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: ["track-1"] },
            queueAddAck,
        );
        expect(mocks.groupManager.modifyQueue).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            { action: "add", items: [{ id: "track-1" }] },
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );
        expect(queueAddAck).toHaveBeenCalledWith({
            ok: true,
            acceptedCount: 1,
            skippedCount: 0,
            truncated: false,
        });

        mocks.groupManager.snapshotById.mockReturnValue({
            playback: {
                queue: Array.from({ length: 499 }, (_, index) => ({
                    id: `existing-${index}`,
                })),
            },
        });
        mocks.validateQueueTracks.mockResolvedValueOnce([{ id: "track-a" }]);
        mocks.groupManager.modifyQueue.mockReturnValueOnce({
            queue: Array.from({ length: 500 }, (_, index) => ({
                id: index === 499 ? "track-a" : `existing-${index}`,
            })),
            currentIndex: 0,
            trackId: "track-a",
            stateVersion: 2,
        });
        const queueTruncateAck = jest.fn();
        await eventHandlers["queue"](
            { action: "add", trackIds: ["track-a", "track-b"] },
            queueTruncateAck,
        );
        expect(mocks.validateQueueTracks).toHaveBeenLastCalledWith([
            { trackId: "track-a" },
        ]);
        expect(queueTruncateAck).toHaveBeenCalledWith({
            ok: true,
            acceptedCount: 1,
            skippedCount: 1,
            truncated: true,
        });

        const readySnapshot = {
            id: "group-1",
            syncState: "waiting",
            playback: { queue: [], stateVersion: 3 },
            members: [],
        };
        mocks.groupManager.snapshotById.mockReturnValue(readySnapshot);
        const readyAck = jest.fn();
        await eventHandlers["ready"](readyAck);
        expect(mocks.groupManager.reportReady).toHaveBeenCalledWith(
            "group-1",
            "user-1",
        );
        expect(mocks.listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { ...readySnapshot, membershipVersion: 0 },
            expect.any(Number),
        );
        expect(readyAck).toHaveBeenCalledWith({ ok: true });

        const pingAck = jest.fn();
        eventHandlers["lt-ping"](pingAck);
        expect(pingAck).toHaveBeenCalledWith(
            expect.objectContaining({
                serverTime: expect.any(Number),
            }),
        );

        const leaveAck = jest.fn();
        await eventHandlers["leave-group"](leaveAck);
        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");
        expect(leaveAck).toHaveBeenCalledWith({ ok: true });

        socketService.shutdownListenTogetherSocket();
    });

    it("re-emits refreshed group state and clears pending disconnect cleanup on same-room reconnect", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const initialSnapshot: {
            groupId: string;
            hostUserId: string;
            members: unknown[];
            queue: Array<{ id: string }>;
            playback: { status: string; index: number; positionMs: number };
        } = {
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [],
            playback: { status: "paused", index: 0, positionMs: 12_000 },
        };
        const refreshedSnapshot: typeof initialSnapshot = {
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [{ id: "track-2" }],
            playback: { status: "playing", index: 1, positionMs: 48_500 },
        };
        mocks.joinGroupById
            .mockResolvedValueOnce(initialSnapshot as any)
            .mockResolvedValueOnce(refreshedSnapshot as any);
        mocks.groupManager.snapshot
            .mockReturnValueOnce(initialSnapshot)
            .mockReturnValueOnce(refreshedSnapshot);

        const initialJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            initialJoinAck,
        );
        expect(initialJoinAck).toHaveBeenCalledWith({ ok: true });
        expect(socket.emit).toHaveBeenNthCalledWith(
            1,
            "group:state",
            initialSnapshot,
        );

        mocks.groupManager.socketCount.mockReturnValueOnce(0);
        await eventHandlers["disconnect"]("transport close");
        expect(socket.leave).toHaveBeenCalledTimes(1);
        expect(socket.leave).toHaveBeenCalledWith("group-1");

        await jest.advanceTimersByTimeAsync(20);
        const reconnectJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            reconnectJoinAck,
        );
        expect(reconnectJoinAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.joinGroupById).toHaveBeenNthCalledWith(
            2,
            "user-1",
            "User One",
            "group-1",
        );
        expect(mocks.leaveGroup).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenNthCalledWith(
            2,
            "group:state",
            refreshedSnapshot,
        );
        expect(socket.join).toHaveBeenNthCalledWith(2, "group-1");

        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.leaveGroup).not.toHaveBeenCalled();

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("broadcasts only presence when fallback hydration connects a member", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers } =
            bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        mocks.groupManager.addSocket.mockImplementationOnce(
            (groupId: string, userId: string) => {
                callbacks.onMemberPresence(groupId, {
                    userId,
                    isConnected: true,
                });
                return true;
            },
        );

        const ack = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, ack);

        expect(ack).toHaveBeenCalledWith({ ok: true });
        expect(mocks.roomEmit).toHaveBeenCalledWith("group:member-presence", {
            userId: "user-1",
            isConnected: true,
            groupId: "group-1",
            membershipVersion: 0,
        });
        expect(mocks.roomEmit).not.toHaveBeenCalledWith(
            "group:state",
            expect.anything(),
        );
        socketService.shutdownListenTogetherSocket();
    });

    it("delivers departure to a second tab before revoking its room membership", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const callbacks = require("../listenTogetherCallbacks");
        const secondTab = {
            id: "sock-tab-b",
            data: {
                userId: "user-1",
                username: "User One",
                groupId: "group-1",
            },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        mocks.namespace.sockets.set(secondTab.id, secondTab);
        mocks.leaveGroup.mockImplementationOnce(async () => {
            await callbacks.enqueueGroupMembershipPublication(
                "group-1",
                {
                    type: "left",
                    member: { userId: "user-1", username: "User One" },
                },
                {
                    hostUserId: "host-1",
                    members: [
                        {
                            userId: "host-1",
                            username: "Host",
                            isHost: true,
                            joinedAt: "2026-08-20T12:00:00.000Z",
                            isConnected: true,
                        },
                    ],
                },
                [secondTab.id],
            );
        });
        socket.data.groupId = "group-1";

        const ack = jest.fn();
        await eventHandlers["leave-group"](ack);

        expect(mocks.roomEmit).toHaveBeenCalledWith("group:member-left", {
            userId: "user-1",
            username: "User One",
            groupId: "group-1",
            membershipVersion: 0,
        });
        expect(secondTab.emit).toHaveBeenCalledWith(
            "group:membership-revoked",
            { groupId: "group-1", membershipVersion: 0 },
        );
        expect(secondTab.leave).toHaveBeenCalledWith("group-1");
        expect(secondTab.data.groupId).toBeNull();
        expect(mocks.roomEmit.mock.invocationCallOrder[0]).toBeLessThan(
            secondTab.emit.mock.invocationCallOrder[0],
        );
        expect(secondTab.emit.mock.invocationCallOrder[0]).toBeLessThan(
            secondTab.leave.mock.invocationCallOrder[0],
        );
        expect(ack).toHaveBeenCalledWith({ ok: true });
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
        }).toThrow(
            "JWT_SECRET or SESSION_SECRET environment variable is required for authentication",
        );
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
            "Authentication required",
        );

        mocks.prismaUserFindUnique.mockResolvedValueOnce(null);
        const missingUserNext = jest.fn();
        await authMiddleware(makeSocket("token"), missingUserNext);
        expect(missingUserNext.mock.calls[0][0].message).toBe("User not found");

        mocks.prismaUserFindUnique.mockResolvedValueOnce({
            id: "user-1",
            username: "User One",
            role: "USER",
            tokenVersion: 1,
            pendingDeletionAt: new Date("2026-08-21T12:00:00.000Z"),
        });
        const deletingUserNext = jest.fn();
        await authMiddleware(makeSocket("token"), deletingUserNext);
        expect(deletingUserNext.mock.calls[0][0].message).toBe(
            "User deletion is pending",
        );

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

        // Token-type confusion: a long-lived refresh token must never
        // authenticate a socket, even though it verifies under the same secret.
        mocks.jwtVerify.mockReturnValueOnce({
            userId: "user-1",
            tokenVersion: 1,
            type: "refresh",
        });
        const refreshTokenNext = jest.fn();
        await authMiddleware(makeSocket("token"), refreshTokenNext);
        expect(refreshTokenNext.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(refreshTokenNext.mock.calls[0][0].message).toBe("Invalid token");

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

    it("rejects and evicts a second replica command after cleanup removed Redis authority", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "true",
            LISTEN_TOGETHER_STATE_STORE_ENABLED: "true",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "true",
        };
        const redis = new DeterministicRedisServer();
        const mocks = setupListenTogetherSocketMocks(redis);
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const groupId = "group-1";
        const lockKey = `listen-together:mutation-lock:${groupId}`;
        const counterKey = `listen-together:mutation-lock:fencing-token:${groupId}`;
        const snapshotKey = `listen-together:state:${groupId}`;
        const snapshotFenceKey = `listen-together:state:fence:${groupId}`;
        redis.write(
            snapshotKey,
            JSON.stringify({
                id: groupId,
                joinCode: "ABC123",
                members: [],
                playback: { queue: [], stateVersion: 1 },
            }),
        );
        mocks.listenTogetherStateStore.getSnapshot.mockImplementation(
            async () => {
                const raw = redis.peek(snapshotKey);
                return raw ? JSON.parse(raw) : null;
            },
        );
        socket.data.groupId = groupId;
        mocks.namespace.sockets.set(socket.id, socket);
        mocks.groupManager.has.mockReturnValue(false);

        const cleanupConsumer = redis.createClient();
        const cleanupOwner = "cleanup-consumer";
        const acquisition = (await cleanupConsumer.eval(
            LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
            2,
            lockKey,
            counterKey,
            cleanupOwner,
            "3000",
        )) as [number, number];
        await cleanupConsumer.eval(
            LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT,
            3,
            snapshotKey,
            snapshotFenceKey,
            counterKey,
            "21600",
            `${acquisition[1]}`,
        );
        await cleanupConsumer.eval(
            LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
            1,
            lockKey,
            cleanupOwner,
        );

        const ack = jest.fn();
        await eventHandlers["playback"]({ action: "pause" }, ack);

        expect(ack).toHaveBeenCalledWith({
            error: "Group not found",
            code: "NOT_FOUND",
        });
        expect(mocks.groupManager.pause).not.toHaveBeenCalled();
        expect(mocks.groupManager.invalidate).toHaveBeenCalledWith(groupId);
        expect(mocks.roomEmit).toHaveBeenCalledWith("group:ended", {
            reason: "Group ended",
        });
        expect(socket.emit).toHaveBeenCalledWith("group:ended", {
            reason: "Group ended",
        });
        expect(socket.emit).toHaveBeenCalledWith("group:membership-revoked", {
            groupId,
        });
        expect(socket.leave).toHaveBeenCalledWith(groupId);
        expect(socket.data.groupId).toBeNull();
        const consumers = new Set(
            redis.commandLog
                .filter(
                    (command) =>
                        command.name === "EVAL" &&
                        String(command.args[0]).includes(
                            "acquire-lease-and-fence",
                        ),
                )
                .map((command) => command.clientId),
        );
        expect(consumers.size).toBe(2);
        socketService.shutdownListenTogetherSocket();
    });

    it("rejects a lagging replica command at fence N+1 after deletion fence N", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "true",
            LISTEN_TOGETHER_STATE_STORE_ENABLED: "true",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "true",
        };
        const redis = new DeterministicRedisServer();
        const mocks = setupListenTogetherSocketMocks(redis);
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const groupId = "group-1";
        const lockKey = `listen-together:mutation-lock:${groupId}`;
        const counterKey = `listen-together:mutation-lock:fencing-token:${groupId}`;
        const snapshotKey = `listen-together:state:${groupId}`;
        const snapshotFenceKey = `listen-together:state:fence:${groupId}`;
        const cleanedSnapshot = {
            id: groupId,
            joinCode: "ABC123",
            hostUserId: "host-1",
            members: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt: "2026-08-20T12:00:00.000Z",
                    isConnected: true,
                },
            ],
            playback: { queue: [], stateVersion: 2, serverTime: 2 },
        };
        const cleanupClient = redis.createClient();
        const cleanupOwner = "cleanup-consumer";
        const cleanupFence = (await cleanupClient.eval(
            LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
            2,
            lockKey,
            counterKey,
            cleanupOwner,
            "3000",
        )) as [number, number];
        await cleanupClient.eval(
            LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT,
            3,
            snapshotKey,
            snapshotFenceKey,
            counterKey,
            JSON.stringify(cleanedSnapshot),
            "21600",
            "2",
            "2",
            `${cleanupFence[1]}`,
        );
        await cleanupClient.eval(
            LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
            1,
            lockKey,
            cleanupOwner,
        );
        mocks.listenTogetherStateStore.getSnapshot.mockImplementation(
            async () => JSON.parse(redis.peek(snapshotKey) ?? "null"),
        );
        mocks.prismaUserFindUnique.mockResolvedValue({
            pendingDeletionAt: new Date("2026-08-21T12:00:00.000Z"),
        });
        socket.data.groupId = groupId;
        mocks.namespace.sockets.set(socket.id, socket);
        const ack = jest.fn();

        await eventHandlers["playback"]({ action: "pause" }, ack);

        expect(cleanupFence).toEqual([1, 1]);
        expect(redis.peek(counterKey)).toBe("2");
        expect(mocks.prismaUserFindUnique).toHaveBeenCalledWith({
            where: { id: "user-1" },
            select: { pendingDeletionAt: true },
        });
        expect(
            mocks.listenTogetherStateStore.getSnapshot,
        ).not.toHaveBeenCalled();
        expect(mocks.groupManager.pause).not.toHaveBeenCalled();
        expect(mocks.groupManager.evictLocalMember).toHaveBeenCalledWith(
            groupId,
            "user-1",
        );
        expect(socket.emit).toHaveBeenCalledWith("group:membership-revoked", {
            groupId,
        });
        expect(socket.leave).toHaveBeenCalledWith(groupId);
        expect(socket.data.groupId).toBeNull();
        expect(ack).toHaveBeenCalledWith({
            error: "User deletion is pending",
            code: "NOT_ALLOWED",
        });
        socketService.shutdownListenTogetherSocket();
    });

    it("keeps a malformed Redis snapshot transient without ending or evicting the group", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "true",
            LISTEN_TOGETHER_STATE_STORE_ENABLED: "true",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "true",
        };
        const mocks = setupListenTogetherSocketMocks();
        mocks.listenTogetherStateStore.getSnapshot.mockRejectedValue(
            new mocks.MockGroupError(
                "UNAVAILABLE",
                "Group state is temporarily unavailable. Please retry.",
            ),
        );
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        socket.data.groupId = "group-1";
        mocks.namespace.sockets.set(socket.id, socket);
        const ack = jest.fn();

        await eventHandlers["playback"]({ action: "pause" }, ack);

        expect(ack).toHaveBeenCalledWith({
            error: "Group state is temporarily unavailable. Please retry.",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: 300,
        });
        expect(mocks.groupManager.pause).not.toHaveBeenCalled();
        expect(mocks.groupManager.invalidate).not.toHaveBeenCalled();
        expect(mocks.roomEmit).not.toHaveBeenCalledWith(
            "group:ended",
            expect.anything(),
        );
        expect(socket.leave).not.toHaveBeenCalled();
        expect(socket.data.groupId).toBe("group-1");
        socketService.shutdownListenTogetherSocket();
    });

    it("keeps fully local socket mutations unchanged when no snapshot exists", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
            LISTEN_TOGETHER_STATE_STORE_ENABLED: "false",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
        };
        const mocks = setupListenTogetherSocketMocks();
        mocks.listenTogetherStateStore.getSnapshot.mockResolvedValue(null);
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        socket.data.groupId = "group-1";
        const ack = jest.fn();

        await eventHandlers["playback"]({ action: "pause" }, ack);

        expect(ack).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.pause).toHaveBeenCalledTimes(1);
        expect(mocks.groupManager.invalidate).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
    });

    it("keeps new-group publication valid without a prior Redis snapshot", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService } = bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        const createdSnapshot = {
            id: "new-group",
            joinCode: "NEW123",
            members: [],
            playback: { queue: [], stateVersion: 0 },
        };

        callbacks.onGroupState("new-group", createdSnapshot);
        await new Promise((resolve) => setImmediate(resolve));

        expect(mocks.listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "new-group",
            { ...createdSnapshot, membershipVersion: 0 },
            0,
        );
        expect(mocks.groupManager.invalidate).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
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
            new Error("sync startup failed"),
        );
        mocks.listenTogetherStateStore.isEnabled.mockReturnValue(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const socketService = require("../listenTogetherSocket");
        socketService.setupListenTogetherSocket({
            on: () => undefined,
        } as any);

        await Promise.resolve();

        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/WS] Redis adapter disabled via LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=false",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/MutationLock] Disabled via LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=false",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/StateStore] Disabled via LISTEN_TOGETHER_STATE_STORE_ENABLED=false",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "[ListenTogether/WS] Transport policy: websocket + polling fallback",
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/StateSync] Failed to start cluster sync; proceeding with pod-local state",
            expect.any(Error),
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
            expect.any(Error),
        );
    });

    it("falls back to default reconnect and mutation-lock timing when env values are invalid", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "0",
            LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "0",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const joinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, joinAck);
        expect(joinAck).toHaveBeenCalledWith({ ok: true });

        socket.data.groupId = "group-1";
        mocks.groupManager.socketCount.mockReturnValueOnce(0);
        await eventHandlers["disconnect"]("network");
        await jest.advanceTimersByTimeAsync(20);
        const reconnectAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, reconnectAck);
        expect(reconnectAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("exceeded target of"),
        );

        socket.data.groupId = "group-1";
        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const conflictAck = jest.fn();
        await eventHandlers["playback"]({ action: "play" }, conflictAck);
        expect(conflictAck).toHaveBeenCalledWith(
            expect.objectContaining({
                transient: true,
                retryAfterMs: 300,
            }),
        );

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("wires manager callbacks to socket broadcasts and snapshot publication", async () => {
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
        callbacks.onMemberJoined("group-1", {
            userId: "u1",
            username: "User 1",
        });
        callbacks.onMemberLeft("group-1", { userId: "u2", username: "User 2" });
        callbacks.onGroupEnded("group-1", "ended");
        await new Promise((resolve) => setImmediate(resolve));

        expect(mocks.namespace.to).toHaveBeenCalledWith("group-1");
        expect(mocks.listenTogetherStateStore.setSnapshot).toHaveBeenCalled();
        expect(
            mocks.listenTogetherClusterSync.publishSnapshot,
        ).toHaveBeenCalled();
        expect(
            mocks.listenTogetherStateStore.deleteSnapshot,
        ).toHaveBeenCalledWith("group-1", 0);
        expect(
            mocks.listenTogetherClusterSync.publishEnded,
        ).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                fencingToken: 0,
                publicationId: expect.any(String),
            }),
        );
    });

    it("broadcasts social presence updates and unsubscribes on shutdown", () => {
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

        const presenceEvent = { userId: "user-1", status: "listening" };
        mocks.emitSocialPresence(presenceEvent);
        expect(mocks.namespace.emit).toHaveBeenCalledWith(
            "social:presence-updated",
            presenceEvent,
        );

        socketService.shutdownListenTogetherSocket();
        expect(mocks.unsubscribeSocialPresenceUpdates).toHaveBeenCalledTimes(1);
    });

    it("skips persistence when no snapshot exists and recovers queued writes after failures", async () => {
        jest.useFakeTimers();
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
        mocks.groupManager.snapshotById.mockReturnValueOnce(null);
        callbacks.onQueueDelta("group-1", {
            queue: [],
            currentIndex: 0,
            trackId: null,
            stateVersion: 1,
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(
            mocks.listenTogetherStateStore.setSnapshot,
        ).not.toHaveBeenCalled();

        const snapshot = {
            id: "group-1",
            members: [],
            playback: { queue: [], currentIndex: 0, isPlaying: false },
        };
        mocks.groupManager.snapshotById.mockReturnValue(snapshot);
        mocks.listenTogetherStateStore.setSnapshot
            .mockRejectedValueOnce(new Error("set snapshot failed"))
            .mockResolvedValueOnce(undefined);

        callbacks.onPlaybackDelta("group-1", {
            isPlaying: true,
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 2,
            currentIndex: 0,
            trackId: null,
        });
        callbacks.onPlaybackDelta("group-1", {
            isPlaying: false,
            positionMs: 0,
            serverTime: Date.now(),
            stateVersion: 3,
            currentIndex: 0,
            trackId: null,
        });
        await jest.advanceTimersByTimeAsync(100);

        expect(
            mocks.listenTogetherStateStore.setSnapshot,
        ).toHaveBeenCalledTimes(3);
        expect(
            mocks.listenTogetherClusterSync.publishSnapshot,
        ).toHaveBeenCalledTimes(2);

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("serializes ready-gate completion behind a locked waiting-state capture", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        const events: string[] = [];
        let releaseCapture: () => void = () => undefined;
        const captureGate = new Promise<void>((resolve) => {
            releaseCapture = resolve;
        });
        mocks.listenTogetherStateStore.getSnapshot
            .mockImplementationOnce(async () => {
                events.push("join-capture:start");
                await captureGate;
                events.push("join-capture:end");
                return {
                    id: "group-1",
                    joinCode: "ABC123",
                    members: [],
                    playback: { queue: [], stateVersion: 1 },
                };
            })
            .mockResolvedValueOnce({
                id: "group-1",
                joinCode: "ABC123",
                members: [],
                playback: { queue: [], stateVersion: 1 },
            });
        mocks.groupManager.pause.mockImplementationOnce(() => {
            events.push("join-capture:mutation");
        });
        mocks.groupManager.handleReadyGateCompletion.mockImplementationOnce(
            () => {
                events.push("ready-gate:playing");
                return true;
            },
        );
        socket.data.groupId = "group-1";

        const lockedCapture = eventHandlers["playback"](
            { action: "pause" },
            jest.fn(),
        );
        await new Promise((resolve) => setImmediate(resolve));
        callbacks.onReadyGateCompletion("group-1", {
            currentIndex: 1,
            stateVersion: 4,
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(events).toEqual(["join-capture:start"]);
        releaseCapture();
        await lockedCapture;
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(events).toEqual([
            "join-capture:start",
            "join-capture:end",
            "join-capture:mutation",
            "ready-gate:playing",
        ]);
        socketService.shutdownListenTogetherSocket();
    });

    it("retries internal ready-gate contention and re-arms without invalidating", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService } = bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        mocks.mutationLockClient.eval
            .mockResolvedValueOnce([0, 0])
            .mockResolvedValueOnce([0, 0])
            .mockResolvedValueOnce([0, 0]);

        callbacks.onReadyGateCompletion("group-1", {
            currentIndex: 2,
            stateVersion: 7,
        });
        await jest.advanceTimersByTimeAsync(200);

        expect(
            mocks.groupManager.rearmReadyGateCompletion,
        ).toHaveBeenCalledWith("group-1", 2, 7, expect.any(Number));
        const rearmDelay =
            mocks.groupManager.rearmReadyGateCompletion.mock.calls[0][3];
        expect(rearmDelay).toBeGreaterThanOrEqual(20);
        expect(rearmDelay).toBeLessThanOrEqual(27);
        expect(mocks.groupManager.invalidate).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("abandons a late ready-gate acquisition and releases admission and the local tail", async () => {
        jest.useFakeTimers();
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService } = bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        let releaseAcquire: () => void = () => undefined;
        mocks.mutationLockClient.eval.mockImplementationOnce(
            async (script: string) => {
                if (!script.includes("acquire-lease-and-fence")) return 1;
                await new Promise<void>((resolve) => {
                    releaseAcquire = resolve;
                });
                return [1, 101];
            },
        );

        callbacks.onReadyGateCompletion("group-1", {
            currentIndex: 2,
            stateVersion: 7,
        });
        await jest.advanceTimersByTimeAsync(5_001);
        let intakeStopped = false;
        const stop = socketService.stopListenTogetherSocketIntake().then(() => {
            intakeStopped = true;
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(intakeStopped).toBe(true);
        expect(
            mocks.groupManager.handleReadyGateCompletion,
        ).not.toHaveBeenCalled();

        const acquireCall = mocks.mutationLockClient.eval.mock.calls.find(
            (call: unknown[]) =>
                String(call[0]).includes("acquire-lease-and-fence"),
        );
        releaseAcquire();
        await jest.advanceTimersByTimeAsync(1);
        await stop;
        const releaseCall = mocks.mutationLockClient.eval.mock.calls.find(
            (call: unknown[]) => String(call[0]).includes("redis.call('del'"),
        );
        expect((releaseCall as any[])?.[3]).toBe((acquireCall as any[])?.[4]);
        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("flushes queued snapshot writes before releasing the mutation lock", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        socket.data.groupId = "group-1";
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        const snapshot = {
            id: "group-1",
            members: [],
            playback: { queue: [], currentIndex: 0, isPlaying: false },
        };
        mocks.groupManager.snapshotById.mockReturnValue(snapshot);

        let releaseSetSnapshot: () => void = () => undefined;
        let setSnapshotStarted = false;
        const setSnapshotGate = new Promise<void>((resolve) => {
            releaseSetSnapshot = resolve;
        });
        mocks.listenTogetherStateStore.setSnapshot.mockImplementationOnce(
            async () => {
                setSnapshotStarted = true;
                await setSnapshotGate;
            },
        );
        mocks.groupManager.pause.mockImplementationOnce(() => {
            callbacks.onPlaybackDelta("group-1", { isPlaying: false });
        });

        const playbackAck = jest.fn();
        const playbackPromise = eventHandlers["playback"](
            { action: "pause" },
            playbackAck,
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(setSnapshotStarted).toBe(true);
        expect(
            mocks.mutationLockClient.eval.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("redis.call('del'"),
            ),
        ).toBe(false);
        expect(playbackAck).not.toHaveBeenCalled();

        releaseSetSnapshot();
        await playbackPromise;

        expect(mocks.mutationLockClient.eval).toHaveBeenCalled();
        expect(playbackAck).toHaveBeenCalledWith({ ok: true });

        socketService.shutdownListenTogetherSocket();
    });

    it("invalidates local state and returns retryable conflict after publication exhaustion", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        const snapshot = {
            id: "group-1",
            members: [],
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                stateVersion: 7,
            },
        };
        socket.data.groupId = "group-1";
        mocks.groupManager.snapshotById.mockReturnValue(snapshot);
        mocks.groupManager.pause.mockImplementationOnce(() => {
            callbacks.onPlaybackDelta("group-1", { isPlaying: false });
        });
        mocks.listenTogetherStateStore.setSnapshot.mockRejectedValue(
            new Error("redis publication down"),
        );
        const ack = jest.fn();

        await eventHandlers["playback"]({ action: "pause" }, ack);

        expect(
            mocks.listenTogetherStateStore.setSnapshot,
        ).toHaveBeenCalledTimes(2);
        expect(mocks.groupManager.invalidate).toHaveBeenCalledWith("group-1");
        expect(ack).toHaveBeenCalledWith(
            expect.objectContaining({
                code: "CONFLICT",
                transient: true,
                retryable: true,
            }),
        );
        expect(
            mocks.listenTogetherClusterSync.publishSnapshot,
        ).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
    });

    it("returns a permanent error code after an accepted snapshot write", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];
        socket.data.groupId = "group-1";
        mocks.groupManager.snapshotById.mockReturnValue({
            id: "group-1",
            members: [],
            playback: { queue: [], stateVersion: 7 },
        });
        mocks.groupManager.next.mockImplementationOnce(() => {
            callbacks.onPlaybackDelta("group-1", { currentIndex: 1 });
        });
        mocks.listenTogetherClusterSync.publishSnapshot.mockRejectedValue(
            new Error("publish failed"),
        );
        const ack = jest.fn();

        await eventHandlers["playback"]({ action: "next" }, ack);

        expect(ack).toHaveBeenCalledWith({
            error: "Group state could not be synchronized. Please refresh.",
            code: "CONFLICT",
        });
        expect(ack.mock.calls[0][0]).not.toHaveProperty("retryable");
        expect(ack.mock.calls[0][0]).not.toHaveProperty("transient");
        expect(mocks.groupManager.invalidate).toHaveBeenCalledWith("group-1");
        socketService.shutdownListenTogetherSocket();
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
        await eventHandlers["playback"](
            { action: "pause" },
            noGroupPlaybackAck,
        );
        expect(noGroupPlaybackAck).toHaveBeenCalledWith({
            error: "Not in a group",
        });

        socket.data.groupId = "group-1";

        const seekMissingAck = jest.fn();
        await eventHandlers["playback"]({ action: "seek" }, seekMissingAck);
        expect(seekMissingAck).toHaveBeenCalledWith({
            error: "positionMs required for seek",
            code: "INVALID",
        });

        const setTrackMissingAck = jest.fn();
        await eventHandlers["playback"](
            { action: "set-track" },
            setTrackMissingAck,
        );
        expect(setTrackMissingAck).toHaveBeenCalledWith({
            error: "index required for set-track",
            code: "INVALID",
        });

        const unknownPlaybackAck = jest.fn();
        await eventHandlers["playback"]({ action: "boom" }, unknownPlaybackAck);
        expect(unknownPlaybackAck).toHaveBeenCalledWith({
            error: "Unknown action: boom",
            code: "INVALID",
        });

        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const conflictSeekAck = jest.fn();
        await eventHandlers["playback"](
            { action: "seek", positionMs: 1000 },
            conflictSeekAck,
        );
        expect(conflictSeekAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Another group update is in progress. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );

        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const conflictPlaybackAck = jest.fn();
        await eventHandlers["playback"](
            { action: "play" },
            conflictPlaybackAck,
        );
        expect(conflictPlaybackAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Another group update is in progress. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );

        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const conflictNextAck = jest.fn();
        await eventHandlers["playback"]({ action: "next" }, conflictNextAck);
        expect(conflictNextAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Another group update is in progress. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );

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
            removeMissingIndexAck,
        );
        expect(removeMissingIndexAck).toHaveBeenCalledWith({
            error: "index required",
        });

        const reorderMissingAck = jest.fn();
        await eventHandlers["queue"](
            { action: "reorder", fromIndex: 1 },
            reorderMissingAck,
        );
        expect(reorderMissingAck).toHaveBeenCalledWith({
            error: "fromIndex and toIndex required",
        });

        const unknownQueueAck = jest.fn();
        await eventHandlers["queue"]({ action: "unknown" }, unknownQueueAck);
        expect(unknownQueueAck).toHaveBeenCalledWith({
            error: "Unknown action: unknown",
        });

        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const conflictQueueAck = jest.fn();
        await eventHandlers["queue"]({ action: "clear" }, conflictQueueAck);
        expect(conflictQueueAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Another group update is in progress. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );

        socket.data.groupId = null;
        await eventHandlers["ready"]({ some: "payload" });

        socket.data.groupId = "group-1";
        mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
        const readyConflictAck = jest.fn();
        await eventHandlers["ready"]({ payload: true }, readyConflictAck);
        expect(readyConflictAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Another group update is in progress. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );

        mocks.groupManager.reportReady.mockImplementationOnce(() => {
            throw new Error("ready write failed");
        });
        const readyFailureAck = jest.fn();
        await eventHandlers["ready"]({ payload: true }, readyFailureAck);
        expect(readyFailureAck).toHaveBeenCalledWith(
            expect.objectContaining({
                code: "CONFLICT",
                transient: true,
                retryable: true,
            }),
        );

        socketService.shutdownListenTogetherSocket();
    });

    it("returns retryable conflict acks for track-change playback actions", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        socket.data.groupId = "group-1";
        mocks.groupManager.next.mockImplementationOnce(() => {
            throw new mocks.MockGroupError(
                "CONFLICT",
                "Track change already in progress",
            );
        });

        const nextAck = jest.fn();
        await eventHandlers["playback"]({ action: "next" }, nextAck);
        expect(nextAck).toHaveBeenCalledWith({
            code: "CONFLICT",
            error: "Track change already in progress",
            transient: true,
            retryable: true,
            retryAfterMs: expect.any(Number),
        });

        mocks.groupManager.previous.mockImplementationOnce(() => {
            throw new mocks.MockGroupError(
                "CONFLICT",
                "Track change already in progress",
            );
        });
        const previousAck = jest.fn();
        await eventHandlers["playback"]({ action: "previous" }, previousAck);
        expect(previousAck).toHaveBeenCalledWith({
            code: "CONFLICT",
            error: "Track change already in progress",
            transient: true,
            retryable: true,
            retryAfterMs: expect.any(Number),
        });

        mocks.groupManager.setTrack.mockImplementationOnce(() => {
            throw new mocks.MockGroupError(
                "CONFLICT",
                "Track change already in progress",
            );
        });
        const setTrackAck = jest.fn();
        await eventHandlers["playback"](
            { action: "set-track", index: 1 },
            setTrackAck,
        );
        expect(setTrackAck).toHaveBeenCalledWith({
            code: "CONFLICT",
            error: "Track change already in progress",
            transient: true,
            retryable: true,
            retryAfterMs: expect.any(Number),
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
            expect.any(Error),
        );

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });

    it("re-emits current group state when the same member rejoins the active group", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);

        const initialSnapshot: {
            groupId: string;
            hostUserId: string;
            members: unknown[];
            queue: Array<{ id: string }>;
            playback: { status: string; index: number; positionMs: number };
        } = {
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [],
            playback: { status: "paused", index: 0, positionMs: 0 },
        };
        const refreshedSnapshot: typeof initialSnapshot = {
            groupId: "group-1",
            hostUserId: "user-1",
            members: [],
            queue: [{ id: "track-2" }],
            playback: { status: "playing", index: 1, positionMs: 48_000 },
        };

        mocks.joinGroupById
            .mockResolvedValueOnce(initialSnapshot as any)
            .mockResolvedValueOnce(refreshedSnapshot as any);
        mocks.groupManager.snapshot
            .mockReturnValueOnce(initialSnapshot)
            .mockReturnValueOnce(refreshedSnapshot);

        const firstJoinAck = jest.fn();
        await eventHandlers["join-group"]({ groupId: "group-1" }, firstJoinAck);
        expect(firstJoinAck).toHaveBeenCalledWith({ ok: true });
        expect(socket.emit).toHaveBeenNthCalledWith(
            1,
            "group:state",
            initialSnapshot,
        );
        expect(mocks.leaveGroup).not.toHaveBeenCalled();

        const secondJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            secondJoinAck,
        );
        expect(secondJoinAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.joinGroupById).toHaveBeenNthCalledWith(
            2,
            "user-1",
            "User One",
            "group-1",
        );
        expect(socket.emit).toHaveBeenNthCalledWith(
            2,
            "group:state",
            refreshedSnapshot,
        );
        expect(mocks.leaveGroup).not.toHaveBeenCalled();

        socketService.shutdownListenTogetherSocket();
    });

    it("undoes room attachment when the group ends during final join revalidation", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        mocks.joinGroupById.mockResolvedValueOnce({
            id: "group-1",
            joinCode: "ABC123",
            playback: { queue: [], stateVersion: 1 },
            members: [],
        } as any);
        mocks.groupManager.hasMember
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        mocks.groupManager.has.mockReturnValue(false);
        const ack = jest.fn();

        await eventHandlers["join-group"]({ groupId: "group-1" }, ack);

        expect(socket.join).toHaveBeenCalledWith("group-1");
        expect(socket.leave).toHaveBeenCalledWith("group-1");
        expect(mocks.groupManager.addSocket).not.toHaveBeenCalled();
        expect(ack).toHaveBeenCalledWith({
            error: "Group not found",
            code: "NOT_FOUND",
        });
        socketService.shutdownListenTogetherSocket();
    });

    it("leaves the room when authoritative socket registration loses membership", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        mocks.groupManager.addSocket.mockReturnValueOnce(false);
        const ack = jest.fn();

        await eventHandlers["join-group"]({ groupId: "group-1" }, ack);

        expect(socket.join).toHaveBeenCalledWith("group-1");
        expect(socket.leave).toHaveBeenCalledWith("group-1");
        expect(socket.data.groupId).toBeNull();
        expect(socket.emit).not.toHaveBeenCalledWith(
            "group:state",
            expect.anything(),
        );
        expect(ack).toHaveBeenCalledWith({
            error: "Not a member of this group",
            code: "NOT_MEMBER",
        });
        socketService.shutdownListenTogetherSocket();
    });

    it("emits and resolves availability from the post-attachment authoritative snapshot", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        const stale = {
            id: "group-1",
            joinCode: "ABC123",
            playback: { queue: [], stateVersion: 1 },
            members: [],
        };
        const authoritative = {
            ...stale,
            playback: { queue: [{ id: "new-track" }], stateVersion: 2 },
        };
        mocks.joinGroupById.mockResolvedValueOnce(stale as any);
        mocks.groupManager.snapshot.mockReturnValueOnce(authoritative);
        const ack = jest.fn();

        await eventHandlers["join-group"]({ groupId: "group-1" }, ack);

        expect(ack).toHaveBeenCalledWith({ ok: true });
        expect(socket.emit).toHaveBeenCalledWith("group:state", authoritative);
        expect(mocks.publishAvailabilityForGroup).toHaveBeenCalledWith(
            mocks.namespace,
            "group-1",
            expect.any(Function),
            authoritative,
        );
        socketService.shutdownListenTogetherSocket();
    });

    it("covers playback and queue success branches plus join-room handoff", async () => {
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers } =
            bootstrapConnectedSocket(mocks);

        mocks.configMock.allowedOrigins = ["https://example.test"];
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
        mocks.mutationLockClient.eval
            .mockResolvedValueOnce([1, 1])
            .mockResolvedValueOnce(1)
            .mockRejectedValueOnce(new Error("release failed"));
        const nextAck = jest.fn();
        await eventHandlers["playback"]({ action: "next" }, nextAck);
        expect(nextAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.applyExternalSnapshot).toHaveBeenCalled();
        expect(mocks.groupManager.next).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Failed to release group mutation lock",
            expect.objectContaining({
                groupId: "group-1",
                operationName: "playback:next",
                error: expect.any(Error),
            }),
        );

        const previousAck = jest.fn();
        await eventHandlers["playback"]({ action: "previous" }, previousAck);
        expect(previousAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.previous).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );

        const setTrackAck = jest.fn();
        await eventHandlers["playback"](
            { action: "set-track", index: 2 },
            setTrackAck,
        );
        expect(setTrackAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.setTrack).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            2,
            true,
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );

        const queueRemoveAck = jest.fn();
        await eventHandlers["queue"](
            { action: "remove", index: 0 },
            queueRemoveAck,
        );
        expect(queueRemoveAck).toHaveBeenCalledWith({ ok: true });

        const queueReorderAck = jest.fn();
        await eventHandlers["queue"](
            { action: "reorder", fromIndex: 0, toIndex: 1 },
            queueReorderAck,
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
        await eventHandlers["join-group"](
            { groupId: "group-2" },
            handoffJoinAck,
        );
        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");
        expect(handoffJoinAck).toHaveBeenCalledWith({ ok: true });

        socketService.shutdownListenTogetherSocket();
    });

    it("keeps one admitted cross-group join alive through leave and attachment", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        socket.data.groupId = "group-1";
        let releaseDeparture: () => void = () => undefined;
        let markDepartureStarted: () => void = () => undefined;
        const departureStarted = new Promise<void>((resolve) => {
            markDepartureStarted = resolve;
        });
        mocks.leaveGroup.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    markDepartureStarted();
                    releaseDeparture = () => resolve(undefined);
                }),
        );
        mocks.joinGroupById.mockResolvedValueOnce({
            id: "group-2",
            joinCode: "ABC123",
            playback: { queue: [], stateVersion: 1 },
            members: [],
        } as any);
        const ack = jest.fn();

        const join = eventHandlers["join-group"]({ groupId: "group-2" }, ack);
        await departureStarted;
        const stop = socketService.stopListenTogetherSocketIntake();
        releaseDeparture();
        await Promise.all([join, stop]);

        expect(mocks.leaveGroup).toHaveBeenCalledWith("user-1", "group-1");
        expect(mocks.joinGroupById).toHaveBeenCalledWith(
            "user-1",
            "User One",
            "group-2",
        );
        expect(socket.data.groupId).toBe("group-2");
        expect(ack).toHaveBeenCalledWith({ ok: true });
        socketService.shutdownListenTogetherSocket();
    });

    it("rejects leave admission before mutating socket membership", async () => {
        process.env = { ...originalEnv, JWT_SECRET: "test-secret" };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService, eventHandlers, socket } =
            bootstrapConnectedSocket(mocks);
        socket.data.groupId = "group-1";
        await socketService.stopListenTogetherSocketIntake();
        const ack = jest.fn();

        await eventHandlers["leave-group"](ack);

        expect(mocks.groupManager.removeSocket).not.toHaveBeenCalled();
        expect(socket.data.groupId).toBe("group-1");
        expect(ack).toHaveBeenCalledWith(
            expect.objectContaining({
                code: "CONFLICT",
                transient: true,
                retryable: true,
            }),
        );
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
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            failedJoinAck,
        );
        expect(failedJoinAck).toHaveBeenCalledWith({
            error: "Failed to join group",
        });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[ListenTogether/WS] join-group error:",
            expect.any(Error),
        );

        mocks.joinGroupById.mockRejectedValueOnce(
            new mocks.MockGroupError(
                "NOT_MEMBER",
                "Not a member of this group",
            ),
        );
        const notMemberJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            notMemberJoinAck,
        );
        expect(notMemberJoinAck).toHaveBeenCalledWith({
            error: "Not a member of this group",
            code: "NOT_MEMBER",
        });

        mocks.joinGroupById.mockRejectedValueOnce(
            new mocks.MockGroupError("NOT_FOUND", "Group not found"),
        );
        const notFoundJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            notFoundJoinAck,
        );
        expect(notFoundJoinAck).toHaveBeenCalledWith({
            error: "Group not found",
            code: "NOT_FOUND",
        });

        mocks.joinGroupById.mockRejectedValueOnce(
            new mocks.MockGroupError(
                "CONFLICT",
                "Another group update is in progress. Please retry.",
            ),
        );
        const conflictJoinAck = jest.fn();
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            conflictJoinAck,
        );
        expect(conflictJoinAck).toHaveBeenCalledWith({
            error: "Another group update is in progress. Please retry.",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: expect.any(Number),
        });

        socket.data.groupId = "group-1";
        mocks.leaveGroup.mockRejectedValueOnce(
            new mocks.MockGroupError(
                "CONFLICT",
                "Another group update is in progress. Please retry.",
            ),
        );
        const leaveAck = jest.fn();
        await eventHandlers["leave-group"](leaveAck);
        expect(leaveAck).toHaveBeenCalledWith({
            error: "Another group update is in progress. Please retry.",
            code: "CONFLICT",
            transient: true,
            retryable: true,
            retryAfterMs: expect.any(Number),
        });

        socket.data.groupId = "group-1";
        mocks.mutationLockClient.eval.mockRejectedValueOnce(
            new Error("redis down"),
        );
        const lockFailureAck = jest.fn();
        await eventHandlers["playback"]({ action: "play" }, lockFailureAck);
        expect(lockFailureAck).toHaveBeenCalledWith(
            expect.objectContaining({
                error: "Group coordination temporarily unavailable. Please retry.",
                code: "CONFLICT",
                transient: true,
                retryable: true,
                retryAfterMs: expect.any(Number),
            }),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to acquire group mutation lock",
            expect.objectContaining({
                groupId: "group-1",
                operationName: "playback:play",
                error: expect.any(Error),
            }),
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
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("reconnectSamples=1"),
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("reconnectBreaches=1"),
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
            mocks.mutationLockClient.eval.mockResolvedValueOnce([0, 0]);
            const ack = jest.fn();
            await eventHandlers["playback"]({ action: "play" }, ack);
        }

        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringMatching(
                /\[ListenTogether\/Observability\] reason=conflict .*conflictErrors=25 .*mutationLockAcquireFailures=25/,
            ),
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
        expect(mocks.groupManager.play).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );

        const seekAck = jest.fn();
        await eventHandlers["playback"](
            { action: "seek", positionMs: 1200, stateVersion: 9 },
            seekAck,
        );
        expect(seekAck).toHaveBeenCalledWith({ ok: true });
        expect(mocks.groupManager.seek).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            1200,
            9,
            expect.objectContaining({ fencingToken: expect.any(Number) }),
        );

        expect(mocks.mutationLockClient.set).not.toHaveBeenCalled();
        socketService.shutdownListenTogetherSocket();
    });

    it("logs adapter warning and applies cluster snapshots, membership, and endings", async () => {
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
            "[ListenTogether/WS] Cross-pod fanout is enabled, but authoritative session snapshots are disabled (LISTEN_TOGETHER_STATE_STORE_ENABLED=false); GroupManager state remains pod-local in-memory between mutations.",
        );

        const clusterHandler =
            mocks.listenTogetherClusterSync.start.mock.calls[0][0];
        const endedHandler =
            mocks.listenTogetherClusterSync.start.mock.calls[0][1];
        const membershipHandler =
            mocks.listenTogetherClusterSync.start.mock.calls[0][2];
        const recoveryHandler =
            mocks.listenTogetherClusterSync.start.mock.calls[0][3];
        const revocationHandler =
            mocks.listenTogetherClusterSync.start.mock.calls[0][4];
        const snapshot = { id: "group-1", playback: {}, members: [] };
        const deferredSnapshotEffect = clusterHandler(snapshot);
        expect(
            mocks.groupManager.applyExternalSnapshot,
        ).not.toHaveBeenCalledWith(snapshot);
        await deferredSnapshotEffect?.();
        const peerSocket = {
            data: { userId: "old-host", groupId: "group-1" },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        mocks.namespace.sockets.set("peer-socket", peerSocket);
        mocks.groupManager.applyCommittedMembership.mockReturnValueOnce([
            "peer-socket",
        ]);
        const deferredMembershipEffect = membershipHandler(
            "group-1",
            {
                hostUserId: "new-host",
                members: [],
            },
            { fencingToken: 17, publicationId: "membership-17" },
        );
        expect(
            mocks.groupManager.applyCommittedMembership,
        ).not.toHaveBeenCalled();
        await deferredMembershipEffect?.();
        await new Promise((resolve) => setImmediate(resolve));
        const lingeringEndedSocket = {
            data: { userId: "lingering-user", groupId: "group-1" },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        mocks.namespace.sockets.set(
            "lingering-ended-socket",
            lingeringEndedSocket,
        );
        const deferredEndedEffect = endedHandler("group-1");
        expect(mocks.groupManager.remove).not.toHaveBeenCalledWith("group-1");
        await deferredEndedEffect?.();
        const recoveredEndedSocket = {
            data: {
                userId: "recovered-ended-user",
                groupId: "group-recovered-ended",
            },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        mocks.namespace.sockets.set(
            "recovered-ended-socket",
            recoveredEndedSocket,
        );
        await recoveryHandler("group-recovered-ended", null);
        expect(mocks.groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            snapshot,
        );
        expect(
            mocks.groupManager.applyCommittedMembership,
        ).toHaveBeenCalledWith("group-1", [], "new-host", 17);
        expect(peerSocket.emit).toHaveBeenCalledWith(
            "group:membership-revoked",
            { groupId: "group-1", membershipVersion: 17 },
        );
        expect(peerSocket.leave).toHaveBeenCalledWith("group-1");
        expect(peerSocket.emit.mock.invocationCallOrder[0]).toBeLessThan(
            peerSocket.leave.mock.invocationCallOrder[0],
        );
        expect(peerSocket.data.groupId).toBeNull();
        expect(lingeringEndedSocket.emit).toHaveBeenCalledWith("group:ended", {
            reason: "Group ended",
        });
        expect(lingeringEndedSocket.emit).toHaveBeenCalledWith(
            "group:membership-revoked",
            { groupId: "group-1" },
        );
        expect(lingeringEndedSocket.leave).toHaveBeenCalledWith("group-1");
        expect(lingeringEndedSocket.data.groupId).toBeNull();
        expect(
            lingeringEndedSocket.leave.mock.invocationCallOrder[0],
        ).toBeLessThan(mocks.groupManager.remove.mock.invocationCallOrder[0]);
        expect(recoveredEndedSocket.emit).toHaveBeenCalledWith("group:ended", {
            reason: "Group ended",
        });
        expect(recoveredEndedSocket.leave).toHaveBeenCalledWith(
            "group-recovered-ended",
        );
        expect(recoveredEndedSocket.data.groupId).toBeNull();

        const remoteOnlySocket = {
            data: { userId: "deleted-user", groupId: "remote-only" },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        mocks.namespace.sockets.set("remote-only-socket", remoteOnlySocket);
        mocks.groupManager.has.mockReturnValueOnce(false);
        const deferredRevocationEffect = revocationHandler(
            {
                userId: "deleted-user",
                groupIds: ["remote-only"],
            },
            { fencingToken: 18, publicationId: "revocation-18" },
        );
        await deferredRevocationEffect?.();
        expect(remoteOnlySocket.emit).toHaveBeenCalledWith(
            "group:membership-revoked",
            { groupId: "remote-only", membershipVersion: 18 },
        );
        expect(remoteOnlySocket.leave).toHaveBeenCalledWith("remote-only");
        expect(remoteOnlySocket.data.groupId).toBeNull();
        expect(mocks.groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(mocks.groupManager.remove).toHaveBeenCalledWith(
            "group-recovered-ended",
        );
    });

    it("continues queued snapshot writes after a prior persistence failure and skips ended publish without snapshot", async () => {
        jest.useFakeTimers();
        process.env = {
            ...originalEnv,
            JWT_SECRET: "test-secret",
        };
        const mocks = setupListenTogetherSocketMocks();
        const { socketService } = bootstrapConnectedSocket(mocks);
        const callbacks = mocks.groupManager.setCallbacks.mock.calls[0][0];

        mocks.groupManager.snapshotById.mockReturnValue({
            id: "group-1",
            playback: { queue: [], currentIndex: 0, isPlaying: false },
            members: [],
        });
        mocks.listenTogetherStateStore.setSnapshot
            .mockRejectedValueOnce(new Error("persist failed"))
            .mockResolvedValueOnce(undefined);

        callbacks.onPlaybackDelta("group-1", { isPlaying: true });
        callbacks.onPlaybackDelta("group-1", { isPlaying: false });
        await jest.advanceTimersByTimeAsync(100);

        expect(
            mocks.listenTogetherStateStore.setSnapshot,
        ).toHaveBeenCalledTimes(3);
        expect(
            mocks.listenTogetherClusterSync.publishSnapshot,
        ).toHaveBeenCalledTimes(2);

        mocks.groupManager.snapshotById.mockReturnValue(undefined);
        callbacks.onGroupEnded("group-1", "ended");
        await jest.advanceTimersByTimeAsync(0);

        expect(
            mocks.listenTogetherStateStore.deleteSnapshot,
        ).toHaveBeenCalledWith("group-1", 0);
        expect(
            mocks.listenTogetherClusterSync.publishSnapshot,
        ).toHaveBeenCalledTimes(2);

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
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
        await eventHandlers["join-group"](
            { groupId: "group-1" },
            initialJoinAck,
        );
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
        mocks.groupManager.socketCount
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(1);
        await eventHandlers["disconnect"]("network");
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mocks.leaveGroup).not.toHaveBeenCalled();

        socketService.shutdownListenTogetherSocket();
        jest.useRealTimers();
    });
});
