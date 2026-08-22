const prisma = {
    user: { findMany: jest.fn() },
};
const redisClient = {
    scanIterator: jest.fn(),
    mGet: jest.fn(),
    set: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../utils/redis", () => ({ redisClient }));

import {
    getFederationPresenceExport,
    readFederationPeerPresenceSnapshots,
} from "../federationPresence";

function asScanIterable(keys: string[]): AsyncIterable<string[]> {
    return {
        async *[Symbol.asyncIterator]() {
            yield keys;
        },
    };
}

const now = new Date("2026-08-22T12:00:00.000Z");

function presenceUser(overrides: Record<string, unknown> = {}) {
    return {
        id: "user-1",
        username: "alice",
        displayName: "Alice",
        settings: {
            shareOnlinePresence: true,
            sharePresenceToPeers: true,
            shareListeningStatus: true,
        },
        playbackStates: [
            {
                playbackType: "track",
                isPlaying: true,
                updatedAt: now,
                currentIndex: 0,
                queue: [
                    {
                        title: "Song",
                        artist: { name: "Artist" },
                        album: { title: "Album" },
                    },
                ],
            },
        ],
        ...overrides,
    };
}

describe("federation presence export", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(now);
        redisClient.scanIterator.mockReturnValue(
            asScanIterable(["social:presence:user:user-1"]),
        );
        redisClient.mGet.mockResolvedValue([String(now.getTime())]);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it.each([
        {
            name: "peer export without online sharing",
            settings: {
                shareOnlinePresence: false,
                sharePresenceToPeers: true,
                shareListeningStatus: true,
            },
            expected: [],
        },
        {
            name: "online sharing without peer export",
            settings: {
                shareOnlinePresence: true,
                sharePresenceToPeers: false,
                shareListeningStatus: true,
            },
            expected: [],
        },
        {
            name: "peer export without track sharing",
            settings: {
                shareOnlinePresence: true,
                sharePresenceToPeers: true,
                shareListeningStatus: false,
            },
            expected: [
                {
                    username: "alice",
                    displayName: "Alice",
                    status: "idle",
                    updatedAt: now.toISOString(),
                },
            ],
        },
        {
            name: "all presence sharing enabled",
            settings: {
                shareOnlinePresence: true,
                sharePresenceToPeers: true,
                shareListeningStatus: true,
            },
            expected: [
                {
                    username: "alice",
                    displayName: "Alice",
                    status: "playing",
                    track: {
                        title: "Song",
                        artist: "Artist",
                        album: "Album",
                    },
                    updatedAt: now.toISOString(),
                },
            ],
        },
    ])("filters $name at the source", async ({ settings, expected }) => {
        prisma.user.findMany.mockResolvedValue([presenceUser({ settings })]);

        await expect(getFederationPresenceExport()).resolves.toEqual({
            users: expected,
        });
        expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    settings: {
                        is: {
                            shareOnlinePresence: true,
                            sharePresenceToPeers: true,
                        },
                    },
                }),
                take: 100,
            }),
        );
    });
});

describe("federation peer presence snapshots", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns only schema-valid snapshots whose key matches the peer", async () => {
        redisClient.scanIterator.mockReturnValue(
            asScanIterable([
                "federation:social:presence:v1:peer-1",
                "federation:social:presence:v1:peer-2",
                "federation:social:presence:v1:peer-3",
            ]),
        );
        redisClient.mGet.mockResolvedValue([
            JSON.stringify({
                peerId: "peer-1",
                peerName: "Remote One",
                users: [],
                fetchedAt: "2026-08-22T12:00:00.000Z",
            }),
            "not-json",
            JSON.stringify({
                peerId: "wrong-peer",
                peerName: "Remote Three",
                users: [],
                fetchedAt: "2026-08-22T12:00:00.000Z",
            }),
        ]);

        await expect(readFederationPeerPresenceSnapshots()).resolves.toEqual([
            {
                peerId: "peer-1",
                peerName: "Remote One",
                users: [],
                fetchedAt: "2026-08-22T12:00:00.000Z",
            },
        ]);
    });
});
