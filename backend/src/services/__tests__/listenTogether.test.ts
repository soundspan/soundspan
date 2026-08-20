import {
    groupManager as runtimeGroupManager,
    type ManagerCallbacks as RuntimeManagerCallbacks,
    type SyncQueueItem as RuntimeSyncQueueItem,
} from "../listenTogetherManager";

describe("listenTogether service", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadService() {
        process.env = {
            ...originalEnv,
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
        };

        const prisma: any = {
            $transaction: jest.fn(),
            syncGroup: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
                findMany: jest.fn(),
                count: jest.fn(),
                update: jest.fn(),
            },
            syncGroupMember: {
                findFirst: jest.fn(),
                findUnique: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                upsert: jest.fn(),
                updateMany: jest.fn(),
            },
            track: {
                findMany: jest.fn(),
            },
            user: {
                findUnique: jest.fn(),
            },
        };
        prisma.$transaction.mockImplementation(async (input: any) =>
            typeof input === "function" ? input(prisma) : undefined,
        );

        class MockGroupError extends Error {
            code: string;
            constructor(code: string, message: string) {
                super(message);
                this.code = code;
            }
        }

        const groupState = {
            id: "group-1",
            members: new Map([["host-1", { userId: "host-1" }]]),
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                lastPositionUpdate: Date.now(),
                stateVersion: 0,
            },
            hostUserId: "host-1",
            playbackAuthoritative: true,
        };

        const groupManager: any = {
            create: jest.fn(() => groupState),
            addMember: jest.fn(() => ({
                id: "group-1",
                playback: {},
                members: [],
            })),
            has: jest.fn(() => false),
            get: jest.fn(() => groupState),
            hydrate: jest.fn(),
            applyExternalSnapshot: jest.fn(),
            applyCommittedMembership: jest.fn(() => []),
            snapshot: jest.fn(() => ({
                id: "group-1",
                playback: {},
                members: [],
            })),
            snapshotById: jest.fn((groupId: string) => ({
                id: groupId,
                hostUserId: groupState.hostUserId,
                playback: {},
                members: [],
            })),
            snapshotForPublication: jest.fn((groupId: string) =>
                groupManager.snapshotById(groupId),
            ),
            removeMember: jest.fn(() => ({ ended: false })),
            remove: jest.fn(),
            endGroup: jest.fn(),
            forceEnd: jest.fn(),
            dirtyGroups: jest.fn(() => []),
            markClean: jest.fn(),
            allGroupIds: jest.fn(() => []),
        };

        const listenTogetherStateStore: any = {
            getSnapshot: jest.fn(async (): Promise<any> => null),
            setSnapshot: jest.fn(async (..._args: any[]) => undefined),
            deleteSnapshot: jest.fn(async (..._args: any[]) => undefined),
        };
        const listenTogetherClusterSync: any = {
            publishSnapshot: jest.fn(async (..._args: any[]) => undefined),
            publishMembership: jest.fn(async (..._args: any[]) => undefined),
            publishEnded: jest.fn(async (..._args: any[]) => undefined),
        };

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        jest.doMock("crypto", () => ({
            __esModule: true,
            randomUUID: () => "test-lock-node",
            default: {
                randomInt: () => 0,
            },
        }));
        jest.doMock("../../utils/db", () => ({
            prisma,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    mutationLockEnabled: false,
                    mutationLockTtlMs: 3000,
                    mutationLockPrefix: "listen-together:mutation-lock",
                },
            },
        }));
        jest.doMock("../listenTogetherManager", () => ({
            groupManager,
            GroupError: MockGroupError,
            MAX_QUEUE_SIZE: 500,
        }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore,
        }));
        jest.doMock("../listenTogetherClusterSync", () => ({
            listenTogetherClusterSync,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const listenTogether = require("../listenTogether");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const listenTogetherCallbacks = require("../listenTogetherCallbacks");

        return {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
            listenTogetherStateStore,
            listenTogetherClusterSync,
            MockGroupError,
            logger,
        };
    }

    it("creates a group with validated local tracks and persists snapshot", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        prisma.track.findMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track 1",
                duration: 120,
                filePath: "/music/t1.mp3",
                loudnessLufs: -17.2,
                truePeakDb: -1.1,
                album: {
                    id: "a1",
                    title: "Album 1",
                    coverUrl: "cover.jpg",
                    albumLoudnessLufs: -18.1,
                    albumTruePeakDb: -0.7,
                    artist: { id: "ar1", name: "Artist 1" },
                },
            },
            {
                id: "t2",
                title: "Track 2",
                duration: 125,
                filePath: "/music/t2.mp3",
                loudnessLufs: null,
                truePeakDb: null,
                album: {
                    id: "a2",
                    title: "Album 2",
                    coverUrl: null,
                    albumLoudnessLufs: null,
                    albumTruePeakDb: null,
                    artist: { id: "ar2", name: "Artist 2" },
                },
            },
        ]);

        const tx = {
            syncGroup: {
                create: jest.fn(async () => ({
                    id: "group-1",
                    name: "Host's Group",
                    joinCode: "AAAAAA",
                })),
            },
            syncGroupMember: {
                create: jest.fn(async () => ({})),
            },
        };
        prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));

        await expect(
            listenTogether.createGroup("host-1", "Host", {
                queueTrackIds: ["t1", "t2", "missing"],
                currentTrackId: "t1",
                isPlaying: true,
                currentTimeMs: 1000,
            }),
        ).resolves.toEqual({ id: "group-1", playback: {}, members: [] });

        expect(groupManager.create).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                hostUserId: "host-1",
                queue: [
                    expect.objectContaining({
                        id: "t1",
                        title: "Track 1",
                        loudnessLufs: -17.2,
                        truePeakDb: -1.1,
                        album: expect.objectContaining({
                            albumLoudnessLufs: -18.1,
                            albumTruePeakDb: -0.7,
                        }),
                    }),
                    expect.objectContaining({
                        id: "t2",
                        loudnessLufs: null,
                        truePeakDb: null,
                        album: expect.objectContaining({
                            albumLoudnessLufs: null,
                            albumTruePeakDb: null,
                        }),
                    }),
                ],
                isPlaying: true,
            }),
        );
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { id: "group-1", playback: {}, members: [] },
        );
    });

    it("creates a group when options are omitted", async () => {
        const { listenTogether, prisma } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "host-2",
            username: "host-two",
            displayName: null,
        });
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        prisma.track.findMany.mockResolvedValueOnce([]);
        prisma.$transaction.mockImplementationOnce(async (fn: any) =>
            fn({
                syncGroup: {
                    create: jest.fn(async () => ({
                        id: "group-no-options",
                        name: "host-two's Group",
                        joinCode: "AAAAAA",
                    })),
                },
                syncGroupMember: {
                    create: jest.fn(async () => ({})),
                },
            }),
        );

        await expect(
            listenTogether.createGroup("host-2", "host-two"),
        ).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [],
        });
    });

    it("prefers displayName for default group naming and member labels", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "host-1",
            username: "host-user",
            displayName: "DJ Host",
        });
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        prisma.track.findMany.mockResolvedValueOnce([]);

        const tx = {
            syncGroup: {
                create: jest.fn(async () => ({
                    id: "group-display",
                    name: "DJ Host's Group",
                    joinCode: "AAAAAA",
                })),
            },
            syncGroupMember: {
                create: jest.fn(async () => ({})),
            },
        };
        prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));

        await listenTogether.createGroup("host-1", "host-user", {});

        expect(tx.syncGroup.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "DJ Host's Group",
                }),
            }),
        );
        expect(groupManager.create).toHaveBeenCalledWith(
            "group-display",
            expect.objectContaining({
                hostUsername: "DJ Host",
            }),
        );

        prisma.syncGroup.findFirst.mockResolvedValueOnce({
            id: "group-display",
        });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroupMember.upsert.mockResolvedValueOnce({});
        prisma.syncGroup.findUnique.mockResolvedValueOnce({ isActive: true });
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "guest-1",
            username: "guest-user",
            displayName: "Guest Display",
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.addMember.mockReturnValueOnce({
            id: "group-display",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        await listenTogether.joinGroup("guest-1", "guest-user", "AAAAAA");

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenLastCalledWith(
            "group-display",
            expect.objectContaining({
                members: [
                    expect.objectContaining({
                        userId: "guest-1",
                        username: "Guest Display",
                    }),
                ],
            }),
        );
    });

    it("joins a group by code and rehydrates from state store when missing in memory", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null); // maybeLeaveExisting
        prisma.syncGroupMember.upsert.mockResolvedValueOnce({});
        prisma.syncGroup.findUnique.mockResolvedValueOnce({ isActive: true });
        groupManager.has.mockReturnValue(false);
        (
            listenTogetherStateStore.getSnapshot as jest.Mock
        ).mockResolvedValueOnce({
            id: "group-1",
            playback: {},
            members: [],
        });
        (groupManager.addMember as jest.Mock).mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "aaaaaa"),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "group-1",
                members: [
                    expect.objectContaining({
                        userId: "guest-1",
                        username: "Guest",
                    }),
                ],
            }),
        );

        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "group-1",
                members: [expect.objectContaining({ userId: "guest-1" })],
            }),
        );
        expect(prisma.syncGroupMember.upsert).toHaveBeenCalled();
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                members: [expect.objectContaining({ userId: "guest-1" })],
            }),
        );
    });

    it("rejects invalid join code format", async () => {
        const { listenTogether, MockGroupError } = loadService();

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "bad"),
        ).rejects.toBeInstanceOf(MockGroupError);
    });

    it("returns active group count and current user group snapshot", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.count.mockResolvedValueOnce(3);
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
        });
        groupManager.has.mockReturnValue(true);
        (groupManager.snapshotById as jest.Mock).mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await expect(listenTogether.getActiveGroupCount()).resolves.toBe(3);
        await expect(listenTogether.getMyGroup("u1")).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });
    });

    it("fails group creation when join code collisions exceed max attempts", async () => {
        const { listenTogether, prisma } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValue({ id: "already-exists" });

        await expect(
            listenTogether.createGroup("host-1", "Host", {}),
        ).rejects.toThrow("Failed to generate a unique join code");
    });

    it("rejects join when join code resolves to no active group", async () => {
        const { listenTogether, prisma, MockGroupError } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce(null);

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "AAAAAA"),
        ).rejects.toBeInstanceOf(MockGroupError);
    });

    it("auto-leaves a different active group before joining a new group", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "new-group" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "old-group",
        });
        prisma.syncGroup.findUnique
            .mockResolvedValueOnce({ isActive: false })
            .mockResolvedValueOnce({ isActive: true });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.addMember.mockReturnValueOnce({
            id: "new-group",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "AAAAAA"),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "new-group",
                members: [expect.objectContaining({ userId: "guest-1" })],
            }),
        );

        expect(prisma.syncGroupMember.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    syncGroupId: "old-group",
                    userId: "guest-1",
                }),
            }),
        );
    });

    it("enforces persisted membership on joinGroupById", async () => {
        const { listenTogether, prisma, groupManager, MockGroupError } =
            loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);

        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1"),
        ).rejects.toBeInstanceOf(MockGroupError);

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "u1",
            syncGroup: { hostUserId: "host-1" },
        });
        groupManager.has.mockReturnValueOnce(true);
        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1"),
        ).resolves.toEqual(expect.objectContaining({ id: "group-1" }));
    });

    it("adds a missing in-memory member during joinGroupById without republishing", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        const group = {
            id: "group-1",
            members: new Map(),
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                lastPositionUpdate: Date.now(),
                stateVersion: 1,
            },
            hostUserId: "host-1",
        };

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "u1",
            syncGroup: { hostUserId: "host-1" },
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.get.mockReturnValueOnce(group);
        groupManager.snapshot.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1"),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "group-1",
                members: [expect.objectContaining({ userId: "u1" })],
            }),
        );

        expect(groupManager.addMember).not.toHaveBeenCalled();
        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                hostUserId: "host-1",
                members: [expect.objectContaining({ userId: "u1" })],
            }),
        );
        expect(listenTogetherStateStore.setSnapshot).not.toHaveBeenCalled();
    });

    it("restores persisted host identity when joinGroupById re-adds the host", async () => {
        const { listenTogether, prisma, groupManager } = loadService();
        const group = {
            id: "group-1",
            members: new Map([
                ["transient-host", { userId: "transient-host", isHost: true }],
            ]),
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                lastPositionUpdate: Date.now(),
                stateVersion: 1,
            },
            hostUserId: "transient-host",
        };
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "persisted-host",
            syncGroup: { hostUserId: "persisted-host" },
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.get.mockReturnValueOnce(group);

        await listenTogether.joinGroupById(
            "persisted-host",
            "Persisted Host",
            "group-1",
        );

        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                hostUserId: "persisted-host",
                members: expect.arrayContaining([
                    expect.objectContaining({
                        userId: "persisted-host",
                        isHost: true,
                    }),
                ]),
            }),
        );
    });

    it("handles leaveGroup end/disband and host transfer branches", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        groupManager.has.mockReturnValue(true);
        groupManager.removeMember.mockReturnValueOnce({ ended: true });
        prisma.$transaction.mockResolvedValueOnce({ status: "ended" });

        await expect(
            listenTogether.leaveGroup("u1", "group-1"),
        ).resolves.toEqual({ ended: true });
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1",
        );

        groupManager.removeMember.mockReturnValueOnce({
            ended: false,
            newHostUserId: "u2",
            newHostUsername: "User Two",
        });
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "u2",
            memberships: [
                {
                    userId: "u2",
                    username: "User Two",
                    isHost: true,
                    joinedAt: new Date("2026-02-16T00:00:00.000Z"),
                },
            ],
            newHostUserId: "u2",
            newHostUsername: "User Two",
        });
        groupManager.snapshotById.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u2" }],
        });

        await expect(
            listenTogether.leaveGroup("u1", "group-1"),
        ).resolves.toEqual({
            ended: false,
            newHostUserId: "u2",
            newHostUsername: "User Two",
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                hostUserId: "u2",
                members: [
                    expect.objectContaining({
                        userId: "u2",
                        isHost: true,
                    }),
                ],
            }),
        );
    });

    it("handles leaveGroup when group is not loaded in memory", async () => {
        const { listenTogether, groupManager } = loadService();

        groupManager.has.mockReturnValue(false);
        groupManager.snapshotById.mockReturnValueOnce(null);

        await expect(
            listenTogether.leaveGroup("u1", "group-missing"),
        ).resolves.toEqual({
            ended: true,
        });
        expect(groupManager.removeMember).not.toHaveBeenCalled();
    });

    it("hydrates and publishes the committed successor from a non-owning pod", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadService();
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        const remainingMemberships = [
            {
                userId: "successor",
                username: "Alpha Successor",
                joinedAt,
                isHost: true,
            },
        ];
        const tx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    hostUserId: "departed-host",
                    isActive: true,
                })),
                update: jest.fn(async () => undefined),
            },
            syncGroupMember: {
                updateMany: jest.fn(async () => ({ count: 1 })),
                findMany: jest.fn(async () => [
                    {
                        userId: "successor",
                        joinedAt,
                        user: {
                            username: "successor",
                            displayName: "Alpha Successor",
                        },
                    },
                ]),
            },
        };
        prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));
        groupManager.has.mockReturnValueOnce(false).mockReturnValueOnce(true);
        const capturedSnapshot = {
            id: "group-1",
            name: "Remote Group",
            joinCode: "REMOTE",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "departed-host",
            syncState: "playing",
            playback: {
                queue: [
                    {
                        id: "track-live",
                        title: "Live Track",
                        duration: 180,
                        artist: { id: "artist-live", name: "Live Artist" },
                        album: {
                            id: "album-live",
                            title: "Live Album",
                            coverArt: null,
                        },
                    },
                ],
                currentIndex: 0,
                isPlaying: true,
                positionMs: 42_000,
                serverTime: 1_755_691_200_000,
                stateVersion: 9,
                trackId: "track-live",
            },
            members: [
                {
                    userId: "departed-host",
                    username: "Departed Host",
                    isHost: true,
                    joinedAt: joinedAt.toISOString(),
                    isConnected: true,
                },
                {
                    userId: "successor",
                    username: "Alpha Successor",
                    isHost: false,
                    joinedAt: joinedAt.toISOString(),
                    isConnected: true,
                },
            ],
        };
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(
            capturedSnapshot,
        );

        await expect(
            listenTogether.leaveGroup("departed-host", "group-1"),
        ).resolves.toEqual({
            ended: false,
            newHostUserId: "successor",
            newHostUsername: "Alpha Successor",
        });

        expect(groupManager.removeMember).not.toHaveBeenCalled();
        expect(
            listenTogetherStateStore.getSnapshot.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
        expect(groupManager.hydrate).not.toHaveBeenCalled();
        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                hostUserId: "successor",
                syncState: "playing",
                playback: capturedSnapshot.playback,
                members: [
                    expect.objectContaining({
                        userId: "successor",
                        isHost: true,
                    }),
                ],
            }),
        );
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledTimes(1);
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                hostUserId: "successor",
                syncState: "playing",
                playback: capturedSnapshot.playback,
                members: [
                    expect.objectContaining({
                        userId: "successor",
                        isHost: true,
                    }),
                ],
            }),
        );
        expect(listenTogetherClusterSync.publishSnapshot).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                syncState: "playing",
                playback: capturedSnapshot.playback,
            }),
        );
    });

    it("publishes only membership when the authoritative snapshot was evicted", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadService();
        const emitMemberLeft = jest.fn();
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberPresence: jest.fn(),
            emitMemberLeft,
            revokeSockets: jest.fn(),
        });
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "host-1",
            memberships: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt,
                },
            ],
        });
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(null);
        groupManager.snapshotById.mockReturnValueOnce(undefined);

        await expect(
            listenTogether.leaveGroup("guest-1", "group-1"),
        ).resolves.toEqual({ ended: false });

        expect(emitMemberLeft).toHaveBeenCalledWith("group-1", {
            userId: "guest-1",
            username: "guest-1",
        });
        expect(listenTogetherStateStore.setSnapshot).not.toHaveBeenCalled();
        expect(
            listenTogetherClusterSync.publishSnapshot,
        ).not.toHaveBeenCalled();
        expect(
            listenTogetherClusterSync.publishMembership,
        ).toHaveBeenCalledWith("group-1", {
            hostUserId: "host-1",
            members: [
                expect.objectContaining({
                    userId: "host-1",
                    isHost: true,
                }),
            ],
        });
        expect(prisma.syncGroup.findUnique).not.toHaveBeenCalled();
    });

    it("removes a departed two-tab member and revokes the remaining tab through leaveGroup", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        const members = new Map([
            [
                "host-1",
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt,
                    socketIds: new Set(["host-tab"]),
                },
            ],
            [
                "guest-1",
                {
                    userId: "guest-1",
                    username: "Guest",
                    isHost: false,
                    joinedAt,
                    socketIds: new Set(["guest-tab-b"]),
                },
            ],
        ]);
        const capturedSnapshot = {
            id: "group-1",
            name: "Two Tab Group",
            joinCode: "TWOTAB",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "host-1",
            syncState: "paused",
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                serverTime: 1,
                stateVersion: 1,
                trackId: null,
            },
            members: Array.from(members.values()).map((member) => ({
                userId: member.userId,
                username: member.username,
                isHost: member.isHost,
                joinedAt: member.joinedAt.toISOString(),
                isConnected: member.socketIds.size > 0,
            })),
        };
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(
            capturedSnapshot,
        );
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "host-1",
            memberships: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt,
                },
            ],
        });
        groupManager.applyCommittedMembership.mockImplementation(
            (_groupId: string, committedMembers: any[]) => {
                const committedIds = new Set(
                    committedMembers.map((member) => member.userId),
                );
                const revoked = Array.from(members.values())
                    .filter((member) => !committedIds.has(member.userId))
                    .flatMap((member) => Array.from(member.socketIds));
                for (const userId of Array.from(members.keys())) {
                    if (!committedIds.has(userId)) members.delete(userId);
                }
                return revoked;
            },
        );
        const guestTabBEvents: string[] = [];
        const revokedSockets: string[] = [];
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberPresence: jest.fn(),
            emitMemberLeft: jest.fn((_groupId: string, member: any) => {
                if (member.userId === "guest-1") {
                    guestTabBEvents.push("group:member-left");
                }
            }),
            revokeSockets: jest.fn((_groupId: string, socketIds: string[]) => {
                revokedSockets.push(...socketIds);
            }),
        });

        await listenTogether.leaveGroup("guest-1", "group-1");

        expect(members.has("guest-1")).toBe(false);
        expect(groupManager.applyCommittedMembership).toHaveBeenCalledWith(
            "group-1",
            [expect.objectContaining({ userId: "host-1" })],
            "host-1",
        );
        expect(guestTabBEvents).toEqual(["group:member-left"]);
        expect(revokedSockets).toEqual(["guest-tab-b"]);
    });

    it("revokes a departed member when leaveGroup has no playback snapshot", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
        } = loadService();
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        groupManager.has.mockReturnValue(true);
        groupManager.snapshotForPublication.mockReturnValue(null);
        groupManager.applyCommittedMembership.mockReturnValue(["guest-tab-b"]);
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "host-1",
            memberships: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt,
                },
            ],
        });
        const revokeSockets = jest.fn();
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberPresence: jest.fn(),
            emitMemberLeft: jest.fn(),
            revokeSockets,
        });

        await listenTogether.leaveGroup("guest-1", "group-1");

        expect(groupManager.applyCommittedMembership).toHaveBeenCalledWith(
            "group-1",
            [expect.objectContaining({ userId: "host-1" })],
            "host-1",
        );
        expect(revokeSockets).toHaveBeenCalledWith("group-1", ["guest-tab-b"]);
    });

    it("emits one joined event for a first join and none for its socket reconnect", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            listenTogetherStateStore,
        } = loadService();
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        const baseSnapshot = {
            id: "group-1",
            name: "Join Group",
            joinCode: "JOIN01",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "host-1",
            syncState: "paused",
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                serverTime: 1,
                stateVersion: 1,
                trackId: null,
            },
            members: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt: joinedAt.toISOString(),
                    isConnected: true,
                },
            ],
        };
        const joinedSnapshot = {
            ...baseSnapshot,
            members: [
                ...baseSnapshot.members,
                {
                    userId: "guest-1",
                    username: "Guest",
                    isHost: false,
                    joinedAt: joinedAt.toISOString(),
                    isConnected: false,
                },
            ],
        };
        listenTogetherStateStore.getSnapshot
            .mockResolvedValueOnce(baseSnapshot)
            .mockResolvedValueOnce(joinedSnapshot);
        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                syncGroupId: "group-1",
                userId: "guest-1",
                joinedAt,
                syncGroup: { hostUserId: "host-1" },
            });
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            isActive: true,
            hostUserId: "host-1",
        });
        prisma.syncGroupMember.findUnique.mockResolvedValueOnce(null);
        prisma.syncGroupMember.findMany.mockResolvedValueOnce([
            {
                userId: "host-1",
                joinedAt,
                user: { username: "Host", displayName: null },
            },
            {
                userId: "guest-1",
                joinedAt,
                user: { username: "Guest", displayName: null },
            },
        ]);
        const emitMemberJoined = jest.fn();
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined,
            emitMemberLeft: jest.fn(),
            emitMemberPresence: jest.fn(),
            revokeSockets: jest.fn(),
        });

        await listenTogether.joinGroup("guest-1", "Guest", "JOIN01");
        await listenTogether.joinGroupById("guest-1", "Guest", "group-1");

        expect(emitMemberJoined).toHaveBeenCalledTimes(1);
        expect(emitMemberJoined).toHaveBeenCalledWith("group-1", {
            userId: "guest-1",
            username: "Guest",
        });
    });

    it("publishes only an ended event when the snapshot was evicted", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadService();
        const emitEnded = jest.fn();
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded,
            emitMemberJoined: jest.fn(),
            emitMemberPresence: jest.fn(),
            emitMemberLeft: jest.fn(),
            revokeSockets: jest.fn(),
        });
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(null);
        groupManager.snapshotById.mockReturnValueOnce(undefined);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            hostUserId: "host-1",
            isActive: true,
        });
        prisma.$transaction.mockResolvedValueOnce(undefined);

        await listenTogether.endGroup("host-1", "group-1");

        expect(listenTogetherStateStore.setSnapshot).not.toHaveBeenCalled();
        expect(
            listenTogetherClusterSync.publishSnapshot,
        ).not.toHaveBeenCalled();
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1",
        );
        expect(listenTogetherClusterSync.publishEnded).toHaveBeenCalledWith(
            "group-1",
        );
        expect(emitEnded).toHaveBeenCalledWith(
            "group-1",
            "Host ended the group",
        );
    });

    it("orders a delayed queued join publication before the locked departure", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        const baseSnapshot = {
            id: "group-1",
            name: "Ordered Group",
            joinCode: "ORDER1",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "host-1",
            syncState: "playing",
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: true,
                positionMs: 1_000,
                serverTime: 2_000,
                stateVersion: 3,
                trackId: null,
            },
            members: [],
        };
        const staleJoinSnapshot = {
            ...baseSnapshot,
            members: [
                {
                    userId: "departing-user",
                    username: "Departing User",
                    isHost: false,
                    joinedAt: joinedAt.toISOString(),
                    isConnected: false,
                },
            ],
        };
        let releaseJoinWrite: () => void = () => undefined;
        let markJoinWriteStarted: () => void = () => undefined;
        const joinWriteStarted = new Promise<void>((resolve) => {
            markJoinWriteStarted = resolve;
        });
        const joinWriteGate = new Promise<void>((resolve) => {
            releaseJoinWrite = resolve;
        });
        const publishedSnapshots: unknown[] = [];
        listenTogetherStateStore.setSnapshot
            .mockImplementationOnce(
                async (_groupId: string, snapshot: unknown) => {
                    markJoinWriteStarted();
                    await joinWriteGate;
                    publishedSnapshots.push(snapshot);
                },
            )
            .mockImplementationOnce(
                async (_groupId: string, snapshot: unknown) => {
                    publishedSnapshots.push(snapshot);
                },
            );
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(
            baseSnapshot,
        );
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "host-1",
            memberships: [],
        });
        groupManager.snapshotById.mockReturnValue(undefined);

        const queuedJoin =
            listenTogetherCallbacks.enqueueGroupSnapshotPublication(
                "group-1",
                staleJoinSnapshot,
            );
        await joinWriteStarted;
        const departure = listenTogether.leaveGroup(
            "departing-user",
            "group-1",
        );
        await Promise.resolve();
        releaseJoinWrite();
        await Promise.all([queuedJoin, departure]);

        expect(publishedSnapshots).toHaveLength(2);
        expect(publishedSnapshots.at(-1)).toEqual(
            expect.objectContaining({ members: [] }),
        );
    });

    it("retries publication after a committed departure when the first publish fails", async () => {
        const {
            listenTogether,
            listenTogetherCallbacks,
            prisma,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadService();
        const emitSnapshot = jest.fn();
        const emitMemberLeft = jest.fn();
        listenTogetherCallbacks.configureGroupPublicationBroadcaster({
            emitSnapshot,
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberPresence: jest.fn(),
            emitMemberLeft,
            revokeSockets: jest.fn(),
        });
        const joinedAt = new Date("2026-08-20T12:00:00.000Z");
        const capturedSnapshot = {
            id: "group-1",
            name: "Retry Group",
            joinCode: "RETRY1",
            groupType: "host-follower",
            visibility: "private",
            isActive: true,
            hostUserId: "host-1",
            syncState: "paused",
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
        };
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(
            capturedSnapshot,
        );
        prisma.$transaction.mockResolvedValueOnce({
            status: "active",
            hostUserId: "host-1",
            memberships: [
                {
                    userId: "host-1",
                    username: "Host",
                    isHost: true,
                    joinedAt,
                },
            ],
        });
        listenTogetherClusterSync.publishSnapshot
            .mockRejectedValueOnce(new Error("transient publish failure"))
            .mockResolvedValueOnce(undefined);

        await listenTogether.leaveGroup("guest-1", "group-1");

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(listenTogetherClusterSync.publishSnapshot).toHaveBeenCalledTimes(
            2,
        );
        expect(
            listenTogetherClusterSync.publishMembership,
        ).toHaveBeenCalledTimes(1);
        expect(emitMemberLeft).toHaveBeenCalledTimes(1);
        expect(emitSnapshot).toHaveBeenCalledTimes(1);
    });

    it("cleans stale memory and deletes snapshots for an already inactive group", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadService();
        const tx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    hostUserId: "host-1",
                    isActive: false,
                })),
            },
            syncGroupMember: {
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
        };
        prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));
        groupManager.has.mockReturnValue(true);

        await expect(
            listenTogether.leaveGroup("host-1", "group-1"),
        ).resolves.toEqual({ ended: true });

        expect(groupManager.removeMember).not.toHaveBeenCalled();
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1",
        );
        expect(listenTogetherStateStore.setSnapshot).not.toHaveBeenCalled();
        expect(listenTogetherClusterSync.publishEnded).toHaveBeenCalledWith(
            "group-1",
        );
    });

    it("revalidates a join after a final departure commits first", async () => {
        const { listenTogether, prisma, groupManager, MockGroupError } =
            loadService();
        let groupIsActive = true;
        let releaseDeparture: () => void = () => undefined;
        let markDepartureStarted: () => void = () => undefined;
        const departureStarted = new Promise<void>((resolve) => {
            markDepartureStarted = resolve;
        });
        const departureGate = new Promise<void>((resolve) => {
            releaseDeparture = resolve;
        });
        const departureTx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    hostUserId: "host-1",
                    isActive: true,
                })),
                update: jest.fn(async () => {
                    groupIsActive = false;
                }),
            },
            syncGroupMember: {
                updateMany: jest.fn(async () => {
                    markDepartureStarted();
                    await departureGate;
                    return { count: 1 };
                }),
                findMany: jest.fn(async () => []),
            },
        };
        const joinUpsert = jest.fn(async () => undefined);
        const joinTx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    isActive: groupIsActive,
                })),
            },
            syncGroupMember: {
                findUnique: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
                upsert: joinUpsert,
            },
        };
        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.$transaction
            .mockImplementationOnce(async (fn: any) => fn(departureTx))
            .mockImplementationOnce(async (fn: any) => fn(joinTx));
        groupManager.has.mockReturnValue(true);

        const leavePromise = listenTogether.leaveGroup("host-1", "group-1");
        await departureStarted;
        const joinPromise = listenTogether.joinGroup(
            "joining-user",
            "Joining User",
            "AAAAAA",
        );
        await new Promise((resolve) => setImmediate(resolve));
        releaseDeparture();
        await leavePromise;

        await expect(joinPromise).rejects.toBeInstanceOf(MockGroupError);
        expect(joinUpsert).not.toHaveBeenCalled();
    });

    it("serializes a reconnect behind an in-flight host transfer", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();
        const joinedAt = new Date("2026-02-16T00:00:00.000Z");
        const members = new Map([
            [
                "departing-host",
                {
                    userId: "departing-host",
                    username: "Departing Host",
                    isHost: true,
                    joinedAt,
                },
            ],
            [
                "successor",
                {
                    userId: "successor",
                    username: "Alpha Successor",
                    isHost: false,
                    joinedAt,
                },
            ],
            [
                "rejoining-member",
                {
                    userId: "rejoining-member",
                    username: "Rejoining Member",
                    isHost: false,
                    joinedAt,
                },
            ],
        ]);
        const group = { id: "group-1", hostUserId: "departing-host", members };
        let committedHostUserId = "departing-host";
        let releaseDeparture: () => void = () => undefined;
        let markDepartureStarted: () => void = () => undefined;
        const departureStarted = new Promise<void>((resolve) => {
            markDepartureStarted = resolve;
        });
        const departureGate = new Promise<void>((resolve) => {
            releaseDeparture = resolve;
        });
        const pauseDeparture = jest.fn(async () => {
            markDepartureStarted();
            await departureGate;
        });
        const remainingMemberships = [
            {
                userId: "successor",
                joinedAt,
                user: { username: "successor", displayName: "Alpha Successor" },
            },
            {
                userId: "rejoining-member",
                joinedAt,
                user: { username: "rejoining-member", displayName: null },
            },
        ];
        const tx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    hostUserId: committedHostUserId,
                    isActive: true,
                })),
                update: jest.fn(async ({ data }: any) => {
                    if (typeof data.hostUserId === "string") {
                        committedHostUserId = data.hostUserId;
                    }
                }),
            },
            syncGroupMember: {
                updateMany: pauseDeparture,
                findMany: jest.fn(async () => remainingMemberships),
            },
        };

        groupManager.has.mockReturnValue(true);
        groupManager.get.mockReturnValue(group);
        const snapshot = () => ({
            id: "group-1",
            hostUserId: group.hostUserId,
            playback: { queue: [] },
            members: Array.from(members.values()).map((member) => ({
                ...member,
                joinedAt: member.joinedAt.toISOString(),
                isConnected: false,
            })),
        });
        groupManager.snapshot.mockImplementation(snapshot);
        groupManager.snapshotById.mockImplementation(snapshot);
        groupManager.applyExternalSnapshot.mockImplementation(
            (authoritativeSnapshot: any) => {
                group.hostUserId = authoritativeSnapshot.hostUserId;
                members.clear();
                for (const member of authoritativeSnapshot.members) {
                    members.set(member.userId, {
                        ...member,
                        joinedAt: new Date(member.joinedAt),
                    });
                }
            },
        );
        prisma.syncGroupMember.updateMany.mockImplementation(pauseDeparture);
        prisma.syncGroupMember.findFirst.mockImplementation(async () => ({
            syncGroupId: "group-1",
            userId: "rejoining-member",
            syncGroup: { hostUserId: committedHostUserId },
        }));
        prisma.syncGroup.update.mockImplementation(async ({ data }: any) => {
            if (typeof data.hostUserId === "string") {
                committedHostUserId = data.hostUserId;
            }
        });
        prisma.$transaction.mockImplementation(async (input: any) =>
            typeof input === "function" ? input(tx) : undefined,
        );

        const leavePromise = listenTogether.leaveGroup(
            "departing-host",
            "group-1",
        );
        await departureStarted;

        let joinSettled = false;
        const joinPromise = listenTogether
            .joinGroupById("rejoining-member", "Rejoining Member", "group-1")
            .finally(() => {
                joinSettled = true;
            });
        await new Promise((resolve) => setImmediate(resolve));
        const joinedBeforeDepartureCommitted = joinSettled;

        releaseDeparture();
        await Promise.all([leavePromise, joinPromise]);

        expect(joinedBeforeDepartureCommitted).toBe(false);
        expect(committedHostUserId).toBe("successor");
        expect(group.hostUserId).toBe("successor");
        expect(
            listenTogetherStateStore.setSnapshot.mock.calls.map(
                (call: any[]) => call[1].hostUserId,
            ),
        ).toEqual(["successor"]);
    });

    it("transfers a socketless missing host using active DB membership order", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();
        const earlierJoin = new Date("2026-02-16T00:00:00.000Z");
        const laterJoin = new Date("2026-02-16T00:01:00.000Z");
        const members = new Map([
            [
                "beta",
                {
                    userId: "beta",
                    username: "Beta",
                    isHost: false,
                    joinedAt: earlierJoin,
                },
            ],
            [
                "alpha-late",
                {
                    userId: "alpha-late",
                    username: "Alpha",
                    isHost: false,
                    joinedAt: laterJoin,
                },
            ],
            [
                "alpha-early",
                {
                    userId: "alpha-early",
                    username: "Alpha",
                    isHost: false,
                    joinedAt: earlierJoin,
                },
            ],
        ]);
        const group = { id: "group-1", hostUserId: "departed-host", members };
        const tx = {
            syncGroup: {
                findUnique: jest.fn(async () => ({
                    hostUserId: "departed-host",
                    isActive: true,
                })),
                update: jest.fn(async () => undefined),
            },
            syncGroupMember: {
                updateMany: jest.fn(async () => ({ count: 1 })),
                findMany: jest.fn(async () => [
                    {
                        userId: "beta",
                        joinedAt: earlierJoin,
                        user: { username: "Beta", displayName: null },
                    },
                    {
                        userId: "alpha-late",
                        joinedAt: laterJoin,
                        user: { username: "Alpha", displayName: null },
                    },
                    {
                        userId: "alpha-early",
                        joinedAt: earlierJoin,
                        user: { username: "Alpha", displayName: null },
                    },
                ]),
            },
        };

        prisma.$transaction.mockImplementation(async (input: any) => input(tx));
        groupManager.has.mockReturnValue(true);
        groupManager.get.mockReturnValue(group);
        groupManager.snapshotById.mockImplementation(() => ({
            id: "group-1",
            hostUserId: group.hostUserId,
            playback: { queue: [] },
            members: Array.from(members.values()).map((member) => ({
                ...member,
                joinedAt: member.joinedAt.toISOString(),
                isConnected: false,
            })),
        }));

        await expect(
            listenTogether.leaveGroup("departed-host", "group-1"),
        ).resolves.toEqual({
            ended: false,
            newHostUserId: "alpha-early",
            newHostUsername: "Alpha",
        });

        expect(tx.syncGroup.update).toHaveBeenCalledWith({
            where: { id: "group-1" },
            data: { hostUserId: "alpha-early" },
        });
        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                hostUserId: "alpha-early",
                members: expect.arrayContaining([
                    expect.objectContaining({
                        userId: "alpha-early",
                        isHost: true,
                    }),
                    expect.objectContaining({
                        userId: "alpha-late",
                        isHost: false,
                    }),
                ]),
            }),
        );
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({ hostUserId: "alpha-early" }),
        );
    });

    it("ends groups whether or not they are currently loaded in memory", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        groupManager.has.mockReturnValueOnce(true);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            hostUserId: "host-1",
            isActive: true,
        });
        prisma.$transaction.mockResolvedValueOnce(undefined);

        await listenTogether.endGroup("host-1", "group-1");
        expect(groupManager.endGroup).not.toHaveBeenCalled();
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1",
        );

        groupManager.has.mockReturnValueOnce(false);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            hostUserId: "host-1",
            isActive: true,
        });
        prisma.$transaction.mockResolvedValueOnce(undefined);

        await listenTogether.endGroup("host-1", "group-2");
        expect(prisma.syncGroup.findUnique).toHaveBeenCalledWith({
            where: { id: "group-2" },
            select: { hostUserId: true, isActive: true },
        });
        expect(groupManager.endGroup).not.toHaveBeenCalled();
        expect(groupManager.remove).toHaveBeenCalledWith("group-2");
    });

    it("serializes endGroup with another mutation for the same group", async () => {
        const { listenTogether, prisma, groupManager } = loadService();
        let releaseEndUpdate: () => void = () => undefined;
        let markEndUpdateStarted: () => void = () => undefined;
        const endUpdateStarted = new Promise<void>((resolve) => {
            markEndUpdateStarted = resolve;
        });
        const endUpdateGate = new Promise<void>((resolve) => {
            releaseEndUpdate = resolve;
        });
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            hostUserId: "host-1",
            isActive: true,
        });
        prisma.syncGroup.update.mockImplementationOnce(async () => {
            markEndUpdateStarted();
            await endUpdateGate;
        });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        groupManager.has.mockReturnValue(true);
        prisma.$transaction.mockImplementationOnce(async (input: any) =>
            Array.isArray(input) ? Promise.all(input) : input(prisma),
        );

        const endPromise = listenTogether.endGroup("host-1", "group-1");
        await endUpdateStarted;

        let joinSettled = false;
        const joinPromise = listenTogether
            .joinGroupById("guest-1", "Guest", "group-1")
            .catch(() => undefined)
            .finally(() => {
                joinSettled = true;
            });
        await new Promise((resolve) => setImmediate(resolve));
        const joinedBeforeEndCommitted = joinSettled;

        releaseEndUpdate();
        await Promise.all([endPromise, joinPromise]);

        expect(joinedBeforeEndCommitted).toBe(false);
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
    });

    it("maps discoverGroups from memory and DB fallbacks", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findMany.mockResolvedValueOnce([
            {
                id: "group-1",
                name: "Live Group",
                joinCode: "LIVE01",
                visibility: "public",
                isPlaying: false,
                hostUser: {
                    id: "host-1",
                    username: "host-1",
                    displayName: "Host 1",
                },
                track: {
                    id: "track-db-1",
                    title: "DB Track",
                    album: { artist: { name: "DB Artist" } },
                },
                members: [{ userId: "u1" }],
            },
            {
                id: "group-2",
                name: "DB Group",
                joinCode: "DB0001",
                visibility: "public",
                isPlaying: true,
                hostUser: {
                    id: "host-2",
                    username: "Host 2",
                    displayName: null,
                },
                track: null,
                members: [{ userId: "u2" }],
            },
        ]);

        groupManager.get.mockImplementation((id: string) =>
            id === "group-1"
                ? {
                      members: new Map([
                          ["u1", { userId: "u1" }],
                          ["u3", { userId: "u3" }],
                      ]),
                      playback: {
                          isPlaying: true,
                          currentIndex: 0,
                          queue: [
                              {
                                  id: "track-live-1",
                                  title: "Live Track",
                                  artist: { name: "Live Artist" },
                              },
                          ],
                      },
                  }
                : null,
        );

        await expect(listenTogether.discoverGroups("u3")).resolves.toEqual([
            {
                id: "group-1",
                name: "Live Group",
                joinCode: "LIVE01",
                groupType: "host-follower",
                visibility: "public",
                host: { id: "host-1", username: "Host 1" },
                memberCount: 2,
                isMember: true,
                isPlaying: true,
                currentTrack: {
                    id: "track-live-1",
                    title: "Live Track",
                    artistName: "Live Artist",
                },
            },
            {
                id: "group-2",
                name: "DB Group",
                joinCode: "DB0001",
                groupType: "host-follower",
                visibility: "public",
                host: { id: "host-2", username: "Host 2" },
                memberCount: 1,
                isMember: false,
                isPlaying: true,
                currentTrack: null,
            },
        ]);
    });

    it("uses DB track projection when discover group is not in memory", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findMany.mockResolvedValueOnce([
            {
                id: "group-db-only",
                name: "DB Only Group",
                joinCode: "DBONLY",
                visibility: "public",
                isPlaying: false,
                hostUser: {
                    id: "host-9",
                    username: "Host Nine",
                    displayName: null,
                },
                track: {
                    id: "track-db-only",
                    title: "Stored Track",
                    album: { artist: { name: "Stored Artist" } },
                },
                members: [],
            },
        ]);
        groupManager.get.mockReturnValueOnce(null);

        await expect(listenTogether.discoverGroups("u1")).resolves.toEqual([
            {
                id: "group-db-only",
                name: "DB Only Group",
                joinCode: "DBONLY",
                groupType: "host-follower",
                visibility: "public",
                host: { id: "host-9", username: "Host Nine" },
                memberCount: 0,
                isMember: false,
                isPlaying: false,
                currentTrack: {
                    id: "track-db-only",
                    title: "Stored Track",
                    artistName: "Stored Artist",
                },
            },
        ]);
    });

    it("returns null getMyGroup when no active membership exists", async () => {
        const { listenTogether, prisma } = loadService();
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        await expect(
            listenTogether.getMyGroup("missing-user"),
        ).resolves.toBeNull();
    });

    it("hydrates from DB when no in-memory or state-store snapshot exists", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
        });
        groupManager.has.mockReturnValueOnce(false);
        (
            listenTogetherStateStore.getSnapshot as jest.Mock
        ).mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            id: "group-1",
            isActive: true,
            name: "Hydrated Group",
            joinCode: "H1DRAT",
            visibility: "public",
            hostUserId: "host-1",
            queue: [
                {
                    id: "track-1",
                    title: "Track 1",
                    duration: 120,
                    artist: { id: "artist-1", name: "Artist 1" },
                    album: {
                        id: "album-1",
                        title: "Album 1",
                        coverArt: "cover.jpg",
                    },
                },
                {
                    id: "invalid-track",
                },
            ],
            currentIndex: 0,
            isPlaying: true,
            currentTime: 12,
            stateVersion: 4,
            createdAt: new Date("2026-02-16T00:00:00.000Z"),
            members: [
                {
                    userId: "host-1",
                    isHost: true,
                    joinedAt: new Date("2026-02-16T00:00:00.000Z"),
                    user: {
                        id: "host-1",
                        username: "host-user",
                        displayName: "Host",
                    },
                },
            ],
        });
        groupManager.snapshotById.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "host-1" }],
        });

        await expect(listenTogether.getMyGroup("host-1")).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [{ id: "host-1" }],
        });
        expect(groupManager.hydrate).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                queue: [
                    expect.objectContaining({
                        id: "track-1",
                    }),
                ],
                members: [
                    expect.objectContaining({
                        userId: "host-1",
                        username: "Host",
                    }),
                ],
            }),
        );
    });

    it("hydrates with queue parsing fallbacks and username fallback when displayName is empty", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-parse",
        });
        groupManager.has.mockReturnValueOnce(false);
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            id: "group-parse",
            isActive: true,
            name: "Parse Group",
            joinCode: "PARSE1",
            visibility: "public",
            hostUserId: "host-parse",
            queue: [
                42,
                null,
                {
                    id: "track-parse",
                    title: "Track Parse",
                    duration: 180,
                    artist: { id: "artist-parse", name: "Artist Parse" },
                    album: {
                        id: "album-parse",
                        title: "Album Parse",
                        coverArt: 123,
                    },
                },
            ],
            currentIndex: 0,
            isPlaying: false,
            currentTime: 0,
            stateVersion: 2,
            createdAt: new Date("2026-02-16T00:00:00.000Z"),
            members: [
                {
                    userId: "host-parse",
                    isHost: true,
                    joinedAt: new Date("2026-02-16T00:00:00.000Z"),
                    user: {
                        id: "host-parse",
                        username: "fallback-user",
                        displayName: null,
                    },
                },
            ],
        });
        groupManager.snapshotById.mockReturnValueOnce({
            id: "group-parse",
            playback: {},
            members: [{ id: "host-parse" }],
        });

        await expect(listenTogether.getMyGroup("host-parse")).resolves.toEqual({
            id: "group-parse",
            playback: {},
            members: [{ id: "host-parse" }],
        });

        expect(groupManager.hydrate).toHaveBeenCalledWith(
            "group-parse",
            expect.objectContaining({
                queue: [
                    expect.objectContaining({
                        id: "track-parse",
                        album: expect.objectContaining({
                            coverArt: null,
                        }),
                    }),
                ],
                members: [
                    expect.objectContaining({
                        username: "fallback-user",
                    }),
                ],
            }),
        );
    });

    it("hydrates with empty queue when stored queue payload is not an array", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-non-array-queue",
        });
        groupManager.has.mockReturnValueOnce(false);
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            id: "group-non-array-queue",
            isActive: true,
            name: "Non Array Queue Group",
            joinCode: "NARRAY",
            visibility: "public",
            hostUserId: "host-narray",
            queue: { invalid: true },
            currentIndex: 0,
            isPlaying: false,
            currentTime: 0,
            stateVersion: 3,
            createdAt: new Date("2026-02-16T00:00:00.000Z"),
            members: [
                {
                    userId: "host-narray",
                    isHost: true,
                    joinedAt: new Date("2026-02-16T00:00:00.000Z"),
                    user: {
                        id: "host-narray",
                        username: "host-narray",
                        displayName: "Host NArray",
                    },
                },
            ],
        });
        groupManager.snapshotById.mockReturnValueOnce({
            id: "group-non-array-queue",
            playback: {},
            members: [{ id: "host-narray" }],
        });

        await expect(listenTogether.getMyGroup("host-narray")).resolves.toEqual(
            {
                id: "group-non-array-queue",
                playback: {},
                members: [{ id: "host-narray" }],
            },
        );

        expect(groupManager.hydrate).toHaveBeenCalledWith(
            "group-non-array-queue",
            expect.objectContaining({
                queue: [],
            }),
        );
    });

    it("starts persistence loop once, persists dirty groups, and logs update failures", async () => {
        jest.useFakeTimers();
        const { listenTogether, prisma, groupManager, logger } = loadService();

        const now = Date.now();
        groupManager.dirtyGroups.mockReturnValue([
            {
                id: "group-1",
                hostUserId: "host-1",
                playback: {
                    queue: [{ id: "track-1" }],
                    currentIndex: 0,
                    isPlaying: true,
                    positionMs: 1000,
                    lastPositionUpdate: now - 500,
                    stateVersion: 7,
                },
            },
            {
                id: "group-2",
                hostUserId: "host-2",
                playback: {
                    queue: [{ id: "track-2" }],
                    currentIndex: 0,
                    isPlaying: false,
                    positionMs: 400,
                    lastPositionUpdate: now,
                    stateVersion: 8,
                },
            },
        ]);
        prisma.syncGroup.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("update failed"));

        listenTogether.startPersistLoop();
        listenTogether.startPersistLoop();
        await jest.advanceTimersByTimeAsync(30_000);

        expect(logger.debug).toHaveBeenCalledWith(
            "[ListenTogether] Persistence loop started",
        );
        expect(groupManager.markClean).toHaveBeenCalledWith("group-1");
        expect(
            prisma.syncGroup.update.mock.calls[0][0].data,
        ).not.toHaveProperty("hostUserId");
        expect(logger.error).toHaveBeenCalledWith(
            "[ListenTogether] Failed to persist group group-2:",
            expect.any(Error),
        );

        listenTogether.stopPersistLoop();
        jest.useRealTimers();
    });

    it("persists all groups and continues when one persist update fails", async () => {
        const { listenTogether, prisma, groupManager, logger } = loadService();
        const now = Date.now();

        groupManager.allGroupIds.mockReturnValue([
            "group-1",
            "group-2",
            "missing",
        ]);
        groupManager.get.mockImplementation((id: string) => {
            if (id === "group-1") {
                return {
                    id: "group-1",
                    hostUserId: "host-1",
                    playback: {
                        queue: [{ id: "track-1" }],
                        currentIndex: 0,
                        isPlaying: true,
                        positionMs: 10,
                        lastPositionUpdate: now - 1_000,
                        stateVersion: 1,
                    },
                };
            }
            if (id === "group-2") {
                return {
                    id: "group-2",
                    hostUserId: "host-2",
                    playback: {
                        queue: [{ id: "track-2" }],
                        currentIndex: 0,
                        isPlaying: false,
                        positionMs: 20,
                        lastPositionUpdate: now,
                        stateVersion: 2,
                    },
                };
            }
            return null;
        });

        prisma.syncGroup.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("persist failed"));

        await listenTogether.persistAllGroups();

        expect(prisma.syncGroup.update).toHaveBeenCalledTimes(2);
        expect(
            prisma.syncGroup.update.mock.calls.map(
                (call: any[]) => "hostUserId" in call[0].data,
            ),
        ).toEqual([false, false]);
        expect(logger.error).toHaveBeenCalledWith(
            "[ListenTogether] Final persist failed for group-2:",
            expect.any(Error),
        );
    });

    it("persists null trackId when queue has no current track", async () => {
        jest.useFakeTimers();
        const { listenTogether, prisma, groupManager } = loadService();
        const now = Date.now();

        groupManager.dirtyGroups.mockReturnValue([
            {
                id: "group-empty",
                hostUserId: "host-empty",
                playback: {
                    queue: [],
                    currentIndex: 0,
                    isPlaying: false,
                    positionMs: 0,
                    lastPositionUpdate: now,
                    stateVersion: 1,
                },
            },
        ]);
        prisma.syncGroup.update.mockResolvedValue({});

        listenTogether.startPersistLoop();
        await jest.advanceTimersByTimeAsync(30_000);
        listenTogether.stopPersistLoop();

        expect(prisma.syncGroup.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    trackId: null,
                }),
            }),
        );

        groupManager.allGroupIds.mockReturnValue(["group-empty"]);
        groupManager.get.mockReturnValue({
            id: "group-empty",
            hostUserId: "host-empty",
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                lastPositionUpdate: now,
                stateVersion: 2,
            },
        });

        await listenTogether.persistAllGroups();

        expect(prisma.syncGroup.update).toHaveBeenLastCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    trackId: null,
                }),
            }),
        );
        jest.useRealTimers();
    });

    it("does not auto-leave when joining the same active group", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
        });
        prisma.syncGroup.findUnique.mockResolvedValueOnce({ isActive: true });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.addMember.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await expect(
            listenTogether.joinGroup("u1", "User", "GROUP1"),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "group-1",
                members: [expect.objectContaining({ userId: "u1" })],
            }),
        );
        expect(prisma.syncGroupMember.updateMany).not.toHaveBeenCalled();
    });

    it("skips in-memory addMember when joinGroupById user is already present", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "u1",
            syncGroup: { hostUserId: "host-1" },
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.get.mockReturnValueOnce({
            id: "group-1",
            members: new Map([["u1", { userId: "u1" }]]),
            playback: {
                queue: [],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                lastPositionUpdate: Date.now(),
                stateVersion: 1,
            },
            hostUserId: "host-1",
        });
        groupManager.snapshot.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await listenTogether.joinGroupById("u1", "User", "group-1");
        expect(groupManager.addMember).not.toHaveBeenCalled();
        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ hostUserId: "host-1" }),
        );
    });

    it("returns null getMyGroup when DB group cannot be hydrated", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-inactive",
        });
        groupManager.has.mockReturnValueOnce(false);
        listenTogetherStateStore.getSnapshot.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce({
            id: "group-inactive",
            isActive: false,
        });
        groupManager.snapshotById.mockReturnValueOnce(null);

        await expect(listenTogether.getMyGroup("u1")).resolves.toBeNull();
    });

    it("uses memory-group track projection path with null current track when queue is empty", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findMany.mockResolvedValueOnce([
            {
                id: "group-1",
                name: "Mem Group",
                joinCode: "MEM001",
                visibility: "public",
                isPlaying: false,
                hostUser: { id: "host-1", username: "Host", displayName: null },
                track: {
                    id: "db-track",
                    title: "DB Track",
                    album: { artist: { name: "DB Artist" } },
                },
                members: [],
            },
        ]);
        groupManager.get.mockReturnValueOnce({
            members: new Map(),
            playback: { queue: [], currentIndex: 0, isPlaying: false },
        });

        const groups = await listenTogether.discoverGroups("u1");
        expect(groups[0]?.currentTrack).toBeNull();
    });

    it("starts persistence loop with no dirty groups without issuing DB updates", async () => {
        jest.useFakeTimers();
        const { listenTogether, prisma, groupManager } = loadService();

        groupManager.dirtyGroups.mockReturnValue([]);
        listenTogether.startPersistLoop();
        await jest.advanceTimersByTimeAsync(30_000);
        listenTogether.stopPersistLoop();
        listenTogether.stopPersistLoop();

        expect(prisma.syncGroup.update).not.toHaveBeenCalled();
        jest.useRealTimers();
    });

    it("truncates queue inputs to MAX_QUEUE_SIZE before validation on create", async () => {
        const {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
        } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        // Return empty — we only care about the input length passed to findMany
        prisma.track.findMany.mockResolvedValueOnce([]);

        const tx = {
            syncGroup: {
                create: jest.fn(async () => ({
                    id: "group-trunc",
                    name: "Trunc Group",
                    joinCode: "TRUNC1",
                })),
            },
            syncGroupMember: { create: jest.fn(async () => ({})) },
        };
        prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));

        const trackIds = Array.from({ length: 700 }, (_, i) => `t-${i}`);

        await listenTogether.createGroup("host-1", "Host", {
            queueTrackIds: trackIds,
        });

        // validateQueueTracks should have received at most 500 inputs,
        // so findMany is called with at most 500 unique IDs
        const findManyCall = prisma.track.findMany.mock.calls[0]?.[0];
        expect(findManyCall?.where?.id?.in?.length).toBeLessThanOrEqual(500);
    });

    it("creates groups with empty validated queue and non-finite time coercion", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        prisma.$transaction.mockImplementationOnce(async (fn: any) =>
            fn({
                syncGroup: {
                    create: jest.fn(async () => ({
                        id: "group-empty",
                        name: "Host's Group",
                        joinCode: "AAAAAA",
                    })),
                },
                syncGroupMember: {
                    create: jest.fn(async () => ({})),
                },
            }),
        );

        await listenTogether.createGroup("host-1", "Host", {
            currentTrackId: "missing",
            currentTimeMs: Number.NaN,
            isPlaying: true,
        });

        expect(groupManager.create).toHaveBeenCalledWith(
            "group-empty",
            expect.objectContaining({
                queue: [],
                currentTimeMs: 0,
                isPlaying: false,
            }),
        );
    });
});

