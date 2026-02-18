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
        album: {
            findMany: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
        },
        likedTrack: {
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
import { sendSubsonicError, sendSubsonicSuccess } from "../../utils/subsonicResponse";
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

describe("subsonic state/admin compatibility handlers", () => {
    const mockPlaybackFindUnique = prisma.playbackState.findUnique as jest.Mock;
    const mockPlaybackUpsert = prisma.playbackState.upsert as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
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
        mockTrackFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockGetActive.mockResolvedValue([]);
        mockGetWaiting.mockResolvedValue([]);
        mockGetDelayed.mockResolvedValue([]);
        mockScanAdd.mockResolvedValue({ id: "job-1" });
    });

    it("returns empty play queue when no playback state exists", async () => {
        await handleGetPlayQueue(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playQueue: expect.objectContaining({
                    current: 0,
                    position: 0,
                    entry: [],
                }),
            }),
            "json",
            undefined,
        );
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
                current: "0",
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

    it("returns empty bookmark payload for getBookmarks", async () => {
        await handleGetBookmarks(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                bookmarks: {
                    bookmark: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("accepts createBookmark and deleteBookmark as protocol-success no-ops", async () => {
        await handleCreateBookmark(buildReq({ id: "tr-track-1", position: "12345" }), buildRes());
        await handleDeleteBookmark(buildReq({ id: "tr-track-1" }), buildRes());

        expect(mockSendSuccess).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            {},
            "json",
            undefined,
        );
        expect(mockSendSuccess).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            {},
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
                current: "0",
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
                coverUrl: null,
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-2",
                    name: "Artist Two",
                },
                tracks: [{ duration: 210 }],
            },
            {
                id: "album-1",
                title: "Album One",
                year: 2023,
                coverUrl: null,
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 180 }],
            },
        ]);
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-2",
                name: "Artist Two",
                heroUrl: null,
                albums: [{ id: "album-2" }],
            },
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                albums: [{ id: "album-1" }],
            },
        ]);

        await handleGetStarred2(buildReq({}), buildRes());

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
