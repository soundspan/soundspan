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
        MISSING_PARAMETER: 10,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
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
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
    handleGetAlbum,
    handleGetArtist,
    handleGetArtists,
    handleGetArtistInfo2,
    handleGetAlbumInfo2,
    handleSearch3,
    handleGetSong,
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

describe("subsonic entity compatibility handlers", () => {
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
    const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistFindFirst.mockResolvedValue(null);
        mockAlbumFindFirst.mockResolvedValue(null);
        mockAlbumFindMany.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
        mockTrackFindMany.mockResolvedValue([]);
    });

    it("returns indexed artists payload", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.test/artist-1.jpg",
                _count: {
                    albums: 2,
                },
            },
        ]);

        await handleGetArtists(buildReq({}), buildRes());

        const payload = mockSendSuccess.mock.calls[0][1] as {
            artists: {
                index: Array<{ artist: Array<Record<string, unknown>> }>;
            };
        };
        const indexedArtists = payload.artists.index.flatMap((entry) => entry.artist);

        expect(indexedArtists).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "ar-artist-1",
                    name: "Artist One",
                    albumCount: 2,
                }),
            ]),
        );
    });

    it("returns generic error when artists query fails", async () => {
        mockArtistFindMany.mockRejectedValueOnce(new Error("db down"));

        await handleGetArtists(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch artists",
            "json",
            undefined,
        );
    });

    it("returns not-found for invalid getArtist id", async () => {
        await handleGetArtist(
            buildReq({
                id: "tr-track-1",
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
    });

    it("returns not-found when getArtist has no library match", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);

        await handleGetArtist(
            buildReq({
                id: "ar-artist-1",
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
    });

    it("returns artist payload with albums", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-1",
            name: "Artist One",
            heroUrl: null,
            albums: [
                {
                    id: "album-1",
                    title: "Album One",
                    year: 2024,
                    coverUrl: null,
                    genres: ["rock"],
                    userGenres: null,
                    tracks: [{ duration: 120 }, { duration: 130 }],
                    _count: {
                        tracks: 2,
                    },
                },
            ],
        });

        await handleGetArtist(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                artist: expect.objectContaining({
                    id: "ar-artist-1",
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-1",
                            songCount: 2,
                            duration: 250,
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when artist lookup fails", async () => {
        mockArtistFindFirst.mockRejectedValueOnce(new Error("artist query failed"));

        await handleGetArtist(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch artist",
            "json",
            undefined,
        );
    });

    it("returns not-found for invalid getAlbum id", async () => {
        await handleGetAlbum(
            buildReq({
                id: "ar-artist-1",
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
    });

    it("returns album payload with songs", async () => {
        mockAlbumFindFirst.mockResolvedValueOnce({
            id: "album-1",
            title: "Album One",
            year: 2024,
            coverUrl: "https://example.test/cover.jpg",
            genres: ["indie"],
            userGenres: null,
            artist: {
                id: "artist-1",
                name: "Artist One",
            },
            tracks: [
                {
                    id: "track-1",
                    title: "Song One",
                    trackNo: 1,
                    discNo: 1,
                    duration: 180,
                    fileSize: 1024,
                    mime: "audio/mpeg",
                    filePath: "Artist One/Album One/01 Song One.mp3",
                },
            ],
        });

        await handleGetAlbum(
            buildReq({
                id: "al-album-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                album: expect.objectContaining({
                    id: "al-album-1",
                    artistId: "ar-artist-1",
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

    it("returns generic error when album lookup fails", async () => {
        mockAlbumFindFirst.mockRejectedValueOnce(new Error("album query failed"));

        await handleGetAlbum(
            buildReq({
                id: "al-album-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch album",
            "json",
            undefined,
        );
    });

    it("returns not-found for invalid getSong id", async () => {
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

    it("returns not-found when getSong id cannot be parsed", async () => {
        await handleGetSong(
            buildReq({
                id: "bad-song-id",
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

    it("returns song payload for library track", async () => {
        mockTrackFindFirst.mockResolvedValueOnce({
            id: "track-1",
            title: "Song One",
            trackNo: 1,
            discNo: 1,
            duration: 180,
            fileSize: 2048,
            mime: "audio/mpeg",
            filePath: "Artist One/Album One/01 Song One.mp3",
            album: {
                id: "album-1",
                title: "Album One",
                year: 2024,
                coverUrl: "https://example.test/cover.jpg",
                genres: ["indie"],
                userGenres: null,
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
            },
        });

        await handleGetSong(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                song: expect.objectContaining({
                    id: "tr-track-1",
                    albumId: "al-album-1",
                    artistId: "ar-artist-1",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when song lookup fails", async () => {
        mockTrackFindFirst.mockRejectedValueOnce(new Error("song query failed"));

        await handleGetSong(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch song",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for artistInfo2 without id", async () => {
        await handleGetArtistInfo2(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns not-found for malformed artistInfo2 id", async () => {
        await handleGetArtistInfo2(
            buildReq({
                id: "bad-id",
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
    });

    it("returns not-found when getArtistInfo2 artist is absent", async () => {
        await handleGetArtistInfo2(
            buildReq({
                id: "ar-artist-1",
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
    });

    it("returns generic error when artistInfo2 lookup fails", async () => {
        mockArtistFindFirst.mockRejectedValueOnce(new Error("artist info failed"));

        await handleGetArtistInfo2(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch artist info",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for albumInfo2 without id", async () => {
        await handleGetAlbumInfo2(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns not-found for malformed albumInfo2 id", async () => {
        await handleGetAlbumInfo2(
            buildReq({
                id: "bad-id",
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
    });

    it("returns not-found when getAlbumInfo2 album is absent", async () => {
        await handleGetAlbumInfo2(
            buildReq({
                id: "al-album-1",
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
    });

    it("returns generic error when albumInfo2 lookup fails", async () => {
        mockAlbumFindFirst.mockRejectedValueOnce(new Error("album info failed"));

        await handleGetAlbumInfo2(
            buildReq({
                id: "al-album-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch album info",
            "json",
            undefined,
        );
    });

    it("returns generic error when search3 fails", async () => {
        mockArtistFindMany.mockRejectedValueOnce(new Error("search failed"));

        await handleSearch3(
            buildReq({
                query: "rock",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to search",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for getSong when id is missing", async () => {
        await handleGetSong(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for search3 when query is missing", async () => {
        await handleSearch3(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'query' is missing",
            "json",
            undefined,
        );
    });
});
