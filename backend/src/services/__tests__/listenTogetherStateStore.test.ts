import { DeterministicRedisServer } from "./support/deterministicRedis";

function previousIsRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function previousIsFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function previousIsOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === "string";
}

function previousIsOptionalNumberOrNull(value: unknown): boolean {
    return (
        value === undefined || value === null || previousIsFiniteNumber(value)
    );
}

function previousIsMediaSource(value: unknown): boolean {
    return (
        value === "local" ||
        value === "tidal" ||
        value === "youtube" ||
        value === "youtube-direct"
    );
}

function previousAcceptsProvider(value: unknown): boolean {
    if (value === undefined) return true;
    if (!previousIsRecord(value) || !previousIsMediaSource(value.source)) {
        return false;
    }
    return (
        previousIsOptionalString(value.providerTrackId) &&
        (value.tidalTrackId === undefined ||
            previousIsFiniteNumber(value.tidalTrackId)) &&
        previousIsOptionalString(value.youtubeVideoId) &&
        (value.youtubeAudioFormat === undefined ||
            value.youtubeAudioFormat === "mp4" ||
            value.youtubeAudioFormat === "webm")
    );
}

function previousReleaseAcceptsQueueItem(value: unknown): boolean {
    if (
        !previousIsRecord(value) ||
        !previousIsRecord(value.artist) ||
        !previousIsRecord(value.album)
    ) {
        return false;
    }
    const validSources =
        (value.mediaSource === undefined ||
            previousIsMediaSource(value.mediaSource)) &&
        (value.streamSource === undefined ||
            (previousIsMediaSource(value.streamSource) &&
                value.streamSource !== "local")) &&
        (value.originSource === undefined ||
            value.originSource === "local" ||
            value.originSource === "tidal" ||
            value.originSource === "youtube");
    return (
        typeof value.id === "string" &&
        typeof value.title === "string" &&
        previousIsFiniteNumber(value.duration) &&
        value.duration >= 0 &&
        previousIsOptionalNumberOrNull(value.loudnessLufs) &&
        previousIsOptionalNumberOrNull(value.truePeakDb) &&
        typeof value.artist.id === "string" &&
        typeof value.artist.name === "string" &&
        typeof value.album.id === "string" &&
        typeof value.album.title === "string" &&
        (value.album.coverArt === null ||
            typeof value.album.coverArt === "string") &&
        previousIsOptionalNumberOrNull(value.album.albumLoudnessLufs) &&
        previousIsOptionalNumberOrNull(value.album.albumTruePeakDb) &&
        validSources &&
        previousAcceptsProvider(value.provider) &&
        previousIsOptionalString(value.localTrackId) &&
        previousIsOptionalString(value.trackTidalId) &&
        previousIsOptionalString(value.trackYtMusicId) &&
        previousIsOptionalString(value.trackMappingId) &&
        (value.tidalTrackId === undefined ||
            previousIsFiniteNumber(value.tidalTrackId)) &&
        previousIsOptionalString(value.youtubeVideoId) &&
        (value.youtubeAudioFormat === undefined ||
            value.youtubeAudioFormat === "mp4" ||
            value.youtubeAudioFormat === "webm")
    );
}

function previousReleaseAcceptsSnapshot(value: unknown): boolean {
    if (!previousIsRecord(value) || !previousIsRecord(value.playback)) {
        return false;
    }
    const playback = value.playback;
    if (
        !Array.isArray(playback.queue) ||
        playback.queue.length > 500 ||
        !playback.queue.every(previousReleaseAcceptsQueueItem)
    ) {
        return false;
    }
    const index = playback.currentIndex;
    const validIndex =
        Number.isSafeInteger(index) &&
        (index as number) >= 0 &&
        (playback.queue.length === 0
            ? index === 0
            : (index as number) < playback.queue.length);
    return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.joinCode === "string" &&
        (value.groupType === "host-follower" ||
            value.groupType === "collaborative") &&
        (value.visibility === "public" || value.visibility === "private") &&
        typeof value.isActive === "boolean" &&
        typeof value.hostUserId === "string" &&
        (value.syncState === "idle" ||
            value.syncState === "waiting" ||
            value.syncState === "playing" ||
            value.syncState === "paused") &&
        Array.isArray(value.members) &&
        value.members.length <= 10_000 &&
        validIndex &&
        typeof playback.isPlaying === "boolean" &&
        previousIsFiniteNumber(playback.positionMs) &&
        playback.positionMs >= 0 &&
        previousIsFiniteNumber(playback.serverTime) &&
        playback.serverTime >= 0 &&
        Number.isSafeInteger(playback.stateVersion) &&
        (playback.stateVersion as number) >= 0 &&
        (playback.trackId === null || typeof playback.trackId === "string")
    );
}

