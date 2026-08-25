import { Request, Response } from "express";

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: (_req: Request, _res: Response, next: () => void) =>
        next(),
    subsonicRateLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: jest.fn(() => "json"),
    sendSubsonicError: jest.fn(),
    sendSubsonicSuccess: jest.fn(),
    SubsonicErrorCode: {
        GENERIC: 0,
        MISSING_PARAMETER: 10,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        playbackState: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        bookmark: {
            findMany: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            groupBy: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
        },
        likedTrack: {
            findMany: jest.fn(),
        },
        trackRating: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        play: {
            groupBy: jest.fn(),
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        getActive: jest.fn(),
        getWaiting: jest.fn(),
        getDelayed: jest.fn(),
        add: jest.fn(),
    },
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

import { prisma } from "../../utils/db";
import { scanQueue } from "../../workers/queues";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
    handleCreateBookmark,
    handleDeleteBookmark,
    handleGetBookmarks,
    handleGetPlayQueue,
    handleGetPlayQueueByIndex,
    handleGetScanStatus,
    resetSubsonicScanStartCooldownForTests,
    handleSavePlayQueue,
    handleSavePlayQueueByIndex,
    handleStartScan,
    handleGetStarred2,
} from "../subsonic";

function buildReq(query: Record<string, unknown>): Request {
    return {
        query,
        user: {
            id: "user-1",
            username: "alice",
            role: "user",
        },
    } as unknown as Request;
}

function buildRes(): Response {
    return {} as Response;
}

function buildQueueTrack(id: string, title: string) {
    return {
        id,
        title,
        trackNo: 1,
        discNo: 1,
        duration: 180,
        fileSize: 1700,
        mime: "audio/mpeg",
        filePath: `Artist One/Album One/${title}.mp3`,
        album: {
            id: "album-1",
            title: "Album One",
            year: 2023,
            coverUrl: null,
            location: "LIBRARY",
            genres: [],
            userGenres: [],
            artist: { id: "artist-1", name: "Artist One" },
        },
    };
}

