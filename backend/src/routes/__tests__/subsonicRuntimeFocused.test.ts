import { Request, Response } from "express";

jest.mock("../../middleware/subsonicAuth", () => ({
    requireSubsonicAuth: (_req: Request, _res: Response, next: () => void) => next(),
    subsonicRateLimiter: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: jest.fn(() => "json"),
    sendSubsonicError: jest.fn(),
    sendSubsonicSuccess: jest.fn(),
    SubsonicErrorCode: {
        GENERIC: 0,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        playbackState: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
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
import { sendSubsonicError, sendSubsonicSuccess } from "../../utils/subsonicResponse";
import {
    handleGetPlayQueue,
    handleGetPlayQueueByIndex,
    handleSavePlayQueue,
    handleSavePlayQueueByIndex,
    handleGetScanStatus,
    handleStartScan,
    resetSubsonicScanStartCooldownForTests,
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

describe("subsonic runtime focused handlers", () => {
    const mockPlaybackFindUnique = prisma.playbackState.findUnique as jest.Mock;
    const mockPlaybackUpsert = prisma.playbackState.upsert as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockScanGetActive = scanQueue.getActive as jest.Mock;
    const mockScanGetWaiting = scanQueue.getWaiting as jest.Mock;
    const mockScanGetDelayed = scanQueue.getDelayed as jest.Mock;
    const mockScanAdd = scanQueue.add as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSubsonicScanStartCooldownForTests();

        mockPlaybackFindUnique.mockResolvedValue({
            queue: [{ id: "tr-track-1" }],
            currentIndex: 2,
            currentTime: 12.4,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                trackNo: 1,
                discNo: 1,
                duration: 180,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/Album One/track1.mp3",
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2020,
                    coverUrl: null,
                    genres: [],
                    userGenres: [],
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);
        mockPlaybackUpsert.mockResolvedValue({});
        mockScanGetActive.mockResolvedValue([]);
        mockScanGetWaiting.mockResolvedValue([]);
        mockScanGetDelayed.mockResolvedValue([]);
        mockScanAdd.mockResolvedValue({ id: "job-1" });
    });

    it("loads legacy-indexed play queue and returns formatted payload", async () => {
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
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: 0,
                    position: 12400,
                    username: "alice",
                    changed: "2026-01-01T00:00:00.000Z",
                    entry: expect.arrayContaining([
                        expect.objectContaining({
                            title: "Song One",
                            id: "tr-track-1",
                            albumId: "al-album-1",
                            artistId: "ar-artist-1",
                            album: "Album One",
                            artist: "Artist One",
                            duration: 180,
                            track: 1,
                            discNumber: 1,
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when indexed play queue lookup fails", async () => {
        mockPlaybackFindUnique.mockRejectedValueOnce(new Error("db down"));

        await handleGetPlayQueueByIndex(buildReq({ index: "2" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch play queue",
            "json",
            undefined,
        );
    });

    it("saves legacy-indexed queue payload to playback state", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-1" }, { id: "track-2" }])
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "Song One",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Album One",
                        coverUrl: null,
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
                {
                    id: "track-2",
                    title: "Song Two",
                    duration: 200,
                    album: {
                        id: "album-2",
                        title: "Album Two",
                        coverUrl: null,
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-2",
                            name: "Artist Two",
                        },
                    },
                },
            ]);

        await handleSavePlayQueueByIndex(
            buildReq({
                index: "3",
                id: ["tr-track-1", "tr-track-2"],
                current: "1",
                position: "10000",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalledWith({
            where: {
                userId_deviceId: {
                    userId: "user-1",
                    deviceId: "legacy-3",
                },
            },
            update: expect.objectContaining({
                playbackType: "track",
                currentIndex: 1,
                currentTime: 10,
                isShuffle: false,
            }),
            create: expect.objectContaining({
                playbackType: "track",
                currentIndex: 1,
                currentTime: 10,
                isShuffle: false,
            }),
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("returns generic error when indexed queue save fails", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-1" }])
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "Song One",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Album One",
                        coverUrl: null,
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
            ]);
        mockPlaybackUpsert.mockRejectedValueOnce(new Error("db down"));

        await handleSavePlayQueueByIndex(
            buildReq({
                index: "3",
                id: ["tr-track-1"],
                current: "0",
                position: "2000",
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

    it("returns active scan status with parsed progress count", async () => {
        mockScanGetActive.mockResolvedValueOnce([{ progress: () => 83.2 }]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: true,
                    count: 83,
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns empty play queue when no playback state exists", async () => {
        mockPlaybackFindUnique.mockResolvedValueOnce(null);

        await handleGetPlayQueue(buildReq({ index: "1" }), buildRes());

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: 0,
                    position: 0,
                    username: "alice",
                    changed: undefined,
                    entry: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("normalizes malformed track ids in queue without dropping the request", async () => {
        mockPlaybackFindUnique.mockResolvedValueOnce({
            queue: [{ id: "ar-artist-1" }],
            currentIndex: 0,
            currentTime: 0,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        mockTrackFindMany.mockResolvedValueOnce([]);

        await handleGetPlayQueueByIndex(buildReq({ index: "0" }), buildRes());

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: {
                        in: ["ar-artist-1"],
                    },
                }),
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    entry: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns not found when save-play-queue payload uses an invalid track id type", async () => {
        await handleSavePlayQueue(
            buildReq({
                id: "ar-artist-1",
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
        expect(mockPlaybackUpsert).not.toHaveBeenCalled();
    });

    it("returns not found when track IDs are missing from library on save", async () => {
        mockTrackFindMany.mockResolvedValueOnce([]);

        await handleSavePlayQueue(
            buildReq({
                id: "tr-track-1",
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
        expect(mockPlaybackUpsert).not.toHaveBeenCalled();
    });

    it("returns generic error when scan-status lookup fails", async () => {
        mockScanGetActive.mockRejectedValueOnce(new Error("redis down"));

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch scan status",
            "json",
            undefined,
        );
    });

    it("queues scan when no pending scan jobs exist and cooldown allows it", async () => {
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
                scanStatus: {
                    scanning: true,
                    count: 0,
                },
            }),
            "json",
            undefined,
        );
    });

    it("does not queue scan when pending jobs are already present", async () => {
        mockScanGetWaiting.mockResolvedValueOnce([{ id: "pending" }]);

        await handleStartScan(buildReq({}), buildRes());

        expect(mockScanAdd).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: false,
                    count: 0,
                },
            }),
            "json",
            undefined,
        );
    });

    it("does not re-queue scan during cooldown when no jobs are pending", async () => {
        mockScanGetActive.mockResolvedValueOnce([]);
        mockScanGetWaiting.mockResolvedValueOnce([]);
        mockScanGetDelayed.mockResolvedValueOnce([]);
        await handleStartScan(buildReq({}), buildRes());
        jest.clearAllMocks();

        mockScanGetActive.mockResolvedValueOnce([]);
        mockScanGetWaiting.mockResolvedValueOnce([]);
        mockScanGetDelayed.mockResolvedValueOnce([]);

        await handleStartScan(buildReq({}), buildRes());

        expect(mockScanAdd).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: false,
                    count: 0,
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when startScan queue check fails", async () => {
        mockScanGetDelayed.mockRejectedValueOnce(new Error("redis down"));

        await handleStartScan(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to start scan",
            "json",
            undefined,
        );
        expect(mockScanAdd).not.toHaveBeenCalled();
    });

    it("normalizes non-numeric scan progress as 0", async () => {
        mockScanGetActive.mockResolvedValueOnce([
            {
                progress: () => "not-a-number",
            },
        ]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: true,
                    count: 0,
                },
            }),
            "json",
            undefined,
        );
    });

    it("saves an empty play queue without resolving any tracks", async () => {
        await handleSavePlayQueue(
            buildReq({
                index: "0",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockPlaybackUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    queue: expect.anything(),
                }),
                update: expect.objectContaining({
                    queue: expect.anything(),
                    currentTime: 0,
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

    it("returns generic error when getPlayQueue fails to read playback state", async () => {
        mockPlaybackFindUnique.mockRejectedValueOnce(new Error("db down"));

        await handleGetPlayQueue(buildReq({ index: "0" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch play queue",
            "json",
            undefined,
        );
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("treats malformed queue entries as absent when building playQueue", async () => {
        mockPlaybackFindUnique.mockResolvedValueOnce({
            queue: [123, null, "tr-track-1", { id: 42 }],
            currentIndex: 7,
            currentTime: 12.4,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });

        await handleGetPlayQueue(buildReq({ index: "1" }), buildRes());

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: 0,
                    position: 12400,
                    changed: "2026-01-01T00:00:00.000Z",
                    entry: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("clamps save-play-queue indices and normalizes negative position", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-1" }, { id: "track-2" }])
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "Song One",
                    duration: 180,
                    album: {
                        id: "album-1",
                        title: "Album One",
                        coverUrl: null,
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
                {
                    id: "track-2",
                    title: "Song Two",
                    duration: 200,
                    album: {
                        id: "album-2",
                        title: "Album Two",
                        coverUrl: null,
                        genres: [],
                        userGenres: [],
                        artist: {
                            id: "artist-2",
                            name: "Artist Two",
                        },
                    },
                },
            ]);

        await handleSavePlayQueue(
            buildReq({
                id: ["tr-track-1", "tr-track-1", "tr-track-2"],
                current: "10",
                position: "-250",
            }),
            buildRes(),
        );

        expect(mockPlaybackUpsert).toHaveBeenCalled();
        const upsertCall = mockPlaybackUpsert.mock.calls[0][0] as {
            create: {
                queue: Array<{ id: string; title: string }>;
                currentIndex: number;
                currentTime: number;
                trackId: string;
            };
        };

        expect(upsertCall.create).toEqual(
            expect.objectContaining({
                currentIndex: 2,
                currentTime: 0,
                trackId: "track-2",
            }),
        );
        expect(upsertCall.create.queue.map((item) => item.id)).toEqual([
            "tr-track-1",
            "tr-track-1",
            "tr-track-2",
        ]);
        expect(upsertCall.create.queue.map((item) => item.title)).toEqual([
            "Song One",
            "Song One",
            "Song Two",
        ]);
    });

    it("uses the legacy device id for an invalid index query", async () => {
        await handleGetPlayQueue(
            buildReq({
                index: "not-a-number",
            }),
            buildRes(),
        );

        expect(mockPlaybackFindUnique).toHaveBeenCalledWith({
            where: {
                userId_deviceId: {
                    userId: "user-1",
                    deviceId: "legacy",
                },
            },
        });
    });

    it("returns scan status as idle when no scan job is active", async () => {
        mockScanGetActive.mockResolvedValueOnce([]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: false,
                    count: 0,
                },
            }),
            "json",
            undefined,
        );
    });

    it("clamps scan progress to 100 when scanning report is above 100", async () => {
        mockScanGetActive.mockResolvedValueOnce([{ progress: () => 123 }]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: true,
                    count: 100,
                },
            }),
            "json",
            undefined,
        );
    });
});
