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
        MISSING_PARAMETER: 10,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
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

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
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
import { getLyrics } from "../../services/lyrics";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
    handleGetAlbumList,
    handleGetLyrics,
    handleSearch,
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

describe("subsonic legacy compatibility handlers", () => {
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockGetLyrics = getLyrics as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
    });

    it("returns legacy albumList payload key for getAlbumList", async () => {
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "Album One",
                year: 2020,
                coverUrl: null,
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [
                    {
                        duration: 180,
                    },
                ],
            },
        ]);

        await handleGetAlbumList(
            buildReq({
                type: "alphabeticalByName",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumList: expect.objectContaining({
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-1",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for legacy albumList without type", async () => {
        await handleGetAlbumList(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'type' is missing or invalid",
            "json",
            undefined,
        );
    });

    it("returns legacy searchResult payload key for search", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: null,
                _count: {
                    albums: 1,
                },
            },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "Album One",
                year: 2020,
                coverUrl: null,
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
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                trackNo: 1,
                discNo: 1,
                duration: 180,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/Album One/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2020,
                    coverUrl: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSearch(
            buildReq({
                query: "Song",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult: expect.objectContaining({
                    artist: expect.any(Array),
                    album: expect.any(Array),
                    song: expect.any(Array),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for legacy search without query", async () => {
        await handleSearch(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'query' is missing",
            "json",
            undefined,
        );
    });

    it("returns legacy lyrics payload for artist/title lookup", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockResolvedValue({
            plainLyrics: "line one\nline two",
            syncedLyrics: null,
        });

        await handleGetLyrics(
            buildReq({
                artist: "Artist One",
                title: "Song One",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                lyrics: expect.objectContaining({
                    artist: "Artist One",
                    title: "Song One",
                    value: "line one\nline two",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("requires artist or title for getLyrics", async () => {
        await handleGetLyrics(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'artist' or 'title' is missing",
            "json",
            undefined,
        );
    });

    it("returns empty lyrics when no matching track exists", async () => {
        mockTrackFindFirst.mockResolvedValue(null);

        await handleGetLyrics(
            buildReq({
                artist: "Missing Artist",
                title: "Missing Song",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                lyrics: expect.objectContaining({
                    artist: "Missing Artist",
                    title: "Missing Song",
                    value: "",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns parsed synced lyrics when plain lyrics is unavailable", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockResolvedValue({
            plainLyrics: null,
            syncedLyrics: "[00:01.00] line one\n[00:10.500] line two",
        });

        await handleGetLyrics(
            buildReq({
                artist: "Artist One",
                title: "Song One",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                lyrics: expect.objectContaining({
                    artist: "Artist One",
                    title: "Song One",
                    value: "line one\nline two",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when lyric lookup fails", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockRejectedValue(new Error("lyrics backend error"));

        await handleGetLyrics(
            buildReq({
                artist: "Artist One",
                title: "Song One",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch lyrics",
            "json",
            undefined,
        );
    });
});
