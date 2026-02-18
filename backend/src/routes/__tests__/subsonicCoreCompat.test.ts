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
        NOT_AUTHORIZED: 50,
        NOT_FOUND: 70,
        MISSING_PARAMETER: 10,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
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
import {
    handleGetOpenSubsonicExtensions,
    handleGetUser,
    handleTokenInfo,
    handleGetIndexes,
    handleGetRandomSongs,
    handleGetAlbumList2,
    handleSearch3,
    handleGetSong,
} from "../subsonic";

function buildReq(
    query: Record<string, unknown>,
    user: { id: string; username: string; role: string } = {
        id: "user-1",
        username: "alice",
        role: "user",
    },
): Request {
    return {
        query,
        user,
    } as unknown as Request;
}

function buildRes(): Response {
    return {} as Response;
}

describe("subsonic core compatibility handlers", () => {
    const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
        mockPlayGroupBy.mockResolvedValue([]);
    });

    it("normalizes invalid search3 count and offset params to safe defaults", async () => {
        await handleSearch3(
            buildReq({
                query: "Song",
                artistCount: "nan",
                albumCount: "nan",
                songCount: "nan",
                artistOffset: "n/a",
                albumOffset: "n/a",
                songOffset: "n/a",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 0,
                take: 20,
            }),
        );
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 0,
                take: 20,
            }),
        );
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 0,
                take: 20,
            }),
        );
    });

    it("maps negative search3 counts to zero while keeping defaults for offsets", async () => {
        await handleSearch3(
            buildReq({
                query: "Song",
                artistCount: "-1",
                albumCount: "-1",
                songCount: "-1",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 0,
            }),
        );
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 0,
            }),
        );
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 0,
            }),
        );
    });

    it("returns full index payload when ifModifiedSince has a non-string type", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                _count: { albums: 1 },
            },
        ]);

        await handleGetIndexes(
            buildReq({
                ifModifiedSince: { value: "1" } as unknown,
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            indexes: {
                index: Array<{
                    artist: Array<{ id: string }>;
                }>;
            };
        };
        expect(payload.indexes.index).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    artist: expect.arrayContaining([expect.objectContaining({ id: "ar-artist-1" })]),
                }),
            ]),
        );
    });

    it("returns full index payload when ifModifiedSince is non-numeric", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-2",
                name: "Artist Two",
                heroUrl: null,
                lastSynced: new Date("2026-01-02T00:00:00.000Z"),
                _count: { albums: 1 },
            },
        ]);

        await handleGetIndexes(
            buildReq({
                ifModifiedSince: "abc",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            indexes: {
                index: Array<{
                    artist: Array<{ id: string }>;
                }>;
            };
        };
        expect(payload.indexes.index).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    artist: expect.arrayContaining([expect.objectContaining({ id: "ar-artist-2" })]),
                }),
            ]),
        );
    });

    it("returns missing-parameter error for a non-string album list type", async () => {
        await handleGetAlbumList2(
            buildReq({
                type: { invalid: "type" } as unknown,
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'type' is missing or invalid",
            "json",
            undefined,
        );
    });

    it("defaults random-song size and ignores an invalid fromYear while shuffling", async () => {
        const candidateSongs = Array.from({ length: 20 }, (_, index) => ({
            id: `track-${index + 1}`,
            title: `Song ${index + 1}`,
            trackNo: index + 1,
            discNo: 1,
            duration: 180,
            fileSize: 1234,
            mime: "audio/mpeg",
            filePath: `Artist One/Album One/${index + 1}.mp3`,
            album: {
                id: "album-1",
                title: "Album One",
                year: 2024,
                coverUrl: null,
                genres: [],
                userGenres: null,
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
            },
        }));
        mockTrackFindMany.mockResolvedValue(candidateSongs);
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.6);

        await handleGetRandomSongs(
            buildReq({
                size: "not-a-number",
                fromYear: "n/a",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            randomSongs: { song: Array<unknown> };
        };
        expect(payload.randomSongs.song).toHaveLength(10);
        expect(randomSpy).toHaveBeenCalled();
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    album: {
                        location: "LIBRARY",
                    },
                },
                take: 5000,
            }),
        );
        randomSpy.mockRestore();
    });

    it("builds frequent albumList payloads from play statistics", async () => {
        mockPlayGroupBy.mockResolvedValue([
            {
                trackId: "track-1",
                _count: { _all: 3 },
                _max: { playedAt: new Date("2026-01-05T00:00:00.000Z") },
            },
        ]);
        mockTrackFindMany.mockResolvedValue([{ id: "track-1", albumId: "album-1" }]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "Album One",
                year: 2024,
                coverUrl: null,
                genres: ["rock"],
                userGenres: null,
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 120 }],
            },
        ]);

        await handleGetAlbumList2(
            buildReq({
                type: "frequent",
                size: "1",
            }),
            buildRes(),
        );

        expect(mockPlayGroupBy).toHaveBeenCalledWith({
            by: ["trackId"],
            where: {
                userId: "user-1",
                track: {
                    album: {
                        location: "LIBRARY",
                    },
                },
            },
            _count: {
                _all: true,
            },
            _max: {
                playedAt: true,
            },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumList2: expect.objectContaining({
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-1",
                            songCount: 1,
                            duration: 120,
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("aggregates album play counts across multiple tracks for frequent-album ordering", async () => {
        mockPlayGroupBy.mockResolvedValueOnce([
            {
                trackId: "track-1",
                _count: { _all: 1 },
                _max: { playedAt: new Date("2026-01-02T00:00:00.000Z") },
            },
            {
                trackId: "track-2",
                _count: { _all: 1 },
                _max: { playedAt: new Date("2026-01-01T00:00:00.000Z") },
            },
            {
                trackId: "track-3",
                _count: { _all: 1 },
                _max: { playedAt: new Date("2025-12-31T00:00:00.000Z") },
            },
        ]);
        mockTrackFindMany.mockResolvedValue([
            { id: "track-1", albumId: "album-1" },
            { id: "track-2", albumId: "album-1" },
            { id: "track-3", albumId: "album-2" },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "Best Album",
                year: 2024,
                coverUrl: null,
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 180 }],
            },
            {
                id: "album-2",
                title: "Other Album",
                year: 2023,
                coverUrl: null,
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-2",
                    name: "Artist Two",
                },
                tracks: [{ duration: 200 }],
            },
        ]);

        await handleGetAlbumList2(
            buildReq({
                type: "frequent",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            albumList2: { album: Array<{ id: string }> };
        };
        expect(payload.albumList2.album[0]).toEqual(
            expect.objectContaining({
                id: "al-album-1",
            }),
        );
    });

    it("falls back to MIME suffix mapping when song MIME is missing", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            title: "Unknown MIME",
            trackNo: 1,
            discNo: 1,
            duration: 180,
            fileSize: 1000,
            mime: null,
            filePath: "Artist/Unknown/track-1.wav",
            album: {
                id: "album-1",
                title: "Album One",
                year: 2024,
                coverUrl: null,
                genres: [],
                userGenres: [],
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
            },
        });

        await handleGetSong(buildReq({ id: "tr-track-1" }), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                song: expect.objectContaining({
                    contentType: "audio/wav",
                    suffix: "wav",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns not-found when getSong receives a malformed track id", async () => {
        await handleGetSong(
            buildReq({
                id: "al-album-1",
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

    it("returns declared OpenSubsonic extension capabilities", () => {
        handleGetOpenSubsonicExtensions(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                openSubsonicExtensions: expect.objectContaining({
                    openSubsonicExtension: expect.arrayContaining([
                        expect.objectContaining({
                            name: "apiKeyAuthentication",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns tokenInfo with authType derived from apiKey auth", () => {
        handleTokenInfo(
            buildReq({
                apiKey: "api-key-1",
            }),
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

    it("returns user capabilities for self username", async () => {
        mockUserFindUnique.mockResolvedValue({
            username: "alice",
            role: "user",
        });

        await handleGetUser(
            buildReq({
                username: "alice",
            }),
            buildRes(),
        );

        expect(mockUserFindUnique).toHaveBeenCalledWith({
            where: { username: "alice" },
            select: { username: true, role: true },
        });
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                user: expect.objectContaining({
                    username: "alice",
                    streamRole: true,
                }),
            }),
            "json",
            undefined,
        );
    });

    it("rejects non-admin request for another username", async () => {
        await handleGetUser(
            buildReq({
                username: "bob",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized",
            "json",
            undefined,
        );
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });
});
