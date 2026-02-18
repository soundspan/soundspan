describe("listenTogether service", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadService() {
        process.env = { ...originalEnv };

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
        };

        const groupManager: any = {
            create: jest.fn(() => groupState),
            addMember: jest.fn(() => ({ id: "group-1", playback: {}, members: [] })),
            has: jest.fn(() => false),
            get: jest.fn(() => groupState),
            hydrate: jest.fn(),
            applyExternalSnapshot: jest.fn(),
            snapshot: jest.fn(() => ({ id: "group-1", playback: {}, members: [] })),
            snapshotById: jest.fn(() => ({ id: "group-1", playback: {}, members: [] })),
            removeMember: jest.fn(() => ({ ended: false })),
            remove: jest.fn(),
            endGroup: jest.fn(),
            dirtyGroups: jest.fn(() => []),
            markClean: jest.fn(),
            allGroupIds: jest.fn(() => []),
        };

        const listenTogetherStateStore = {
            getSnapshot: jest.fn(async () => null),
            setSnapshot: jest.fn(async () => undefined),
            deleteSnapshot: jest.fn(async () => undefined),
        };

        const logger = {
            debug: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("crypto", () => ({
            __esModule: true,
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
        jest.doMock("../listenTogetherManager", () => ({
            groupManager,
            GroupError: MockGroupError,
        }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const listenTogether = require("../listenTogether");

        return {
            listenTogether,
            prisma,
            groupManager,
            listenTogetherStateStore,
            MockGroupError,
            logger,
        };
    }

    it("creates a group with validated local tracks and persists snapshot", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroup.findUnique.mockResolvedValueOnce(null);
        prisma.track.findMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Track 1",
                duration: 120,
                filePath: "/music/t1.mp3",
                album: {
                    id: "a1",
                    title: "Album 1",
                    coverUrl: "cover.jpg",
                    artist: { id: "ar1", name: "Artist 1" },
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
                queueTrackIds: ["t1", "missing"],
                currentTrackId: "t1",
                isPlaying: true,
                currentTimeMs: 1000,
            })
        ).resolves.toEqual({ id: "group-1", playback: {}, members: [] });

        expect(groupManager.create).toHaveBeenCalledWith(
            "group-1",
            expect.objectContaining({
                hostUserId: "host-1",
                queue: [
                    expect.objectContaining({
                        id: "t1",
                        title: "Track 1",
                    }),
                ],
                isPlaying: true,
            })
        );
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { id: "group-1", playback: {}, members: [] }
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
            })
        );

        await expect(
            listenTogether.createGroup("host-2", "host-two")
        ).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [],
        });
    });

    it("prefers displayName for default group naming and member labels", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

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
            })
        );
        expect(groupManager.create).toHaveBeenCalledWith(
            "group-display",
            expect.objectContaining({
                hostUsername: "DJ Host",
            })
        );

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-display" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);
        prisma.syncGroupMember.upsert.mockResolvedValueOnce({});
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

        expect(groupManager.addMember).toHaveBeenCalledWith(
            "group-display",
            "guest-1",
            "Guest Display"
        );
    });

    it("joins a group by code and rehydrates from state store when missing in memory", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null); // maybeLeaveExisting
        prisma.syncGroupMember.upsert.mockResolvedValueOnce({});
        groupManager.has.mockReturnValue(false);
        (listenTogetherStateStore.getSnapshot as jest.Mock).mockResolvedValueOnce({
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
            listenTogether.joinGroup("guest-1", "Guest", "aaaaaa")
        ).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        expect(groupManager.applyExternalSnapshot).toHaveBeenCalledWith({
            id: "group-1",
            playback: {},
            members: [],
        });
        expect(prisma.syncGroupMember.upsert).toHaveBeenCalled();
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { id: "group-1", playback: {}, members: [{ id: "guest-1" }] }
        );
    });

    it("rejects invalid join code format", async () => {
        const { listenTogether, MockGroupError } = loadService();

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "bad")
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
            listenTogether.createGroup("host-1", "Host", {})
        ).rejects.toThrow("Failed to generate a unique join code");
    });

    it("rejects join when join code resolves to no active group", async () => {
        const { listenTogether, prisma, MockGroupError } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce(null);

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "AAAAAA")
        ).rejects.toBeInstanceOf(MockGroupError);
    });

    it("auto-leaves a different active group before joining a new group", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "new-group" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "old-group",
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.addMember.mockReturnValueOnce({
            id: "new-group",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        await expect(
            listenTogether.joinGroup("guest-1", "Guest", "AAAAAA")
        ).resolves.toEqual({
            id: "new-group",
            playback: {},
            members: [{ id: "guest-1" }],
        });

        expect(prisma.syncGroupMember.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    syncGroupId: "old-group",
                    userId: "guest-1",
                }),
            })
        );
    });

    it("enforces membership and in-memory presence on joinGroupById", async () => {
        const { listenTogether, prisma, groupManager, MockGroupError } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce(null);

        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1")
        ).rejects.toBeInstanceOf(MockGroupError);

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "u1",
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.get.mockReturnValueOnce(null);

        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1")
        ).rejects.toBeInstanceOf(MockGroupError);
    });

    it("adds missing in-memory member during joinGroupById and persists snapshot", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

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
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.get.mockReturnValueOnce(group);
        groupManager.snapshot.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await expect(
            listenTogether.joinGroupById("u1", "User", "group-1")
        ).resolves.toEqual({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        expect(groupManager.addMember).toHaveBeenCalledWith("group-1", "u1", "User");
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { id: "group-1", playback: {}, members: [{ id: "u1" }] }
        );
    });

    it("handles leaveGroup end/disband and host transfer branches", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

        groupManager.has.mockReturnValue(true);
        groupManager.removeMember.mockReturnValueOnce({ ended: true });
        prisma.$transaction.mockResolvedValueOnce(undefined);
        groupManager.snapshotById.mockReturnValueOnce(null);

        await expect(
            listenTogether.leaveGroup("u1", "group-1")
        ).resolves.toEqual({ ended: true });
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1"
        );

        groupManager.removeMember.mockReturnValueOnce({
            ended: false,
            newHostUserId: "u2",
            newHostUsername: "User Two",
        });
        prisma.$transaction.mockResolvedValueOnce(undefined);
        groupManager.snapshotById.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u2" }],
        });

        await expect(
            listenTogether.leaveGroup("u1", "group-1")
        ).resolves.toEqual({
            ended: false,
            newHostUserId: "u2",
            newHostUsername: "User Two",
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { id: "group-1", playback: {}, members: [{ id: "u2" }] }
        );
    });

    it("handles leaveGroup when group is not loaded in memory", async () => {
        const { listenTogether, groupManager } = loadService();

        groupManager.has.mockReturnValue(false);
        groupManager.snapshotById.mockReturnValueOnce(null);

        await expect(listenTogether.leaveGroup("u1", "group-missing")).resolves.toEqual({
            ended: false,
        });
        expect(groupManager.removeMember).not.toHaveBeenCalled();
    });

    it("ends groups whether or not they are currently loaded in memory", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

        groupManager.has.mockReturnValueOnce(true);
        prisma.$transaction.mockResolvedValueOnce(undefined);

        await listenTogether.endGroup("host-1", "group-1");
        expect(groupManager.endGroup).toHaveBeenCalledWith("group-1", "host-1");
        expect(groupManager.remove).toHaveBeenCalledWith("group-1");
        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1"
        );

        groupManager.has.mockReturnValueOnce(false);
        prisma.$transaction.mockResolvedValueOnce(undefined);

        await listenTogether.endGroup("host-1", "group-2");
        expect(groupManager.endGroup).toHaveBeenCalledTimes(1);
        expect(groupManager.remove).toHaveBeenCalledWith("group-2");
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
                hostUser: { id: "host-1", username: "host-1", displayName: "Host 1" },
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
                hostUser: { id: "host-2", username: "Host 2", displayName: null },
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
                : null
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
                hostUser: { id: "host-9", username: "Host Nine", displayName: null },
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
        await expect(listenTogether.getMyGroup("missing-user")).resolves.toBeNull();
    });

    it("hydrates from DB when no in-memory or state-store snapshot exists", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
        });
        groupManager.has.mockReturnValueOnce(false);
        (listenTogetherStateStore.getSnapshot as jest.Mock).mockResolvedValueOnce(null);
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
                    album: { id: "album-1", title: "Album 1", coverArt: "cover.jpg" },
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
                    user: { id: "host-1", username: "host-user", displayName: "Host" },
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
            })
        );
    });

    it("hydrates with queue parsing fallbacks and username fallback when displayName is empty", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

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
            })
        );
    });

    it("hydrates with empty queue when stored queue payload is not an array", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

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

        await expect(listenTogether.getMyGroup("host-narray")).resolves.toEqual({
            id: "group-non-array-queue",
            playback: {},
            members: [{ id: "host-narray" }],
        });

        expect(groupManager.hydrate).toHaveBeenCalledWith(
            "group-non-array-queue",
            expect.objectContaining({
                queue: [],
            })
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
            "[ListenTogether] Persistence loop started"
        );
        expect(groupManager.markClean).toHaveBeenCalledWith("group-1");
        expect(logger.error).toHaveBeenCalledWith(
            "[ListenTogether] Failed to persist group group-2:",
            expect.any(Error)
        );

        listenTogether.stopPersistLoop();
        jest.useRealTimers();
    });

    it("persists all groups and continues when one persist update fails", async () => {
        const { listenTogether, prisma, groupManager, logger } = loadService();
        const now = Date.now();

        groupManager.allGroupIds.mockReturnValue(["group-1", "group-2", "missing"]);
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
        expect(logger.error).toHaveBeenCalledWith(
            "[ListenTogether] Final persist failed for group-2:",
            expect.any(Error)
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
            })
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
            })
        );
        jest.useRealTimers();
    });

    it("does not auto-leave when joining the same active group", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroup.findFirst.mockResolvedValueOnce({ id: "group-1" });
        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
        });
        groupManager.has.mockReturnValueOnce(true);
        groupManager.addMember.mockReturnValueOnce({
            id: "group-1",
            playback: {},
            members: [{ id: "u1" }],
        });

        await expect(listenTogether.joinGroup("u1", "User", "GROUP1")).resolves.toEqual(
            {
                id: "group-1",
                playback: {},
                members: [{ id: "u1" }],
            }
        );
        expect(prisma.syncGroupMember.updateMany).not.toHaveBeenCalled();
    });

    it("skips in-memory addMember when joinGroupById user is already present", async () => {
        const { listenTogether, prisma, groupManager } = loadService();

        prisma.syncGroupMember.findFirst.mockResolvedValueOnce({
            syncGroupId: "group-1",
            userId: "u1",
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
    });

    it("returns null getMyGroup when DB group cannot be hydrated", async () => {
        const { listenTogether, prisma, groupManager, listenTogetherStateStore } =
            loadService();

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
            })
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
            })
        );
    });
});
