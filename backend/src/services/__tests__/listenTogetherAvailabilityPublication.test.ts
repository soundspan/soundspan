import { DeterministicRedisServer } from "./support/deterministicRedis";

function snapshot(queueId: string, stateVersion: number) {
    return {
        id: "group-1",
        name: "Group",
        joinCode: "ABC123",
        groupType: "host-follower" as const,
        visibility: "private" as const,
        isActive: true,
        hostUserId: "host",
        syncState: "waiting" as const,
        playback: {
            queue: [
                {
                    id: queueId,
                    title: queueId,
                    duration: 10,
                    artist: { id: "artist", name: "Artist" },
                    album: { id: "album", title: "Album", coverArt: null },
                },
            ],
            currentIndex: 0,
            isPlaying: false,
            positionMs: 0,
            serverTime: 1,
            stateVersion,
            trackId: queueId,
        },
        members: [],
    };
}

describe("listen together availability publication", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadModules(
        server: DeterministicRedisServer,
        enqueueAvailability?: (
            groupId: string,
            fence: unknown,
            emit: () => void | Promise<void>,
        ) => Promise<void>,
    ) {
        jest.resetModules();
        let currentSnapshot = snapshot("track-a", 1);
        const groupManager = {
            snapshotById: jest.fn(() => currentSnapshot),
            setUnavailableIndices: jest.fn(),
        };
        const resolveQueueForUser = jest.fn(
            async () =>
                new Map([
                    [
                        0,
                        {
                            available: false as const,
                            reason: "no-provider" as const,
                        },
                    ],
                ]),
        );
        const log = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        log.child.mockReturnValue(log);
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    mutationLockEnabled: true,
                    stateStoreEnabled: true,
                    mutationLockTtlMs: 1_000,
                    mutationLockRenewIntervalMs: 500,
                    mutationLockPrefix: "listen-together:mutation-lock",
                    stateStoreKeyPrefix: "listen-together:state",
                    stateStoreTtlSeconds: 21_600,
                    publicationDeadlineMs: 2_000,
                },
            },
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => server.createClient()),
        }));
        jest.doMock("../../utils/logger", () => ({ logger: log }));
        jest.doMock("../listenTogetherManager", () => ({ groupManager }));
        jest.doMock("../listenTogetherResolution", () => ({
            resolveQueueForUser,
        }));
        jest.doMock("../listenTogetherClusterSync", () => ({
            listenTogetherClusterSync: {
                publishSnapshot: jest.fn(),
                publishMembership: jest.fn(),
                publishEnded: jest.fn(),
            },
        }));
        if (enqueueAvailability) {
            jest.doMock("../listenTogetherCallbacks", () => ({
                enqueueGroupAvailabilityPublication: enqueueAvailability,
            }));
        } else {
            jest.dontMock("../listenTogetherCallbacks");
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const lock =
            require("../listenTogetherMutationLock") as typeof import("../listenTogetherMutationLock");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const publication =
            require("../listenTogetherAvailabilityPublication") as typeof import("../listenTogetherAvailabilityPublication");
        return {
            lock,
            publication,
            groupManager,
            resolveQueueForUser,
            setCurrentSnapshot: (value: ReturnType<typeof snapshot>) => {
                currentSnapshot = value;
            },
        };
    }

    it("drops resolution when the queue changes before the fresh lock", async () => {
        const server = new DeterministicRedisServer();
        const modules = loadModules(server);
        let finishResolution: () => void = () => undefined;
        let markResolutionStarted: () => void = () => undefined;
        const resolutionStarted = new Promise<void>((resolve) => {
            markResolutionStarted = resolve;
        });
        const resolutionGate = new Promise<void>((resolve) => {
            finishResolution = resolve;
        });
        modules.resolveQueueForUser.mockImplementationOnce(async () => {
            markResolutionStarted();
            await resolutionGate;
            return new Map([
                [
                    0,
                    {
                        available: false as const,
                        reason: "no-provider" as const,
                    },
                ],
            ]);
        });
        const socket = { data: { userId: "user-1" }, emit: jest.fn() };
        const ns = {
            in: jest.fn(() => ({
                fetchSockets: jest.fn(async () => [socket]),
            })),
        };

        const pending = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-a", 1),
        );
        await resolutionStarted;
        modules.setCurrentSnapshot(snapshot("track-b", 2));
        finishResolution();

        await expect(pending).resolves.toBe(false);
        expect(
            modules.groupManager.setUnavailableIndices,
        ).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        modules.lock.shutdownGroupMutationLock();
    });

    it("applies and emits matching resolution through the fenced queue", async () => {
        const server = new DeterministicRedisServer();
        const modules = loadModules(server);
        const socket = { data: { userId: "user-1" }, emit: jest.fn() };
        const ns = {
            in: jest.fn(() => ({
                fetchSockets: jest.fn(async () => [socket]),
            })),
        };

        await expect(
            modules.publication.publishAvailabilityForGroup(
                ns as any,
                "group-1",
                modules.lock.withGroupMutationLock,
                snapshot("track-a", 1),
            ),
        ).resolves.toBe(true);

        expect(modules.groupManager.setUnavailableIndices).toHaveBeenCalledWith(
            "group-1",
            "user-1",
            [0],
        );
        expect(socket.emit).toHaveBeenCalledWith("group:availability", {
            availability: [
                {
                    queueIndex: 0,
                    available: false,
                    source: undefined,
                    localTrackId: undefined,
                    tidalTrackId: undefined,
                    youtubeVideoId: undefined,
                    reason: "no-provider",
                },
            ],
            stateVersion: 1,
        });
        expect(
            server.commandLog.some(
                (command) =>
                    command.name === "EVAL" &&
                    String(command.args[0]).includes(
                        "listen-together:claim-publication-fence",
                    ),
            ),
        ).toBe(true);
        modules.lock.shutdownGroupMutationLock();
    });

    it("deduplicates users and limits active resolutions to eight", async () => {
        const server = new DeterministicRedisServer();
        const modules = loadModules(server);
        let active = 0;
        let maximumActive = 0;
        const releases: Array<() => void> = [];
        modules.resolveQueueForUser.mockImplementation(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return new Map();
        });
        const sockets = Array.from({ length: 10 }, (_value, index) => ({
            data: { userId: index === 9 ? "user-8" : `user-${index}` },
            emit: jest.fn(),
        }));
        const ns = {
            in: jest.fn(() => ({ fetchSockets: jest.fn(async () => sockets) })),
        };

        const publication = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-a", 1),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(maximumActive).toBe(8);
        while (releases.length > 0) releases.shift()?.();
        await publication;

        expect(modules.resolveQueueForUser).toHaveBeenCalledTimes(9);
        modules.lock.shutdownGroupMutationLock();
    });

    it("coalesces queued passes so only the latest snapshot is resolved", async () => {
        const server = new DeterministicRedisServer();
        const modules = loadModules(server);
        let releaseFirst: () => void = () => undefined;
        modules.resolveQueueForUser.mockImplementationOnce(
            async () =>
                new Promise((resolve) => {
                    releaseFirst = () => resolve(new Map());
                }),
        );
        const socket = { data: { userId: "user-1" }, emit: jest.fn() };
        const ns = {
            in: jest.fn(() => ({
                fetchSockets: jest.fn(async () => [socket]),
            })),
        };

        const first = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-a", 1),
        );
        await Promise.resolve();
        const superseded = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-b", 2),
        );
        const latest = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-c", 3),
        );
        modules.setCurrentSnapshot(snapshot("track-c", 3));
        releaseFirst();

        await expect(first).resolves.toBe(false);
        await expect(superseded).resolves.toBe(false);
        await expect(latest).resolves.toBe(true);
        expect(modules.resolveQueueForUser).toHaveBeenCalledTimes(2);
        modules.lock.shutdownGroupMutationLock();
    });

    it("abandons one pass at its overall deadline and suppresses late effects", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        const modules = loadModules(server);
        let releaseResolution: () => void = () => undefined;
        modules.resolveQueueForUser.mockImplementationOnce(
            async () =>
                new Promise((resolve) => {
                    releaseResolution = () => resolve(new Map());
                }),
        );
        const socket = { data: { userId: "user-1" }, emit: jest.fn() };
        const ns = {
            in: jest.fn(() => ({
                fetchSockets: jest.fn(async () => [socket]),
            })),
        };

        const publication = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-a", 1),
        );
        await jest.advanceTimersByTimeAsync(2_001);
        await expect(publication).resolves.toBe(false);
        releaseResolution();
        await Promise.resolve();

        expect(
            modules.groupManager.setUnavailableIndices,
        ).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        modules.lock.shutdownGroupMutationLock();
    });

    it("advances to queued work after bounded abandonment and suppresses a stale emit callback", async () => {
        jest.useFakeTimers();
        let releaseFirstPublication: () => void = () => undefined;
        let publicationCalls = 0;
        const enqueueAvailability = jest.fn(
            async (
                _groupId: string,
                _fence: unknown,
                emit: () => void | Promise<void>,
            ) => {
                publicationCalls += 1;
                if (publicationCalls === 1) {
                    await new Promise<void>((resolve) => {
                        releaseFirstPublication = resolve;
                    });
                }
                await emit();
            },
        );
        const server = new DeterministicRedisServer();
        const modules = loadModules(server, enqueueAvailability);
        const socket = { data: { userId: "user-1" }, emit: jest.fn() };
        const ns = {
            in: jest.fn(() => ({
                fetchSockets: jest.fn(async () => [socket]),
            })),
        };

        const first = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-a", 1),
        );
        await jest.advanceTimersByTimeAsync(1);
        modules.setCurrentSnapshot(snapshot("track-b", 2));
        const latest = modules.publication.publishAvailabilityForGroup(
            ns as any,
            "group-1",
            modules.lock.withGroupMutationLock,
            snapshot("track-b", 2),
        );

        await jest.advanceTimersByTimeAsync(2_001);
        await jest.advanceTimersByTimeAsync(2_001);
        await jest.advanceTimersByTimeAsync(1);
        await expect(first).resolves.toBe(false);
        await expect(latest).resolves.toBe(true);

        releaseFirstPublication();
        await Promise.resolve();
        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.emit).toHaveBeenCalledWith(
            "group:availability",
            expect.objectContaining({ stateVersion: 2 }),
        );
        modules.lock.shutdownGroupMutationLock();
    });
});
