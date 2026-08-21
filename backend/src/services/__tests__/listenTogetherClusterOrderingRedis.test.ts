import { DeterministicRedisServer } from "./support/deterministicRedis";

describe("listen together cluster ordering with delayed Redis publication", () => {
    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadCluster(server: DeterministicRedisServer) {
        jest.resetModules();
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
                    stateSyncEnabled: true,
                    stateSyncChannel: "listen-together:state-sync",
                },
            },
        }));
        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => server.createClient()),
        }));
        jest.doMock("../../utils/logger", () => ({ logger: log }));
        jest.doMock("../listenTogetherStateStore", () => ({
            listenTogetherStateStore: {
                validatePublication: jest.fn(async () => true),
            },
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("../listenTogetherClusterSync") as typeof import("../listenTogetherClusterSync");
    }

    it("drops a lower-token delayed membership event and a duplicate event id", async () => {
        const server = new DeterministicRedisServer();
        const { ListenTogetherClusterSync } = loadCluster(server);
        const publisher = new ListenTogetherClusterSync();
        const receiver = new ListenTogetherClusterSync();
        const received: string[] = [];
        await receiver.start(
            jest.fn(),
            jest.fn(),
            (_groupId, membership) => () => {
                received.push(membership.hostUserId);
            },
        );
        await publisher.start(jest.fn());

        let releaseOld: () => void = () => undefined;
        let markOldStarted: () => void = () => undefined;
        const oldStarted = new Promise<void>((resolve) => {
            markOldStarted = resolve;
        });
        server.publishHook = (_channel, message, deliver) => {
            const event = JSON.parse(message) as { fencingToken?: number };
            if (event.fencingToken !== 1) return deliver();
            markOldStarted();
            return new Promise<number>((resolve) => {
                releaseOld = () => resolve(deliver());
            });
        };
        const member = (hostUserId: string) => ({
            hostUserId,
            members: [
                {
                    userId: hostUserId,
                    username: hostUserId,
                    joinedAt: "2026-08-20T12:00:00.000Z",
                    isHost: true,
                    isConnected: true,
                },
            ],
        });

        const delayed = publisher.publishMembership(
            "group-1",
            member("old-host"),
            { fencingToken: 1, publicationId: "publication-1" },
        );
        await oldStarted;
        await publisher.publishMembership("group-1", member("new-host"), {
            fencingToken: 2,
            publicationId: "publication-2",
        });
        await publisher.publishMembership("group-1", member("new-host"), {
            fencingToken: 2,
            publicationId: "publication-2",
        });
        releaseOld();
        await delayed;

        expect(received).toEqual(["new-host"]);
        await publisher.stop();
        await receiver.stop();
    });

    it("drops an ended-group watermark and evicts the least-recently-used group", async () => {
        const server = new DeterministicRedisServer();
        const { ListenTogetherClusterSync } = loadCluster(server);
        const publisher = new ListenTogetherClusterSync();
        const receiver = new ListenTogetherClusterSync();
        await receiver.start(jest.fn(), jest.fn());
        await publisher.start(jest.fn());

        await publisher.publishSnapshot(
            "ended-group",
            { id: "ended-group", playback: {}, members: [] } as any,
            { fencingToken: 1, publicationId: "snapshot" },
        );
        await publisher.publishEnded("ended-group", {
            fencingToken: 2,
            publicationId: "ended",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect((receiver as any).eventWatermarks.has("ended-group")).toBe(
            false,
        );

        for (let index = 0; index <= 10_000; index += 1) {
            await publisher.publishSnapshot(
                `group-${index}`,
                { id: `group-${index}`, playback: {}, members: [] } as any,
                { fencingToken: 1, publicationId: `publication-${index}` },
            );
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect((receiver as any).eventWatermarks.size).toBe(10_000);
        expect((receiver as any).eventWatermarks.has("group-0")).toBe(false);
        expect((receiver as any).eventWatermarks.has("group-10000")).toBe(true);

        await publisher.stop();
        await receiver.stop();
    });

    it("expires idle watermarks so durable authority can admit a lower token", async () => {
        const server = new DeterministicRedisServer();
        const { ListenTogetherClusterSync } = loadCluster(server);
        const publisher = new ListenTogetherClusterSync();
        const receiver = new ListenTogetherClusterSync();
        const received: string[] = [];
        let now = new Date("2026-08-20T12:00:00.000Z").getTime();
        jest.spyOn(Date, "now").mockImplementation(() => now);
        await receiver.start(
            jest.fn(),
            jest.fn(),
            (_groupId, membership) => () => {
                received.push(membership.hostUserId);
            },
        );
        await publisher.start(jest.fn());
        const membership = (hostUserId: string) => ({
            hostUserId,
            members: [],
        });

        await publisher.publishMembership("idle-group", membership("first"), {
            fencingToken: 5,
            publicationId: "first",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(received).toEqual(["first"]);
        now += 6 * 60 * 60 * 1_000 + 1;
        await publisher.publishMembership("idle-group", membership("second"), {
            fencingToken: 1,
            publicationId: "second",
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(received).toEqual(["first", "second"]);
        await publisher.stop();
        await receiver.stop();
    });
});