describe("listenTogetherStateStore", () => {
    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadStateStore(options?: {
        enabled?: boolean;
        keyPrefix?: string;
        ttlSeconds?: number;
        server?: DeterministicRedisServer;
    }) {
        jest.resetModules();
        const server = options?.server ?? new DeterministicRedisServer();
        const redisClient = server.createClient();
        const createIORedisClient = jest.fn(() => redisClient);
        const logger: any = { warn: jest.fn() };
        logger.child = jest.fn(() => logger);
        jest.doMock("../../utils/ioredis", () => ({ createIORedisClient }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: {
                    stateStoreEnabled: options?.enabled !== false,
                    stateStoreKeyPrefix:
                        options?.keyPrefix ?? "listen-together:state",
                    stateStoreTtlSeconds: options?.ttlSeconds ?? 21_600,
                    publicationDeadlineMs: 1_000,
                    mutationLockPrefix: "listen-together:mutation-lock",
                },
            },
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module =
            require("../listenTogetherStateStore") as typeof import("../listenTogetherStateStore");
        return {
            ...module,
            createIORedisClient,
            logger,
            redisClient,
            server,
        };
    }

    const snapshot = (
        groupId: string = "group-1",
        stateVersion: number = 12,
        serverTime: number = 34_567,
    ) => ({
        id: groupId,
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
            stateVersion,
            serverTime,
            trackId: null,
        },
        members: [],
    });

    it("does not access Redis when the state store is disabled", async () => {
        const { listenTogetherStateStore, createIORedisClient } =
            loadStateStore({ enabled: false });

        await expect(
            listenTogetherStateStore.getSnapshot("group-1"),
        ).resolves.toBeNull();
        await expect(
            listenTogetherStateStore.setSnapshot("group-1", snapshot() as any),
        ).resolves.toBe("accepted");
        await expect(
            listenTogetherStateStore.deleteSnapshot("group-1"),
        ).resolves.toBe("accepted");
        await expect(
            listenTogetherStateStore.claimFence("group-1"),
        ).resolves.toBe("accepted");
        expect(createIORedisClient).not.toHaveBeenCalled();
    });

    it("reads and writes through the configured keys and TTL script", async () => {
        const loaded = loadStateStore({
            keyPrefix: "test-prefix",
            ttlSeconds: 123,
        });
        loaded.server.write("test-prefix:group-1", JSON.stringify(snapshot()));
        loaded.server.write(
            "listen-together:mutation-lock:fencing-token:group-1",
            "17",
        );

        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).resolves.toEqual(snapshot());
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot() as any,
                17,
            ),
        ).resolves.toBe("accepted");

        const write = loaded.server.commandLog.find(
            (command) =>
                command.name === "EVAL" &&
                String(command.args[0]).includes(
                    "listen-together:set-snapshot-if-current",
                ),
        );
        expect(write?.args.slice(1)).toEqual([
            3,
            "test-prefix:group-1",
            "test-prefix:fence:group-1",
            "listen-together:mutation-lock:fencing-token:group-1",
            JSON.stringify(snapshot()),
            "123",
            "12",
            "34567",
            "17",
        ]);
    });

    it("accepts peer playback source metadata in persisted queue items", async () => {
        const loaded = loadStateStore();
        const value = snapshot();
        value.playback.queue = [
            {
                id: "peer-track-1",
                title: "Peer Song",
                duration: 180,
                artist: { id: "artist-1", name: "Artist" },
                album: { id: "album-1", title: "Album", coverArt: null },
                mediaSource: "peer",
                streamSource: "peer",
                originSource: "peer",
                peerOnline: true,
            } as never,
        ];
        loaded.server.write(
            "listen-together:state:group-1",
            JSON.stringify(value),
        );

        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).resolves.toEqual(value);
    });

    it("writes peer snapshots in the previous release shape and restores peer origin", async () => {
        const loaded = loadStateStore();
        const value = snapshot();
        value.playback.queue = [
            {
                id: "peer-track-1",
                title: "Peer Song",
                duration: 180,
                artist: { id: "artist-1", name: "Artist" },
                album: { id: "album-1", title: "Album", coverArt: null },
                mediaSource: "peer",
                provider: { source: "peer" },
                streamSource: "peer",
                originSource: "peer",
                peerOnline: true,
            } as never,
        ];

        await loaded.listenTogetherStateStore.setSnapshot(
            "group-1",
            value as never,
        );

        const write = loaded.server.commandLog.find(
            (command) =>
                command.name === "EVAL" &&
                String(command.args[0]).includes(
                    "listen-together:set-snapshot-if-current",
                ),
        );
        const persisted = JSON.parse(String(write?.args[5])) as any;
        expect(previousReleaseAcceptsSnapshot(persisted)).toBe(true);
        expect(persisted.playback.queue[0]).toMatchObject({
            mediaSource: "local",
            provider: { source: "local" },
            originSource: "local",
            actualOriginSource: "peer",
        });
        expect(persisted.playback.queue[0].streamSource).toBeUndefined();
        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).resolves.toMatchObject({
            playback: {
                queue: [
                    {
                        mediaSource: "peer",
                        provider: { source: "peer" },
                        streamSource: "peer",
                        originSource: "peer",
                    },
                ],
            },
        });
    });

    it("rejects malformed JSON as transient and suppresses repeat warnings", async () => {
        const loaded = loadStateStore();
        loaded.server.write("listen-together:state:group-1", "{");

        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
        expect(loaded.logger.warn).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed shapes and mismatched group identities", async () => {
        const loaded = loadStateStore();
        loaded.server.write(
            "listen-together:state:group-1",
            JSON.stringify(snapshot("other-group")),
        );
        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });

        loaded.server.write(
            "listen-together:state:group-1",
            JSON.stringify({ id: "group-1", playback: {}, members: {} }),
        );
        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
        expect(loaded.logger.warn).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a null member", { members: [null] }],
        ["an array playback value", { playback: [] }],
        [
            "a non-numeric playback version",
            { playback: { stateVersion: "12" } },
        ],
    ])("rejects nested snapshot corruption with %s", async (_name, corrupt) => {
        const loaded = loadStateStore();
        const valid = snapshot();
        const corruptPlayback =
            "playback" in corrupt ? corrupt.playback : undefined;
        loaded.server.write(
            "listen-together:state:group-1",
            JSON.stringify({
                ...valid,
                ...corrupt,
                playback:
                    corruptPlayback !== undefined &&
                    !Array.isArray(corruptPlayback)
                        ? { ...valid.playback, ...corruptPlayback }
                        : (corruptPlayback ?? valid.playback),
            }),
        );

        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    });

    it("propagates authoritative Redis read and write failures", async () => {
        const loaded = loadStateStore();
        loaded.server.beforeCommand = (command) => {
            if (command.name === "GET") throw new Error("redis-get-down");
            if (command.name === "EVAL") throw new Error("redis-eval-down");
        };

        await expect(
            loaded.listenTogetherStateStore.getSnapshot("group-1"),
        ).rejects.toThrow("redis-get-down");
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot() as any,
            ),
        ).rejects.toThrow("redis-eval-down");
        expect(loaded.logger.warn).toHaveBeenCalledTimes(1);
    });

    it("executes token, version, and producer-time rejection semantics", async () => {
        const loaded = loadStateStore();
        await loaded.redisClient.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot("group-1", 20, 2_000) as any,
                1,
            ),
        ).resolves.toBe("accepted");
        await loaded.redisClient.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot("group-1", 19, 3_000) as any,
                2,
            ),
        ).resolves.toBe("stale");
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot("group-1", 21, 4_000) as any,
                1,
            ),
        ).resolves.toBe("stale");
    });

    it("guards deletion and fence claims with the allocation counter", async () => {
        const loaded = loadStateStore();
        await loaded.redisClient.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );
        await loaded.redisClient.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );

        await expect(
            loaded.listenTogetherStateStore.claimFence("group-1", 1),
        ).resolves.toBe("stale");
        await expect(
            loaded.listenTogetherStateStore.deleteSnapshot("group-1", 1),
        ).resolves.toBe("stale");
        await expect(
            loaded.listenTogetherStateStore.claimFence("group-1", 2),
        ).resolves.toBe("accepted");
    });

    it("rejects future tokens and permits only token zero before allocation", async () => {
        const loaded = loadStateStore();

        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot() as any,
                9,
            ),
        ).resolves.toBe("stale");
        await expect(
            loaded.listenTogetherStateStore.setSnapshot(
                "group-1",
                snapshot() as any,
                0,
            ),
        ).resolves.toBe("accepted");
        await loaded.redisClient.incr(
            "listen-together:mutation-lock:fencing-token:group-1",
        );
        await expect(
            loaded.listenTogetherStateStore.claimFence("group-1", 2),
        ).resolves.toBe("stale");
        await expect(
            loaded.listenTogetherStateStore.claimFence("group-1", 1),
        ).resolves.toBe("accepted");
    });

    it("validates cluster events against the current counter and exact snapshot order", async () => {
        const loaded = loadStateStore();
        const counterKey =
            "listen-together:mutation-lock:fencing-token:group-1";
        await loaded.redisClient.incr(counterKey);
        await loaded.listenTogetherStateStore.setSnapshot(
            "group-1",
            snapshot("group-1", 12, 34_567) as any,
            1,
        );

        await expect(
            loaded.listenTogetherStateStore.validatePublication(
                "group-1",
                "group-snapshot",
                1,
                snapshot() as any,
            ),
        ).resolves.toBe(true);
        await loaded.redisClient.incr(counterKey);
        await expect(
            loaded.listenTogetherStateStore.validatePublication(
                "group-1",
                "group-snapshot",
                1,
                snapshot() as any,
            ),
        ).resolves.toBe(false);
    });

    it("disconnects an initialized client and tolerates an unused stop", async () => {
        const unused = loadStateStore();
        const unusedDisconnect = jest.spyOn(unused.redisClient, "disconnect");
        unused.listenTogetherStateStore.stop();
        expect(unusedDisconnect).not.toHaveBeenCalled();

        const loaded = loadStateStore();
        const disconnect = jest.spyOn(loaded.redisClient, "disconnect");
        await loaded.listenTogetherStateStore.getSnapshot("group-1");
        loaded.listenTogetherStateStore.stop();
        expect(disconnect).toHaveBeenCalledTimes(1);
    });
});
