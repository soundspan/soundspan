import type { Namespace } from "socket.io";
import { DeterministicRedisServer } from "./support/deterministicRedis";

describe("Listen Together socket mutation authority", () => {
    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadAuthority() {
        jest.resetModules();
        const server = new DeterministicRedisServer();
        const redisClient = server.createClient();
        const logger: any = { warn: jest.fn() };
        logger.child = jest.fn(() => logger);
        const groupManager = {
            applyExternalSnapshot: jest.fn(),
            invalidate: jest.fn(),
            remove: jest.fn(),
        };
        const releaseLocalGroupMutationState = jest.fn();
        const enqueueGroupEndedBroadcast = jest.fn(async () => undefined);

        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => redisClient),
        }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    mutationLockEnabled: true,
                    stateStoreEnabled: true,
                    stateSyncEnabled: true,
                    stateStoreKeyPrefix: "listen-together:state",
                    stateStoreTtlSeconds: 21_600,
                    publicationDeadlineMs: 1_000,
                    mutationLockPrefix: "listen-together:mutation-lock",
                },
            },
        }));
        jest.doMock("../listenTogetherManager", () => ({
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            GroupError: require("../listenTogetherGroupError").GroupError,
            groupManager,
        }));
        jest.doMock("../listenTogetherMutationLock", () => ({
            releaseLocalGroupMutationState,
        }));
        jest.doMock("../listenTogetherCallbacks", () => ({
            enqueueGroupEndedBroadcast,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const authority = require("../listenTogetherSocketMutationAuthority");
        return {
            authority,
            enqueueGroupEndedBroadcast,
            groupManager,
            logger,
            releaseLocalGroupMutationState,
            server,
        };
    }

    function attachedNamespace() {
        const socket = {
            data: { userId: "user-1", groupId: "group-1" },
            emit: jest.fn(),
            leave: jest.fn(async () => undefined),
        };
        const namespace = {
            sockets: new Map([["socket-1", socket]]),
        } as unknown as Namespace;
        return { namespace, socket };
    }

    function snapshotWith(nested: Record<string, unknown>) {
        return {
            id: "group-1",
            name: "Group One",
            joinCode: "ABC123",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "host-1",
            membershipVersion: 1,
            syncState: "paused",
            readyDeadlineMs: null,
            readyUserIds: [],
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                serverTime: 1,
                stateVersion: 1,
                trackId: null,
            },
            members: [],
            ...nested,
        };
    }

    it("keeps malformed Redis JSON transient without ending the group", async () => {
        const loaded = loadAuthority();
        const { namespace, socket } = attachedNamespace();
        loaded.server.write("listen-together:state:group-1", "{");

        await expect(
            loaded.authority.hydrateSocketMutationAuthority(
                "group-1",
                namespace,
                jest.fn(),
            ),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });

        expect(loaded.groupManager.invalidate).not.toHaveBeenCalled();
        expect(loaded.enqueueGroupEndedBroadcast).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.leave).not.toHaveBeenCalled();
        expect(socket.data.groupId).toBe("group-1");
    });

    it.each([
        ["null member", { playback: {}, members: [null] }],
        ["array playback", { playback: [], members: [] }],
    ])(
        "keeps nested snapshot corruption transient during socket hydration: %s",
        async (_name, nested) => {
            const loaded = loadAuthority();
            const { namespace, socket } = attachedNamespace();
            loaded.server.write(
                "listen-together:state:group-1",
                JSON.stringify(snapshotWith(nested)),
            );

            await expect(
                loaded.authority.hydrateSocketMutationAuthority(
                    "group-1",
                    namespace,
                    jest.fn(),
                ),
            ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });

            expect(
                loaded.groupManager.applyExternalSnapshot,
            ).not.toHaveBeenCalled();
            expect(loaded.groupManager.invalidate).not.toHaveBeenCalled();
            expect(loaded.enqueueGroupEndedBroadcast).not.toHaveBeenCalled();
            expect(socket.leave).not.toHaveBeenCalled();
            expect(socket.data.groupId).toBe("group-1");
        },
    );

    it("ends a genuine key miss even without local manager state", async () => {
        const loaded = loadAuthority();
        const { namespace, socket } = attachedNamespace();
        const beforeRevoke = jest.fn();

        await expect(
            loaded.authority.hydrateSocketMutationAuthority(
                "group-1",
                namespace,
                beforeRevoke,
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });

        expect(loaded.groupManager.invalidate).toHaveBeenCalledWith("group-1");
        expect(loaded.releaseLocalGroupMutationState).toHaveBeenCalledWith(
            "group-1",
        );
        expect(socket.emit).toHaveBeenCalledWith("group:ended", {
            reason: "Group ended",
        });
        expect(socket.emit).toHaveBeenCalledWith("group:membership-revoked", {
            groupId: "group-1",
        });
        expect(socket.leave).toHaveBeenCalledWith("group-1");
        expect(socket.data.groupId).toBeNull();
        expect(loaded.enqueueGroupEndedBroadcast).toHaveBeenCalledWith(
            "group-1",
            "Group ended",
        );
    });
});
