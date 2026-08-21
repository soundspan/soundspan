import { DeterministicRedisServer } from "./support/deterministicRedis";

type StateStoreModule = typeof import("../listenTogetherStateStore");

function snapshot(stateVersion: number, serverTime: number) {
    return {
        id: "group-1",
        name: "Group",
        joinCode: "ABC123",
        groupType: "host-follower" as const,
        visibility: "private" as const,
        isActive: true,
        hostUserId: "host",
        syncState: "paused" as const,
        playback: {
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            positionMs: 0,
            serverTime,
            stateVersion,
            trackId: null,
        },
        members: [],
    };
}

describe("listen together Redis fencing integration", () => {
    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadStateStore(
        server: DeterministicRedisServer,
    ): StateStoreModule {
        jest.resetModules();
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    stateStoreEnabled: true,
                    stateStoreKeyPrefix: "listen-together:state",
                    stateStoreTtlSeconds: 21_600,
                    publicationDeadlineMs: 1_000,
                },
            },
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => server.createClient()),
        }));
        const logger = {
            warn: jest.fn(),
            child: jest.fn(() => ({
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn(),
            })),
        };
        jest.doMock("../../utils/logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("../listenTogetherStateStore");
    }

    it("rejects an older snapshot even when it carries a newer fencing token", async () => {
        const server = new DeterministicRedisServer();
        const { listenTogetherStateStore } = loadStateStore(server);
        server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "1",
        );

        await expect(
            listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot(20, 2_000),
                1,
            ),
        ).resolves.toBe("accepted");
        server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "2",
        );
        await expect(
            listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot(16, 3_000),
                2,
            ),
        ).resolves.toBe("stale");
        await expect(
            listenTogetherStateStore.getSnapshot("group-1"),
        ).resolves.toMatchObject({
            playback: { stateVersion: 20, serverTime: 2_000 },
        });
    });

    it("rejects an older producer time at the same version for a newer token", async () => {
        const server = new DeterministicRedisServer();
        const { listenTogetherStateStore } = loadStateStore(server);
        server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "1",
        );

        await listenTogetherStateStore.setSnapshot(
            "group-1",
            snapshot(20, 2_000),
            1,
        );
        server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "2",
        );
        await expect(
            listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot(20, 1_999),
                2,
            ),
        ).resolves.toBe("stale");
    });

    it("rejects an older fencing token through the real state-store script", async () => {
        const server = new DeterministicRedisServer();
        const { listenTogetherStateStore } = loadStateStore(server);
        server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "9",
        );

        await listenTogetherStateStore.setSnapshot(
            "group-1",
            snapshot(1, 1_000),
            9,
        );
        await expect(
            listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot(2, 2_000),
                8,
            ),
        ).resolves.toBe("stale");
    });

    it("rejects an expired holder after a newer lease token is allocated", async () => {
        const server = new DeterministicRedisServer();
        const { listenTogetherStateStore } = loadStateStore(server);
        const allocator = server.createClient();
        await allocator.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );
        await allocator.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );

        await expect(
            listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot(21, 3_000),
                1,
            ),
        ).resolves.toBe("stale");
    });

    it("propagates authoritative Redis read failures", async () => {
        const server = new DeterministicRedisServer();
        const { listenTogetherStateStore } = loadStateStore(server);
        server.beforeCommand = (command) => {
            if (command.name === "GET") throw new Error("redis-read-down");
        };

        await expect(
            listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toThrow("redis-read-down");
    });
});