describe("listenTogether playback boundary behavior", () => {
    const track = (id: string, duration: number): RuntimeSyncQueueItem => ({
        id,
        title: `Track ${id}`,
        duration,
        artist: { id: `artist-${id}`, name: `Artist ${id}` },
        album: { id: `album-${id}`, title: `Album ${id}`, coverArt: null },
    });

    const createCallbacks = (): jest.Mocked<RuntimeManagerCallbacks> => ({
        onGroupState: jest.fn(),
        onPlaybackDelta: jest.fn(),
        onQueueDelta: jest.fn(),
        onWaiting: jest.fn(),
        onPlayAt: jest.fn(),
        onMemberJoined: jest.fn(),
        onMemberPresence: jest.fn(),
        onMemberLeft: jest.fn(),
        onGroupEnded: jest.fn(),
    });

    function resetRuntimeManager(): void {
        for (const groupId of runtimeGroupManager.allGroupIds()) {
            runtimeGroupManager.remove(groupId);
        }
    }

    function createPlayingGroup(
        groupId: string,
        queue: RuntimeSyncQueueItem[],
        callbacks: RuntimeManagerCallbacks,
    ): void {
        runtimeGroupManager.setCallbacks(callbacks);
        runtimeGroupManager.create(groupId, {
            name: "Boundary Group",
            joinCode: "BOUND1",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue,
            isPlaying: true,
            createdAt: new Date(),
        });
        runtimeGroupManager.addMember(groupId, "guest", "Guest");
        runtimeGroupManager.addSocket(groupId, "host", "host-socket");
        runtimeGroupManager.addSocket(groupId, "guest", "guest-socket");
    }

    beforeEach(() => {
        resetRuntimeManager();
        jest.useFakeTimers({ now: new Date("2026-08-11T00:00:00.000Z") });
    });

    afterEach(() => {
        resetRuntimeManager();
        jest.useRealTimers();
    });

    it("clamps emitted positions and enters the next track ready gate after the boundary grace", async () => {
        const callbacks = createCallbacks();
        createPlayingGroup(
            "g-boundary-next",
            [track("short", 3), track("next", 30)],
            callbacks,
        );

        await jest.advanceTimersByTimeAsync(4_000);
        runtimeGroupManager.addMember("g-boundary-next", "host", "Host");
        const emittedDuringGrace =
            callbacks.onGroupState.mock.calls.at(-1)?.[1];
        expect(emittedDuringGrace?.playback.positionMs).toBe(3_000);

        await jest.advanceTimersByTimeAsync(4_001);

        const afterWatchdog =
            runtimeGroupManager.snapshotById("g-boundary-next");
        expect(afterWatchdog?.playback.currentIndex).toBe(1);
        expect(afterWatchdog?.syncState).toBe("waiting");
        expect(callbacks.onWaiting).toHaveBeenCalledTimes(1);
        expect(
            callbacks.onGroupState.mock.calls.every(([, snapshot]) => {
                const item =
                    snapshot.playback.queue[snapshot.playback.currentIndex];
                return (
                    !item ||
                    snapshot.playback.positionMs <= item.duration * 1_000
                );
            }),
        ).toBe(true);
    });

    it("pauses and broadcasts the clamped duration when there is no next item", async () => {
        const callbacks = createCallbacks();
        createPlayingGroup("g-boundary-end", [track("only", 3)], callbacks);

        await jest.advanceTimersByTimeAsync(8_001);

        const snapshot = runtimeGroupManager.snapshotById("g-boundary-end");
        expect(snapshot?.syncState).toBe("paused");
        expect(snapshot?.playback.isPlaying).toBe(false);
        expect(snapshot?.playback.positionMs).toBe(3_000);
        expect(callbacks.onGroupState).toHaveBeenLastCalledWith(
            "g-boundary-end",
            expect.objectContaining({ syncState: "paused" }),
        );
    });

    it("cancels the pending boundary action when the host advances during grace", async () => {
        const boundaryAction = jest.fn();
        const callbacks = {
            ...createCallbacks(),
            onBoundaryWatchdog: boundaryAction,
        } as jest.Mocked<RuntimeManagerCallbacks>;
        createPlayingGroup(
            "g-boundary-cancel",
            [track("short", 3), track("next", 30)],
            callbacks,
        );

        await jest.advanceTimersByTimeAsync(4_000);
        runtimeGroupManager.next("g-boundary-cancel", "host");
        await jest.advanceTimersByTimeAsync(4_001);

        expect(boundaryAction).not.toHaveBeenCalled();
        expect(runtimeGroupManager.snapshotById("g-boundary-cancel")).toEqual(
            expect.objectContaining({
                syncState: "waiting",
                playback: expect.objectContaining({ currentIndex: 1 }),
            }),
        );
    });
});