describe("subsonic state/admin compatibility handlers", () => {
    const bookmarkModel = (
        prisma as unknown as {
            bookmark: {
                findMany: jest.Mock;
                upsert: jest.Mock;
                deleteMany: jest.Mock;
            };
        }
    ).bookmark;
    const mockPlaybackFindUnique = prisma.playbackState.findUnique as jest.Mock;
    const mockPlaybackUpsert = prisma.playbackState.upsert as jest.Mock;
    const mockBookmarkFindMany = bookmarkModel.findMany as jest.Mock;
    const mockBookmarkUpsert = bookmarkModel.upsert as jest.Mock;
    const mockBookmarkDeleteMany = bookmarkModel.deleteMany as jest.Mock;
    const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackGroupBy = prisma.track.groupBy as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockGetActive = scanQueue.getActive as jest.Mock;
    const mockGetWaiting = scanQueue.getWaiting as jest.Mock;
    const mockGetDelayed = scanQueue.getDelayed as jest.Mock;
    const mockScanAdd = scanQueue.add as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSubsonicScanStartCooldownForTests();
        mockPlaybackFindUnique.mockResolvedValue(null);
        mockBookmarkFindMany.mockResolvedValue([]);
        mockBookmarkUpsert.mockResolvedValue(null);
        mockBookmarkDeleteMany.mockResolvedValue({ count: 0 });
        mockTrackFindUnique.mockResolvedValue(null);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackGroupBy.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockPlayGroupBy.mockResolvedValue([]);
        mockGetActive.mockResolvedValue([]);
        mockGetWaiting.mockResolvedValue([]);
        mockGetDelayed.mockResolvedValue([]);
        mockScanAdd.mockResolvedValue({ id: "job-1" });
    });

    it.each([
        ["classic", handleGetPlayQueue, "playQueue", "current"],
        [
            "index-based",
            handleGetPlayQueueByIndex,
            "playQueueByIndex",
            "currentIndex",
        ],
    ])(
        "returns an empty %s play queue when no playback state exists",
        async (_label, handler, responseKey, currentKey) => {
            await handler(buildReq({}), buildRes());

            const payload = mockSendSuccess.mock.calls[0][1] as Record<
                string,
                unknown
            >;
            const queue = payload[responseKey] as Record<string, unknown>;
            expect(queue).toEqual({
                position: 0,
                username: "alice",
                changed: expect.stringMatching(
                    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
                ),
                changedBy: "soundspan",
                entry: [],
            });
            expect(queue).not.toHaveProperty(currentKey);
        },
    );

    it("returns the classic play queue current entry as a song ID", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [{ id: "tr-track-1" }, { id: "tr-track-2" }],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
            buildQueueTrack("track-2", "Song Two"),
        ]);

        await handleGetPlayQueue(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: "tr-track-2",
                    position: 12000,
                    username: "alice",
                    changed: "2026-08-18T12:00:00.000Z",
                    changedBy: "soundspan",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns the index-based queue envelope and currentIndex", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [{ id: "tr-track-1" }, { id: "tr-track-2" }],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
            buildQueueTrack("track-2", "Song Two"),
        ]);

        await handleGetPlayQueueByIndex(buildReq({ index: "2" }), buildRes());

        const payload = mockSendSuccess.mock.calls[0][1] as Record<
            string,
            unknown
        >;
        expect(payload).toEqual({
            playQueueByIndex: expect.objectContaining({
                currentIndex: 1,
                position: 12000,
                username: "alice",
                changed: "2026-08-18T12:00:00.000Z",
                changedBy: "soundspan",
                entry: expect.any(Array),
            }),
        });
        expect(payload).not.toHaveProperty("playQueue");
    });

    it("resolves indexed play queue from indexed legacy device id", async () => {
        await handleGetPlayQueueByIndex(
            buildReq({
                index: "2",
            }),
            buildRes(),
        );

        expect(mockPlaybackFindUnique).toHaveBeenCalledWith({
            where: {
                userId_deviceId: {
                    userId: "user-1",
                    deviceId: "legacy-2",
                },
            },
        });
    });

    it("saves play queue into playback state", async () => {
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                duration: 180,
                album: {
                    id: "album-1",
                    title: "Album One",
                    coverUrl: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSavePlayQueue(
            buildReq({
                id: ["tr-track-1"],
                current: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    playbackType: "track",
                    currentTime: 12,
                }),
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it.each(["tr-track-2", "track-2"])(
        "resolves classic savePlayQueue current song ID %s to its first queue index",
        async (current) => {
            mockTrackFindMany.mockResolvedValue([
                buildQueueTrack("track-1", "Song One"),
                buildQueueTrack("track-2", "Song Two"),
            ]);

            await handleSavePlayQueue(
                buildReq({
                    id: ["tr-track-1", "tr-track-2", "tr-track-2"],
                    current,
                    position: "12000",
                }),
                buildRes(),
            );

            expect(mockPlaybackUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        currentIndex: 1,
                        trackId: "track-2",
                    }),
                }),
            );
        },
    );

    it("retains legacy integer current semantics when no submitted song ID matches", async () => {
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-a", "Song A"),
            buildQueueTrack("track-b", "Song B"),
        ]);

        await handleSavePlayQueue(
            buildReq({
                id: ["tr-track-a", "tr-track-b"],
                current: "1",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    currentIndex: 1,
                    trackId: "track-b",
                }),
            }),
        );
    });

    it("saves indexed play queue into indexed legacy device id", async () => {
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                duration: 180,
                album: {
                    id: "album-1",
                    title: "Album One",
                    coverUrl: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSavePlayQueueByIndex(
            buildReq({
                index: "3",
                id: ["tr-track-1"],
                currentIndex: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId_deviceId: {
                        userId: "user-1",
                        deviceId: "legacy-3",
                    },
                },
            }),
        );
    });

    it.each([
        ["missing", undefined],
        ["negative", "-1"],
        ["equal to queue length", "1"],
        ["non-integer", "0.5"],
    ])(
        "rejects %s savePlayQueueByIndex currentIndex with error 10",
        async (_label, currentIndex) => {
            mockTrackFindMany.mockResolvedValue([
                buildQueueTrack("track-1", "Song One"),
            ]);

            await handleSavePlayQueueByIndex(
                buildReq({
                    id: ["tr-track-1"],
                    ...(currentIndex === undefined ? {} : { currentIndex }),
                }),
                buildRes(),
            );

            expect(mockPlaybackUpsert).not.toHaveBeenCalled();
            expect(mockSendError).toHaveBeenCalledWith(
                expect.anything(),
                10,
                "Required parameter 'currentIndex' is missing or invalid",
                "json",
                undefined,
            );
        },
    );

    it("does not treat classic current as savePlayQueueByIndex currentIndex", async () => {
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
        ]);

        await handleSavePlayQueueByIndex(
            buildReq({ id: ["tr-track-1"], current: "0" }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).not.toHaveBeenCalled();
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'currentIndex' is missing or invalid",
            "json",
            undefined,
        );
    });

    it("clears savePlayQueueByIndex without requiring currentIndex", async () => {
        await handleSavePlayQueueByIndex(buildReq({}), buildRes());

        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    currentIndex: 0,
                    trackId: null,
                }),
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("remaps classic current after an earlier queue entry is filtered", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [
                { id: "tr-track-removed" },
                { id: "tr-track-2" },
                { id: "tr-track-3" },
            ],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-2", "Song Two"),
            buildQueueTrack("track-3", "Song Three"),
        ]);

        await handleGetPlayQueue(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: "tr-track-2",
                    position: 12000,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("omits classic current and resets position when it is filtered", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [
                { id: "tr-track-1" },
                { id: "tr-track-removed" },
                { id: "tr-track-3" },
            ],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
            buildQueueTrack("track-3", "Song Three"),
        ]);

        await handleGetPlayQueue(buildReq({}), buildRes());

        const payload = mockSendSuccess.mock.calls[0][1] as {
            playQueue: Record<string, unknown>;
        };
        expect(payload.playQueue).not.toHaveProperty("current");
        expect(payload.playQueue.position).toBe(0);
    });

    it("moves index-based current to the next survivor when current is filtered", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [
                { id: "tr-track-1" },
                { id: "tr-track-removed" },
                { id: "tr-track-3" },
            ],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
            buildQueueTrack("track-3", "Song Three"),
        ]);

        await handleGetPlayQueueByIndex(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueueByIndex: expect.objectContaining({
                    currentIndex: 1,
                    position: 0,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("falls back to index zero when no entry survives after current", async () => {
        mockPlaybackFindUnique.mockResolvedValue({
            queue: [{ id: "tr-track-1" }, { id: "tr-track-removed" }],
            currentIndex: 1,
            currentTime: 12,
            updatedAt: new Date("2026-08-18T12:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            buildQueueTrack("track-1", "Song One"),
        ]);

        await handleGetPlayQueueByIndex(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueueByIndex: expect.objectContaining({
                    currentIndex: 0,
                    position: 0,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns scan status from active/waiting jobs", async () => {
        mockGetActive.mockResolvedValue([{ progress: () => 42 }]);
        mockGetWaiting.mockResolvedValue([{ id: "job-2" }]);
        mockGetDelayed.mockResolvedValue([]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: expect.objectContaining({
                    scanning: true,
                    count: 42,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns persisted bookmarks with song metadata", async () => {
        mockBookmarkFindMany.mockResolvedValue([
            {
                positionSeconds: 12.345,
                updatedAt: new Date("2026-03-01T12:00:00.000Z"),
                track: {
                    id: "track-1",
                    title: "Song One",
                    trackNo: 1,
                    discNo: 1,
                    duration: 180,
                    fileSize: 1700,
                    mime: "audio/mpeg",
                    filePath: "Artist One/Album One/01 Song One.mp3",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        year: 2023,
                        coverUrl: null,
                        location: "LIBRARY",
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
            },
        ]);

        await handleGetBookmarks(buildReq({}), buildRes());

        expect(mockBookmarkFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: "user-1",
                    track: {
                        removedAt: null,
                        AND: expect.any(Array),
                        album: { location: { in: ["LIBRARY", "FEDERATED"] } },
                    },
                },
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                bookmarks: {
                    bookmark: [
                        expect.objectContaining({
                            position: 12345,
                            entry: expect.objectContaining({
                                id: "tr-track-1",
                                title: "Song One",
                                album: "Album One",
                                artist: "Artist One",
                            }),
                        }),
                    ],
                },
            }),
            "json",
            undefined,
        );
    });

    it("upserts bookmark state for an existing track", async () => {
        mockTrackFindUnique.mockResolvedValue({
            id: "track-1",
        });

        await handleCreateBookmark(
            buildReq({ id: "tr-track-1", position: "12345" }),
            buildRes(),
        );

        expect(mockTrackFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "track-1",
                    removedAt: null,
                    AND: expect.any(Array),
                    album: { location: { in: ["LIBRARY", "FEDERATED"] } },
                },
            }),
        );
        expect(mockBookmarkUpsert).toHaveBeenCalledWith({
            where: {
                userId_trackId: {
                    userId: "user-1",
                    trackId: "track-1",
                },
            },
            create: {
                userId: "user-1",
                trackId: "track-1",
                positionSeconds: 12.345,
            },
            update: {
                positionSeconds: 12.345,
            },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("deletes bookmark state for the authenticated user", async () => {
        await handleDeleteBookmark(buildReq({ id: "tr-track-1" }), buildRes());

        expect(mockBookmarkDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-1",
            },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("returns not-found for bookmark requests when track does not exist", async () => {
        await handleCreateBookmark(
            buildReq({ id: "tr-track-missing", position: "1000" }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("starts scan by enqueueing a scan job", async () => {
        await handleStartScan(buildReq({}), buildRes());

        expect(mockScanAdd).toHaveBeenCalledWith(
            "scan",
            {
                userId: "user-1",
                musicPath: "/music",
            },
            {
                removeOnComplete: true,
                removeOnFail: 50,
            },
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: expect.objectContaining({
                    scanning: true,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("does not enqueue scan when scan jobs are already pending", async () => {
        mockGetActive.mockResolvedValue([{}]);
        mockGetWaiting.mockResolvedValue([{}]);
        mockGetDelayed.mockResolvedValue([]);

        await handleStartScan(buildReq({}), buildRes());

        expect(mockScanAdd).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: expect.objectContaining({
                    scanning: true,
                    count: 0,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when getPlayQueue fails to load state", async () => {
        mockPlaybackFindUnique.mockRejectedValueOnce(new Error("db down"));

        await handleGetPlayQueue(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch play queue",
            "json",
            undefined,
        );
    });

    it("returns generic error when savePlayQueue encounters a storage failure", async () => {
        mockTrackFindMany.mockRejectedValueOnce(new Error("storage failure"));

        await handleSavePlayQueue(
            buildReq({
                id: ["tr-track-1"],
                current: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to save play queue",
            "json",
            undefined,
        );
    });

    it("returns not-found when savePlayQueue receives malformed track IDs", async () => {
        await handleSavePlayQueue(
            buildReq({
                id: ["bad-track-id"],
                current: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("returns not-found when savePlayQueue references tracks outside the library", async () => {
        await handleSavePlayQueue(
            buildReq({
                id: ["tr-track-missing"],
                current: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("caps legacy playback index at 100 when saving play queue", async () => {
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                duration: 180,
                album: {
                    id: "album-1",
                    title: "Album One",
                    coverUrl: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSavePlayQueueByIndex(
            buildReq({
                index: "420",
                id: ["tr-track-1"],
                currentIndex: "0",
                position: "12000",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId_deviceId: {
                        userId: "user-1",
                        deviceId: "legacy-100",
                    },
                },
            }),
        );
    });

    it("sorts starred albums and artists by most recent starred timestamp", async () => {
        mockLikedTrackFindMany.mockResolvedValue([
            {
                track: {
                    id: "track-2",
                    title: "Song Two",
                    trackNo: 2,
                    discNo: 1,
                    duration: 210,
                    fileSize: 1900,
                    mime: "audio/mpeg",
                    filePath: "Artist Two/Album Two/02 Song Two.mp3",
                    album: {
                        id: "album-2",
                        title: "Album Two",
                        year: 2024,
                        coverUrl: null,
                        location: "LIBRARY",
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-2",
                            name: "Artist Two",
                        },
                    },
                },
                likedAt: new Date("2026-02-01T00:00:00.000Z"),
            },
            {
                track: {
                    id: "track-1",
                    title: "Song One",
                    trackNo: 1,
                    discNo: 1,
                    duration: 180,
                    fileSize: 1700,
                    mime: "audio/mpeg",
                    filePath: "Artist One/Album One/01 Song One.mp3",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        year: 2023,
                        coverUrl: null,
                        location: "LIBRARY",
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
                likedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-2",
                title: "Album Two",
                year: 2024,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                coverUrl: null,
                location: "LIBRARY",
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-2",
                    name: "Artist Two",
                },
            },
            {
                id: "album-1",
                title: "Album One",
                year: 2023,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                coverUrl: null,
                location: "LIBRARY",
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
            },
        ]);
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-2",
                name: "Artist Two",
                heroUrl: null,
                _count: { albums: 1 },
            },
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                _count: { albums: 1 },
            },
        ]);
        mockTrackGroupBy.mockResolvedValue([
            {
                albumId: "album-2",
                _count: { _all: 2 },
                _sum: { duration: 420 },
            },
            {
                albumId: "album-1",
                _count: { _all: 1 },
                _sum: { duration: 180 },
            },
        ]);

        await handleGetStarred2(buildReq({}), buildRes());

        expect(mockLikedTrackFindMany).toHaveBeenCalledTimes(1);
        const albumQuery = mockAlbumFindMany.mock.calls[0][0];
        expect(albumQuery.select).not.toHaveProperty("tracks");
        const artistQuery = mockArtistFindMany.mock.calls[0][0];
        expect(artistQuery.select).toMatchObject({
            _count: {
                select: {
                    albums: {
                        where: { location: { in: ["LIBRARY", "FEDERATED"] } },
                    },
                },
            },
        });
        expect(artistQuery.select).not.toHaveProperty("albums");
        expect(mockTrackGroupBy).toHaveBeenCalledWith({
            by: ["albumId"],
            where: {
                removedAt: null,
                AND: expect.any(Array),
                album: { location: { in: ["LIBRARY", "FEDERATED"] } },
                albumId: { in: ["album-2", "album-1"] },
            },
            _count: { _all: true },
            _sum: { duration: true },
        });

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                starred2: expect.objectContaining({
                    artist: [
                        expect.objectContaining({
                            id: "ar-artist-2",
                        }),
                        expect.objectContaining({
                            id: "ar-artist-1",
                        }),
                    ],
                    album: [
                        expect.objectContaining({
                            id: "al-album-2",
                            songCount: 2,
                            duration: 420,
                        }),
                        expect.objectContaining({
                            id: "al-album-1",
                        }),
                    ],
                }),
            }),
            "json",
            undefined,
        );
    });
});
