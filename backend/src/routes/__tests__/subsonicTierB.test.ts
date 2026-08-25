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
        NOT_AUTHORIZED: 50,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: jest.fn(),
            aggregate: jest.fn(),
            groupBy: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
        },
        playlist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        playlistItem: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
            findMany: jest.fn(),
            aggregate: jest.fn(),
            update: jest.fn(),
        },
        play: {
            createMany: jest.fn(),
            groupBy: jest.fn(),
        },
        likedTrack: {
            createMany: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
        },
        trackRating: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
        },
        $queryRaw: jest.fn(),
        $executeRaw: jest.fn(),
        $transaction: jest.fn(),
    },
}));

jest.mock("../../services/searchCacheVersion", () => ({
    getSearchCacheVersion: jest.fn().mockResolvedValue(1),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setEx: jest.fn().mockResolvedValue("OK"),
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
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import { scanQueue } from "../../workers/queues";
import {
    handleCreatePlaylist,
    handleDeletePlaylist,
    handleGetArtists,
    handleGetLicense,
    handleGetScanStatus,
    handleGetAvatar,
    handleGetIndexes,
    handleGetPlaylists,
    handleGetPlaylist,
    handleSearch,
    handleGetStarred,
    handleGetStarred2,
    handleGetUser,
    resetSubsonicScanStartCooldownForTests,
    handleScrobble,
    handleSetRating,
    handleStartScan,
    handleStar,
    handleUnstar,
    handleUpdatePlaylist,
    handleTokenInfo,
} from "../subsonic";

function buildReq(
    query: Record<string, unknown>,
    subsonicAuthType: "apiKey" | "token" | "password" = "password",
): Request {
    return {
        query,
        subsonicAuthType,
        user: {
            id: "user-1",
            username: "alice",
            role: "USER",
        },
    } as unknown as Request;
}

function buildRes(): Response {
    return {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
    } as unknown as Response;
}

function buildReqWithUser(
    query: Record<string, unknown>,
    user: {
        id?: string;
        username?: string;
        role?: string;
    },
): Request {
    return {
        query,
        user: {
            id: "user-1",
            username: "alice",
            role: "USER",
            ...user,
        },
    } as unknown as Request;
}

describe("subsonic Tier B handlers", () => {
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackAggregate = prisma.track.aggregate as jest.Mock;
    const mockTrackGroupBy = prisma.track.groupBy as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockPlaylistFindMany = prisma.playlist.findMany as jest.Mock;
    const mockPlaylistFindFirst = prisma.playlist.findFirst as jest.Mock;
    const mockPlaylistCreate = prisma.playlist.create as jest.Mock;
    const mockPlaylistUpdate = prisma.playlist.update as jest.Mock;
    const mockPlaylistDelete = prisma.playlist.delete as jest.Mock;
    const mockPlaylistItemDeleteMany = prisma.playlistItem
        .deleteMany as jest.Mock;
    const mockPlaylistItemCreateMany = prisma.playlistItem
        .createMany as jest.Mock;
    const mockPlaylistItemFindMany = prisma.playlistItem.findMany as jest.Mock;
    const mockPlaylistItemAggregate = prisma.playlistItem
        .aggregate as jest.Mock;
    const mockPlaylistItemUpdate = prisma.playlistItem.update as jest.Mock;
    const mockPlayCreateMany = prisma.play.createMany as jest.Mock;
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockLikedCreateMany = prisma.likedTrack.createMany as jest.Mock;
    const mockLikedDeleteMany = prisma.likedTrack.deleteMany as jest.Mock;
    const mockLikedFindMany = prisma.likedTrack.findMany as jest.Mock;
    const mockTrackRating = (
        prisma as unknown as {
            trackRating: {
                findMany: jest.Mock;
                upsert: jest.Mock;
                deleteMany: jest.Mock;
            };
        }
    ).trackRating;
    const mockTransaction = prisma.$transaction as jest.Mock;
    const mockQueryRaw = prisma.$queryRaw as jest.Mock;
    const mockExecuteRaw = prisma.$executeRaw as jest.Mock;
    const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
    const mockScanGetActive = scanQueue.getActive as jest.Mock;
    const mockScanGetWaiting = scanQueue.getWaiting as jest.Mock;
    const mockScanGetDelayed = scanQueue.getDelayed as jest.Mock;
    const mockScanAdd = scanQueue.add as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        resetSubsonicScanStartCooldownForTests();
        mockPlaylistFindMany.mockResolvedValue([]);
        mockPlayGroupBy.mockResolvedValue([]);
        mockLikedFindMany.mockResolvedValue([]);
        mockTrackRating.findMany.mockResolvedValue([]);
        mockTrackRating.upsert.mockResolvedValue({});
        mockTrackRating.deleteMany.mockResolvedValue({ count: 0 });
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackAggregate.mockResolvedValue({ _sum: { duration: null } });
        mockTrackGroupBy.mockResolvedValue([]);
        mockPlaylistItemFindMany.mockResolvedValue([]);
        mockPlaylistDelete.mockResolvedValue({});
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);
        mockPlaylistItemUpdate.mockResolvedValue({});
        mockQueryRaw.mockResolvedValue([
            { id: "playlist-1", userId: "user-1", mixId: null },
        ]);
        mockTransaction.mockImplementation(async (operation: unknown) => {
            if (typeof operation === "function") {
                return operation(prisma);
            }
            return Promise.all(operation as Promise<unknown>[]);
        });
        mockScanGetActive.mockResolvedValue([]);
        mockScanGetWaiting.mockResolvedValue([]);
        mockScanGetDelayed.mockResolvedValue([]);
        mockScanAdd.mockResolvedValue({ id: "scan-job-1" });
    });

    it("creates a playlist and writes playlist items from songId values", async () => {
        mockTrackFindMany.mockResolvedValue([
            { id: "track-1" },
            { id: "track-2" },
        ]);
        mockPlaylistCreate.mockResolvedValue({ id: "playlist-1" });

        await handleCreatePlaylist(
            buildReq({
                name: "Road Trip",
                songId: ["tr-track-1", "tr-track-2"],
            }),
            buildRes(),
        );

        expect(mockPlaylistCreate).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                name: "Road Trip",
            },
        });
        expect(mockPlaylistItemCreateMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "track-1", sort: 0 },
                { playlistId: "playlist-1", trackId: "track-2", sort: 1 },
            ],
            skipDuplicates: true,
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("returns missing-parameter error when createPlaylist has neither name nor playlistId", async () => {
        await handleCreatePlaylist(
            buildReq({
                songId: ["tr-track-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'name' or 'playlistId' is missing",
            "json",
            undefined,
        );
    });

    it("returns song-not-found when createPlaylist receives malformed song IDs", async () => {
        await handleCreatePlaylist(
            buildReq({
                name: "Broken playlist",
                songId: ["bad-song-id"],
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
        expect(mockPlaylistCreate).not.toHaveBeenCalled();
    });

    it("returns song-not-found before ownership for a foreign createPlaylist target with a malformed song ID", async () => {
        await handleCreatePlaylist(
            buildReq({
                playlistId: "pl-foreign-playlist",
                songId: ["al-not-a-song"],
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
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("returns song-not-found before ownership for a foreign createPlaylist target with a missing song", async () => {
        mockTrackFindMany.mockResolvedValueOnce([]);

        await handleCreatePlaylist(
            buildReq({
                playlistId: "pl-foreign-playlist",
                songId: ["tr-track-missing"],
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
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("returns not-authorized when createPlaylist update target is not owned", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockQueryRaw.mockResolvedValueOnce([]);

        await handleCreatePlaylist(
            buildReq({
                playlistId: "pl-foreign-playlist",
                name: "Rename denied",
                songId: ["tr-track-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to modify this playlist",
            "json",
            undefined,
        );
        expect(mockPlaylistUpdate).not.toHaveBeenCalled();
    });

    it("returns generic error when createPlaylist receives malformed playlistId", async () => {
        await handleCreatePlaylist(
            buildReq({
                playlistId: "al-not-a-playlist",
                name: "Rename attempt",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to create/update playlist",
            "json",
            undefined,
        );
    });

    it("updates an existing playlist through createPlaylist and rewrites track order", async () => {
        mockTrackFindMany.mockResolvedValue([
            { id: "track-9" },
            { id: "track-10" },
        ]);
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });

        await handleCreatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                name: "Renamed Playlist",
                songId: ["tr-track-9", "tr-track-10"],
            }),
            buildRes(),
        );

        expect(mockPlaylistUpdate).toHaveBeenCalledWith({
            where: { id: "playlist-1" },
            data: { name: "Renamed Playlist" },
        });
        expect(mockPlaylistItemDeleteMany).toHaveBeenCalledWith({
            where: { playlistId: "playlist-1" },
        });
        expect(mockPlaylistItemCreateMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "track-9", sort: 0 },
                { playlistId: "playlist-1", trackId: "track-10", sort: 1 },
            ],
            skipDuplicates: true,
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("validates songs before locking an existing createPlaylist target", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "track-9" }]);

        await handleCreatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                name: "Locked Rename",
                songId: ["tr-track-9"],
            }),
            buildRes(),
        );

        expect(typeof mockTransaction.mock.calls[0]?.[0]).toBe("function");
        expect(mockQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            "playlist-1",
            "user-1",
        );
        expect(mockTrackFindMany.mock.invocationCallOrder[0]).toBeLessThan(
            mockQueryRaw.mock.invocationCallOrder[0],
        );
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockPlaylistUpdate.mock.invocationCallOrder[0],
        );
        expect(mockPlaylistUpdate.mock.invocationCallOrder[0]).toBeLessThan(
            mockPlaylistItemDeleteMany.mock.invocationCallOrder[0],
        );
    });

    it("updates a playlist by removing indices, adding tracks, and reindexing", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockPlaylistItemFindMany
            .mockResolvedValueOnce([{ id: "item-1" }, { id: "item-2" }])
            .mockResolvedValueOnce([{ trackId: "track-2" }]);
        mockTrackFindMany.mockResolvedValue([
            { id: "track-3" },
            { id: "track-4" },
        ]);
        mockPlaylistItemAggregate.mockResolvedValue({ _max: { sort: 1 } });

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                songIndexToRemove: ["0"],
                songIdToAdd: ["tr-track-3", "tr-track-4"],
            }),
            buildRes(),
        );

        expect(mockPlaylistItemDeleteMany).toHaveBeenCalledWith({
            where: {
                id: {
                    in: ["item-1"],
                },
            },
        });
        expect(mockPlaylistItemCreateMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "track-3", sort: 2 },
                { playlistId: "playlist-1", trackId: "track-4", sort: 3 },
            ],
            skipDuplicates: true,
        });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
        expect(mockExecuteRaw).toHaveBeenCalledWith(
            expect.anything(),
            "playlist-1",
        );
        expect(mockPlaylistItemUpdate).not.toHaveBeenCalled();
        expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
            maxWait: 2000,
            timeout: 15000,
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("locks updatePlaylist before ownership, item, and maximum-sort work", async () => {
        mockPlaylistItemFindMany
            .mockResolvedValueOnce([{ id: "item-1" }])
            .mockResolvedValueOnce([]);
        mockTrackFindMany.mockResolvedValue([{ id: "track-3" }]);
        mockPlaylistItemAggregate.mockResolvedValue({ _max: { sort: 0 } });

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                songIndexToRemove: ["0"],
                songIdToAdd: ["tr-track-3"],
            }),
            buildRes(),
        );

        expect(typeof mockTransaction.mock.calls[0]?.[0]).toBe("function");
        expect(mockQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            "playlist-1",
            "user-1",
        );
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockTrackFindMany.mock.invocationCallOrder[0],
        );
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockPlaylistItemFindMany.mock.invocationCallOrder[0],
        );
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockPlaylistItemAggregate.mock.invocationCallOrder[0],
        );
        expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockPlaylistItemDeleteMany.mock.invocationCallOrder[0],
        );
    });

    it("returns playlist-not-found when updatePlaylist playlistId cannot be parsed", async () => {
        await handleUpdatePlaylist(
            buildReq({
                playlistId: "al-not-a-playlist",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Playlist not found",
            "json",
            undefined,
        );
    });

    it("returns early when updatePlaylist is missing the required playlistId", async () => {
        await handleUpdatePlaylist(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalled();
    });

    it("returns not-authorized when updatePlaylist target is not owned", async () => {
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockQueryRaw.mockResolvedValueOnce([]);

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to modify this playlist",
            "json",
            undefined,
        );
    });

    it("returns not-authorized before parsing a malformed song for a foreign updatePlaylist target", async () => {
        mockQueryRaw.mockResolvedValueOnce([]);

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-foreign-playlist",
                songIdToAdd: ["al-not-a-song"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to modify this playlist",
            "json",
            undefined,
        );
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("returns not-authorized before validating a missing song for a foreign updatePlaylist target", async () => {
        mockQueryRaw.mockResolvedValueOnce([]);

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-foreign-playlist",
                songIdToAdd: ["tr-track-missing"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to modify this playlist",
            "json",
            undefined,
        );
        expect(mockTrackFindMany).not.toHaveBeenCalled();
    });

    it("returns song-not-found when updatePlaylist add list contains malformed song IDs", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                songIdToAdd: ["bad-song-id"],
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

    it("returns song-not-found when updatePlaylist add list includes tracks outside the library", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockTrackFindMany.mockResolvedValue([]);

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                songIdToAdd: ["tr-track-missing"],
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

    it("returns generic error when updatePlaylist encounters an unexpected failure", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockPlaylistItemFindMany.mockRejectedValueOnce(
            new Error("database boom"),
        );

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                songIndexToRemove: ["0"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to update playlist",
            "json",
            undefined,
        );
    });

    it("updates playlist metadata name when only name is provided", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });

        await handleUpdatePlaylist(
            buildReq({
                playlistId: "pl-playlist-1",
                name: "Only Rename",
            }),
            buildRes(),
        );

        expect(mockPlaylistUpdate).toHaveBeenCalledWith({
            where: { id: "playlist-1" },
            data: { name: "Only Rename" },
        });
        expect(mockPlaylistItemFindMany).not.toHaveBeenCalled();
        expect(mockPlaylistItemDeleteMany).not.toHaveBeenCalled();
        expect(mockPlaylistItemCreateMany).not.toHaveBeenCalled();
        expect(mockPlaylistItemUpdate).not.toHaveBeenCalled();
        expect(mockExecuteRaw).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("scrobbles only submission=true entries when mixed submission flags are provided", async () => {
        mockTrackFindMany.mockResolvedValue([
            { id: "track-1" },
            { id: "track-2" },
        ]);

        await handleScrobble(
            buildReq({
                id: ["tr-track-1", "tr-track-2"],
                submission: ["false", "true"],
                time: ["1700000000", "1700000060"],
            }),
            buildRes(),
        );

        expect(mockPlayCreateMany).toHaveBeenCalledTimes(1);
        const createManyArg = mockPlayCreateMany.mock.calls[0][0] as {
            data: Array<{ userId: string; trackId: string; playedAt: Date }>;
        };
        expect(createManyArg.data).toHaveLength(1);
        expect(createManyArg.data[0].trackId).toBe("track-2");
        expect(createManyArg.data[0].userId).toBe("user-1");
        expect(createManyArg.data[0].playedAt).toBeInstanceOf(Date);
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("stars and unstars track IDs using likedTrack mutations", async () => {
        mockTrackFindMany.mockResolvedValue([
            { id: "track-5" },
            { id: "track-6" },
        ]);

        await handleStar(
            buildReq({
                id: ["tr-track-5", "tr-track-6"],
            }),
            buildRes(),
        );

        expect(mockLikedCreateMany).toHaveBeenCalledWith({
            data: [
                { userId: "user-1", trackId: "track-5" },
                { userId: "user-1", trackId: "track-6" },
            ],
            skipDuplicates: true,
        });

        await handleUnstar(
            buildReq({
                id: ["tr-track-5", "tr-track-6"],
            }),
            buildRes(),
        );

        expect(mockLikedDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: {
                    in: ["track-5", "track-6"],
                },
            },
        });
    });

    it("stars and unstars album and artist IDs by projecting to track likes", async () => {
        mockAlbumFindMany.mockResolvedValue([{ id: "album-7" }]);
        mockArtistFindMany.mockResolvedValue([{ id: "artist-9" }]);
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-70" }])
            .mockResolvedValueOnce([{ id: "track-90" }, { id: "track-70" }])
            .mockResolvedValueOnce([{ id: "track-70" }])
            .mockResolvedValueOnce([{ id: "track-90" }, { id: "track-70" }]);

        await handleStar(
            buildReq({
                albumId: ["al-album-7"],
                artistId: ["ar-artist-9"],
            }),
            buildRes(),
        );

        expect(mockLikedCreateMany).toHaveBeenCalledWith({
            data: [
                { userId: "user-1", trackId: "track-70" },
                { userId: "user-1", trackId: "track-90" },
            ],
            skipDuplicates: true,
        });

        await handleUnstar(
            buildReq({
                albumId: ["al-album-7"],
                artistId: ["ar-artist-9"],
            }),
            buildRes(),
        );

        expect(mockLikedDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: {
                    in: ["track-70", "track-90"],
                },
            },
        });
    });

    it("returns populated artist and album arrays in getStarred2", async () => {
        mockLikedFindMany.mockResolvedValue([
            {
                likedAt: new Date("2026-01-01T00:00:00.000Z"),
                track: {
                    id: "track-1",
                    title: "Song One",
                    trackNo: 1,
                    discNo: 1,
                    duration: 180,
                    fileSize: 1000,
                    mime: "audio/mpeg",
                    filePath: "Artist One/Album One/01 Song One.mp3",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        year: 2024,
                        coverUrl: "https://example.test/cover.jpg",
                        location: "LIBRARY",
                        artist: {
                            id: "artist-1",
                            name: "Artist One",
                        },
                    },
                },
            },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "Album One",
                year: 2024,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                coverUrl: "https://example.test/cover.jpg",
                location: "LIBRARY",
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
            },
        ]);
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.test/artist.jpg",
                _count: { albums: 1 },
            },
        ]);
        mockTrackGroupBy.mockResolvedValue([
            {
                albumId: "album-1",
                _count: { _all: 1 },
                _sum: { duration: 180 },
            },
        ]);

        await handleGetStarred2(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                starred2: expect.objectContaining({
                    artist: expect.arrayContaining([
                        expect.objectContaining({
                            id: "ar-artist-1",
                        }),
                    ]),
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-1",
                        }),
                    ]),
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-1",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns legacy getStarred payload", async () => {
        mockLikedFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);

        await handleGetStarred(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                starred: expect.objectContaining({
                    artist: [],
                    album: [],
                    song: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("reports active scan progress and ignores waiting backlog in getScanStatus", async () => {
        mockScanGetActive.mockResolvedValue([
            {
                progress: () => 73,
            },
        ]);
        mockScanGetWaiting.mockResolvedValue([{}, {}]);
        mockScanGetDelayed.mockResolvedValue([{}]);

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: {
                    scanning: true,
                    count: 73,
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns scanning=false when there is no active scan job", async () => {
        mockScanGetActive.mockResolvedValue([]);
        mockScanGetWaiting.mockResolvedValue([{}]);
        mockScanGetDelayed.mockResolvedValue([{}]);

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

    it("deduplicates startScan requests when scan jobs are already queued", async () => {
        mockScanGetActive.mockResolvedValue([]);
        mockScanGetWaiting.mockResolvedValue([{}]);
        mockScanGetDelayed.mockResolvedValue([]);

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

    it("queues a scan when startScan is called with an empty queue", async () => {
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

    it("does not enqueue a second startScan request during cooldown", async () => {
        await handleStartScan(buildReq({}), buildRes());
        await handleStartScan(buildReq({}), buildRes());

        expect(mockScanAdd).toHaveBeenCalledTimes(1);
    });

    it("returns scanStatus count 0 when active scan progress cannot be parsed as a number", async () => {
        mockScanGetActive.mockResolvedValue([
            {
                progress: () => "invalid",
            },
        ]);
        mockScanGetWaiting.mockResolvedValue([{}]);
        mockScanGetDelayed.mockResolvedValue([]);

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

    it("returns generic error when scan status query fails", async () => {
        mockScanGetActive.mockRejectedValue(new Error("redis failure"));

        await handleGetScanStatus(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch scan status",
            "json",
            undefined,
        );
    });

    it("clamps scan progress above 100 when startScan reports it", async () => {
        mockScanGetActive.mockResolvedValue([
            {
                progress: () => 123,
            },
        ]);
        mockScanGetWaiting.mockResolvedValue([]);
        mockScanGetDelayed.mockResolvedValue([]);

        await handleStartScan(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                scanStatus: expect.objectContaining({
                    scanning: true,
                    count: 100,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when startScan fails before queueing", async () => {
        mockScanGetWaiting.mockRejectedValue(new Error("redis failure"));

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

    it("returns generic error when startScan queue add fails", async () => {
        mockScanAdd.mockRejectedValue(new Error("queue unavailable"));

        await handleStartScan(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to start scan",
            "json",
            undefined,
        );
        expect(mockScanAdd).toHaveBeenCalledTimes(1);
    });

    it("lists playlists with mapped duration and conditional cover art", async () => {
        mockPlaylistFindMany.mockResolvedValue([
            {
                id: "playlist-1",
                name: "Morning",
                isPublic: true,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                _count: {
                    items: 2,
                },
            },
            {
                id: "playlist-2",
                name: "Quiet",
                isPublic: false,
                createdAt: new Date("2026-01-02T00:00:00.000Z"),
                _count: {
                    items: 0,
                },
            },
        ]);
        mockPlaylistItemFindMany.mockImplementation((args) => {
            if (args.where.trackId) {
                return Promise.resolve([
                    {
                        playlistId: "playlist-1",
                        track: { duration: 100 },
                    },
                    {
                        playlistId: "playlist-1",
                        track: { duration: 65 },
                    },
                ]);
            }
            return Promise.resolve([{ playlistId: "playlist-1" }]);
        });

        await handleGetPlaylists(buildReq({}), buildRes());

        const playlistQuery = mockPlaylistFindMany.mock.calls[0][0];
        expect(playlistQuery).toMatchObject({
            where: {
                AND: [
                    { OR: [{ userId: "user-1" }, { isPublic: true }] },
                    {
                        OR: [
                            { mixId: null },
                            {
                                NOT: {
                                    mixId: {
                                        startsWith: "radio-ephemeral:",
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
            orderBy: { createdAt: "desc" },
            include: {
                _count: {
                    select: {
                        items: {
                            where: {
                                OR: [
                                    { trackId: null },
                                    {
                                        track: {
                                            removedAt: null,
                                            AND: expect.any(Array),
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        expect(playlistQuery.include).not.toHaveProperty("items");
        expect(mockTrackAggregate).not.toHaveBeenCalled();
        expect(mockPlaylistItemFindMany).toHaveBeenCalledTimes(2);
        expect(mockPlaylistItemFindMany).toHaveBeenCalledWith({
            where: {
                playlistId: { in: ["playlist-1"] },
                trackId: { not: null },
                track: expect.objectContaining({
                    removedAt: null,
                    AND: expect.any(Array),
                }),
            },
            select: {
                playlistId: true,
                track: { select: { duration: true } },
            },
        });
        expect(mockPlaylistItemFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                distinct: ["playlistId"],
                select: { playlistId: true },
            }),
        );
        const playlists = (
            mockSendSuccess.mock.calls[0][1] as {
                playlists: { playlist: Array<Record<string, unknown>> };
            }
        ).playlists.playlist;

        expect(playlists).toHaveLength(2);
        expect(playlists[0].id).toBe("pl-playlist-1");
        expect(playlists[0]).toHaveProperty("coverArt", "pl-playlist-1");
        expect(playlists[0]).toMatchObject({
            name: "Morning",
            songCount: 2,
            duration: 165,
            public: true,
        });
        expect(playlists[1]).toMatchObject({
            id: "pl-playlist-2",
            name: "Quiet",
            songCount: 0,
            duration: 0,
            public: false,
        });
        expect(playlists[1]).toHaveProperty("coverArt", undefined);
    });

    it("returns not-found when getPlaylist id cannot be parsed", async () => {
        await handleGetPlaylist(buildReq({ id: "not-a-playlist" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Playlist not found",
            "json",
            undefined,
        );
    });

    it("returns playlist payload with a federated entry", async () => {
        mockPlaylistFindFirst.mockResolvedValue({
            id: "playlist-1",
            name: "Morning",
            isPublic: true,
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
            items: [
                {
                    track: {
                        id: "federated-track-1",
                        title: "Song One",
                        trackNo: 1,
                        discNo: 1,
                        duration: 120,
                        fileSize: 4000,
                        mime: "audio/mpeg",
                        filePath: null,
                        album: {
                            id: "album-1",
                            title: "Album One",
                            year: 2026,
                            coverUrl: null,
                            location: "FEDERATED",
                            genres: ["rock"],
                            userGenres: ["indie"],
                            artist: {
                                id: "artist-1",
                                name: "Artist One",
                            },
                        },
                    },
                },
            ],
        });

        await handleGetPlaylist(buildReq({ id: "pl-playlist-1" }), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playlist: expect.objectContaining({
                    id: "pl-playlist-1",
                    name: "Morning",
                    songCount: 1,
                    duration: 120,
                    public: true,
                    owner: "alice",
                    entry: [
                        expect.objectContaining({
                            id: "tr-federated-track-1",
                        }),
                    ],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns not-found when getPlaylist id refers to a missing playlist", async () => {
        mockPlaylistFindFirst.mockResolvedValue(null);

        await handleGetPlaylist(
            buildReq({
                id: "pl-missing-playlist",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Playlist not found",
            "json",
            undefined,
        );
    });

    it("returns generic error when getPlaylist fails", async () => {
        mockPlaylistFindFirst.mockRejectedValue(new Error("db down"));

        await handleGetPlaylist(
            buildReq({
                id: "pl-playlist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch playlist",
            "json",
            undefined,
        );
    });

    it("returns not-authorized when deleting a foreign playlist", async () => {
        mockPlaylistFindFirst.mockResolvedValue(null);

        await handleDeletePlaylist(
            buildReq({ id: "pl-playlist-2" }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to delete this playlist",
            "json",
            undefined,
        );
    });

    it("deletes playlist owned by the requesting user", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });

        await handleDeletePlaylist(
            buildReq({ id: "pl-playlist-1" }),
            buildRes(),
        );

        expect(mockPlaylistDelete).toHaveBeenCalledWith({
            where: {
                id: "playlist-1",
            },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
    });

    it("returns missing-parameter when deletePlaylist is called without id", async () => {
        await handleDeletePlaylist(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns generic error when deletePlaylist fails", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockPlaylistDelete.mockRejectedValue(new Error("delete failed"));

        await handleDeletePlaylist(
            buildReq({ id: "pl-playlist-1" }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to delete playlist",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter when scrobble is called without id", async () => {
        await handleScrobble(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns track-not-found when scrobble has an invalid track identifier", async () => {
        await handleScrobble(
            buildReq({
                id: ["al-bad-track"],
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

    it("returns not-found when scrobble tracks are not in library", async () => {
        mockTrackFindMany.mockResolvedValue([]);

        await handleScrobble(
            buildReq({
                id: ["tr-track-1"],
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

    it("returns generic error when scrobble create fails", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);
        mockPlayCreateMany.mockRejectedValue(new Error("db down"));

        await handleScrobble(
            buildReq({
                id: ["tr-track-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to scrobble",
            "json",
            undefined,
        );
    });

    it("returns unauthorized for getUser requests when requesting a different username", async () => {
        await handleGetUser(buildReq({ username: "bob" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized",
            "json",
            undefined,
        );
    });

    it("returns generic error when getUser query fails", async () => {
        mockUserFindUnique.mockRejectedValue(new Error("db down"));

        await handleGetUser(buildReq({ username: "alice" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch user",
            "json",
            undefined,
        );
    });

    it("returns user not found when requested user does not exist", async () => {
        await handleGetUser(
            buildReqWithUser(
                {},
                { role: "admin", username: "admin", id: "admin-1" },
            ),
            buildRes(),
        );

        expect(mockUserFindUnique).toHaveBeenCalledWith({
            where: { username: "admin" },
            select: {
                username: true,
                role: true,
            },
        });
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "User not found",
            "json",
            undefined,
        );
    });

    it("returns user payload for admin user requests", async () => {
        mockUserFindUnique.mockResolvedValue({ username: "bob", role: "USER" });
        await handleGetUser(
            buildReqWithUser(
                { username: "bob" },
                { role: "admin", username: "admin", id: "admin-1" },
            ),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                user: expect.objectContaining({
                    username: "bob",
                    adminRole: false,
                    playlistRole: true,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns unauthorized avatar for non-admin requests against another username", async () => {
        await handleGetAvatar(buildReq({ username: "bob" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized",
            "json",
            undefined,
        );
    });

    it("returns avatar payload for matching user and sets headers", async () => {
        const res = buildRes();
        mockUserFindUnique.mockResolvedValue({ username: "alice" });

        await handleGetAvatar(buildReq({}), res);

        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(res.setHeader).toHaveBeenCalledWith(
            "Cache-Control",
            "public, max-age=86400",
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it("returns not-found when avatar user does not exist", async () => {
        const res = buildRes();
        mockUserFindUnique.mockResolvedValue(null);

        await handleGetAvatar(buildReq({}), res);

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "User not found",
            "json",
            undefined,
        );
        expect(res.status).not.toHaveBeenCalled();
        expect(res.send).not.toHaveBeenCalled();
    });

    it("returns generic error when getAvatar query fails", async () => {
        const res = buildRes();
        mockUserFindUnique.mockRejectedValue(new Error("db down"));

        await handleGetAvatar(buildReq({}), res);

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch avatar",
            "json",
            undefined,
        );
        expect(res.status).not.toHaveBeenCalled();
        expect(res.send).not.toHaveBeenCalled();
    });

    it("returns missing-parameter when setting rating without track id", async () => {
        await handleSetRating(buildReq({ rating: "5" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter when rating is invalid", async () => {
        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "bad",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'rating' is invalid",
            "json",
            undefined,
        );
    });

    it("returns not-found when rating target track is outside the library", async () => {
        mockTrackFindMany.mockResolvedValue([]);

        await handleSetRating(
            buildReq({
                id: "tr-track-missing",
                rating: "5",
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

    it("returns generic error when setting a rating fails", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);
        mockTrackRating.upsert.mockRejectedValue(new Error("db down"));

        await handleSetRating(
            buildReq({
                id: "tr-track-1",
                rating: "5",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to set rating",
            "json",
            undefined,
        );
    });

    it("deletes and upserts numeric rating records", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "track-1" }])
            .mockResolvedValueOnce([{ id: "track-1" }]);

        await handleSetRating(
            buildReq({ id: "tr-track-1", rating: "0" }),
            buildRes(),
        );
        await handleSetRating(
            buildReq({ id: "tr-track-1", rating: "5" }),
            buildRes(),
        );

        expect(mockTrackRating.deleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-1",
            },
        });
        expect(mockTrackRating.upsert).toHaveBeenCalledWith({
            where: {
                userId_trackId: { userId: "user-1", trackId: "track-1" },
            },
            create: { userId: "user-1", trackId: "track-1", rating: 5 },
            update: { rating: 5 },
        });
    });

    it("returns missing-parameter when starring without track or album identifiers", async () => {
        await handleStar(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id', 'albumId', or 'artistId' is missing",
            "json",
            undefined,
        );
    });

    it("returns not-found for a star identifier with the wrong entity type", async () => {
        await handleStar(
            buildReq({
                id: ["al-album-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Invalid song, album, or artist ID",
            "json",
            undefined,
        );
    });

    it("returns not-found when star target tracks do not exist", async () => {
        mockTrackFindMany.mockResolvedValue([]);

        await handleStar(
            buildReq({
                id: ["tr-track-1"],
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
        expect(mockLikedCreateMany).not.toHaveBeenCalled();
    });

    it("returns not-found when star target albums do not exist", async () => {
        mockAlbumFindMany.mockResolvedValue([]);

        await handleStar(
            buildReq({
                albumId: ["al-album-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Album not found",
            "json",
            undefined,
        );
        expect(mockLikedCreateMany).not.toHaveBeenCalled();
    });

    it("returns not-found when star target artists do not exist", async () => {
        mockArtistFindMany.mockResolvedValue([]);

        await handleStar(
            buildReq({
                artistId: ["ar-artist-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Artist not found",
            "json",
            undefined,
        );
        expect(mockLikedCreateMany).not.toHaveBeenCalled();
    });

    it("returns success when star resolves no tracks to mutate", async () => {
        mockAlbumFindMany.mockResolvedValue([{ id: "album-1" }]);
        mockTrackFindMany.mockResolvedValue([]);

        await handleStar(
            buildReq({
                albumId: ["al-album-1"],
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
        expect(mockLikedCreateMany).not.toHaveBeenCalled();
    });

    it("returns missing-parameter when unstarring without track or album identifiers", async () => {
        await handleUnstar(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id', 'albumId', or 'artistId' is missing",
            "json",
            undefined,
        );
    });

    it("returns success when unstar resolves no tracks to remove", async () => {
        mockAlbumFindMany.mockResolvedValue([{ id: "album-1" }]);
        mockTrackFindMany.mockResolvedValue([]);

        await handleUnstar(
            buildReq({
                albumId: ["al-album-1"],
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {},
            "json",
            undefined,
        );
        expect(mockLikedDeleteMany).not.toHaveBeenCalled();
    });

    it("returns generic error when unstar operation fails", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);
        mockLikedDeleteMany.mockRejectedValue(new Error("db down"));

        await handleUnstar(
            buildReq({
                id: ["tr-track-1"],
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to unstar item",
            "json",
            undefined,
        );
        expect(mockSendSuccess).not.toHaveBeenCalled();
    });

    it("returns early indexes payload for unsupported music folder IDs", async () => {
        await handleGetIndexes(buildReq({ musicFolderId: "9" }), buildRes());

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                indexes: expect.objectContaining({
                    index: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns cached indexes payload when ifModifiedSince is ahead of last modified", async () => {
        const lastModified = new Date("2026-01-01T00:00:00.000Z");
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                lastSynced: lastModified,
                libraryAlbumCount: 1,
            },
        ]);

        await handleGetIndexes(
            buildReq({ ifModifiedSince: `${lastModified.getTime()}` }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                indexes: expect.objectContaining({
                    index: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns artists with grouped indexes from getArtists", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.com/artist.jpg",
                libraryAlbumCount: 2,
            },
        ]);

        await handleGetArtists(buildReq({}), buildRes());

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { libraryAlbumCount: { gt: 0 } },
                orderBy: { name: "asc" },
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                artists: expect.objectContaining({
                    index: expect.arrayContaining([
                        expect.objectContaining({
                            artist: expect.arrayContaining([
                                expect.objectContaining({
                                    id: "ar-artist-1",
                                    albumCount: 2,
                                }),
                            ]),
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns search results for query-backed search requests", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                _count: {
                    albums: 1,
                },
            },
        ]);
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album One",
                year: 2020,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                coverUrl: null,
                location: "LIBRARY",
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [
                    {
                        duration: 180,
                    },
                ],
                _count: {
                    tracks: 1,
                },
            },
        ]);
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Track One",
                trackNo: 1,
                discNo: 1,
                duration: 120,
                fileSize: 100,
                mime: "audio/mpeg",
                filePath: "/music/Artist One/Album One/track1.mp3",
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2020,
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
        ]);

        await handleSearch(
            buildReq({
                query: "Artist",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult: expect.objectContaining({
                    artist: expect.arrayContaining([
                        expect.objectContaining({ id: "ar-artist-1" }),
                    ]),
                    album: expect.arrayContaining([
                        expect.objectContaining({ id: "al-album-1" }),
                    ]),
                    song: expect.arrayContaining([
                        expect.objectContaining({ id: "tr-track-1" }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns middleware-stamped apiKey authType for tokenInfo", async () => {
        await handleTokenInfo(
            buildReq(
                {
                    t: "handler-must-ignore-this-token",
                },
                "apiKey",
            ),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                tokenInfo: expect.objectContaining({
                    valid: true,
                    username: "alice",
                    authType: "apiKey",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns middleware-stamped token authType for tokenInfo", async () => {
        await handleTokenInfo(
            buildReq(
                {
                    apiKey: "handler-must-ignore-this-key",
                },
                "token",
            ),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                tokenInfo: expect.objectContaining({
                    valid: true,
                    username: "alice",
                    authType: "token",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns middleware-stamped password authType for tokenInfo", async () => {
        await handleTokenInfo(
            buildReq(
                {
                    apiKey: "handler-must-ignore-this-key",
                    t: "handler-must-ignore-this-token",
                },
                "password",
            ),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                tokenInfo: expect.objectContaining({
                    valid: true,
                    username: "alice",
                    authType: "password",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns static license details", async () => {
        await handleGetLicense(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                license: expect.objectContaining({
                    valid: true,
                    email: "self-hosted@soundspan.local",
                }),
            }),
            "json",
            undefined,
        );
    });
});
