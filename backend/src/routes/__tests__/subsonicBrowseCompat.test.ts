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
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        play: {
            groupBy: jest.fn(),
        },
        genre: {
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
    handleGetAlbumList2,
    handleGetArtists,
    handleGetGenres,
    handleGetIndexes,
    handleGetMusicDirectory,
    handleGetSimilarSongs,
    handleGetSimilarSongs2,
    handleGetRandomSongs,
    handleGetSongsByGenre,
    handleGetTopSongs,
    handleSearch2,
    handleSearch3,
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

describe("subsonic browse compatibility handlers", () => {
    const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
    const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
    const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
    const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
    const mockGenreFindMany = prisma.genre.findMany as jest.Mock;
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPlayGroupBy.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
    });

    it("returns albumList2 results for alphabeticalByName", async () => {
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-1",
                title: "A Album",
                year: 2024,
                coverUrl: "https://example.test/cover.jpg",
                genres: ["synthwave"],
                userGenres: null,
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 120 }, { duration: 140 }],
            },
        ]);

        await handleGetAlbumList2(
            buildReq({
                type: "alphabeticalByName",
                size: "1",
                offset: "0",
            }),
            buildRes(),
        );

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { location: "LIBRARY" },
                skip: 0,
                take: 1,
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumList2: expect.objectContaining({
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-1",
                            artistId: "ar-artist-1",
                            songCount: 2,
                            genre: "synthwave",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns empty indexes for unsupported musicFolderId", async () => {
        await handleGetIndexes(
            buildReq({
                musicFolderId: "99",
            }),
            buildRes(),
        );

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

    it("returns empty indexes when ifModifiedSince is current", async () => {
        const lastSynced = new Date("2026-02-14T00:00:00.000Z");
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.test/artist.jpg",
                lastSynced,
                _count: {
                    albums: 2,
                },
            },
        ]);

        await handleGetIndexes(
            buildReq({
                ifModifiedSince: String(lastSynced.getTime()),
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                indexes: expect.objectContaining({
                    lastModified: lastSynced.getTime(),
                    index: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns empty artist index for unsupported musicFolderId", async () => {
        await handleGetArtists(
            buildReq({
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                artists: expect.objectContaining({
                    index: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns missing parameter error for byYear without year bounds", async () => {
        await handleGetAlbumList2(
            buildReq({
                type: "byYear",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameters 'fromYear' and 'toYear' are missing or invalid",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter error for albumList2 when type is missing", async () => {
        await handleGetAlbumList2(
            buildReq({
                size: "1",
                offset: "0",
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

    it("filters albumList2 by genre with normalized query and pagination", async () => {
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "album-2",
                title: "B Album",
                year: 2023,
                coverUrl: "https://example.test/cover2.jpg",
                genres: ["Rock"],
                userGenres: null,
                artist: {
                    id: "artist-2",
                    name: "Band Two",
                },
                tracks: [{ duration: 210 }],
                _count: {
                    tracks: 1,
                },
            },
        ]);

        await handleGetAlbumList2(
            buildReq({
                type: "byGenre",
                genre: " rock ",
                size: "1",
                offset: "0",
            }),
            buildRes(),
        );

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    location: "LIBRARY",
                    tracks: {
                        some: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: {
                                            equals: "rock",
                                            mode: "insensitive",
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
                take: 1,
                skip: 0,
            }),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumList2: expect.objectContaining({
                    album: expect.arrayContaining([
                        expect.objectContaining({
                            id: "al-album-2",
                            artistId: "ar-artist-2",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("normalizes reversed byYear bounds for albumList2", async () => {
        mockAlbumFindMany.mockResolvedValue([]);

        await handleGetAlbumList2(
            buildReq({
                type: "byYear",
                fromYear: "2025",
                toYear: "2020",
                size: "5",
                offset: "1",
            }),
            buildRes(),
        );

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    location: "LIBRARY",
                    year: {
                        gte: 2020,
                        lte: 2025,
                    },
                }),
                orderBy: [
                    {
                        year: "desc",
                    },
                    {
                        title: "asc",
                    },
                    {
                        id: "asc",
                    },
                ],
                skip: 1,
                take: 5,
            }),
        );
    });

    it("returns root music directory with artist children", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.test/artist.jpg",
                albums: [{ id: "album-1" }, { id: "album-2" }],
            },
            {
                id: "artist-2",
                name: "Artist Two",
                heroUrl: null,
                albums: [{ id: "album-3" }],
            },
        ]);

        await handleGetMusicDirectory(
            buildReq({
                id: "1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                directory: expect.objectContaining({
                    id: "1",
                    child: expect.arrayContaining([
                        expect.objectContaining({
                            id: "ar-artist-1",
                            parent: "1",
                            isDir: true,
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when root directory lookup fails", async () => {
        mockArtistFindMany.mockRejectedValue(new Error("catalog unavailable"));

        await handleGetMusicDirectory(
            buildReq({
                id: "1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch directory",
            "json",
            undefined,
        );
    });

    it("returns artist music directory when artist id is requested", async () => {
        mockArtistFindFirst.mockResolvedValue({
            id: "artist-1",
            name: "Artist One",
            albums: [
                {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    tracks: [{ duration: 120 }, { duration: 140 }],
                },
            ],
        });

        await handleGetMusicDirectory(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                directory: expect.objectContaining({
                    id: "ar-artist-1",
                    parent: "1",
                    child: expect.arrayContaining([
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

    it("returns album music directory with song entries", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            id: "album-1",
            title: "A Album",
            year: 2024,
            coverUrl: "https://example.test/cover.jpg",
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
                    duration: 200,
                    fileSize: 1234,
                    mime: "audio/mpeg",
                    filePath: "Artist One/A Album/01 Song One.mp3",
                },
            ],
        });

        await handleGetMusicDirectory(
            buildReq({
                id: "al-album-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                directory: expect.objectContaining({
                    id: "al-album-1",
                    child: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-1",
                            albumId: "al-album-1",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns genre list with song and album counts", async () => {
        mockGenreFindMany.mockResolvedValue([
            {
                name: "rock",
                trackGenres: [
                    { track: { albumId: "album-1" } },
                    { track: { albumId: "album-2" } },
                    { track: { albumId: "album-1" } },
                ],
            },
        ]);

        await handleGetGenres(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                genres: expect.objectContaining({
                    genre: expect.arrayContaining([
                        expect.objectContaining({
                            value: "rock",
                            songCount: 3,
                            albumCount: 2,
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns songs for a requested genre", async () => {
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                trackNo: 1,
                discNo: 1,
                duration: 200,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/A Album/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    genres: ["rock"],
                    userGenres: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleGetSongsByGenre(
            buildReq({
                genre: "rock",
                count: "10",
                offset: "0",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    trackGenres: expect.anything(),
                }),
                take: 10,
                skip: 0,
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                songsByGenre: expect.objectContaining({
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-1",
                            albumId: "al-album-1",
                            genre: "rock",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns missing-parameter error when songsByGenre genre is absent", async () => {
        await handleGetSongsByGenre(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'genre' is missing",
            "json",
            undefined,
        );
    });

    it("returns random songs with applied filters", async () => {
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Song One",
                trackNo: 1,
                discNo: 1,
                duration: 200,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/A Album/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    genres: ["jazz"],
                    userGenres: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleGetRandomSongs(
            buildReq({
                size: "10",
                genre: "rock",
                fromYear: "2020",
                toYear: "2025",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    trackGenres: expect.anything(),
                }),
                take: 5000,
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                randomSongs: expect.objectContaining({
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-1",
                            genre: "rock",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns search2 payload for matching artists, albums, and songs", async () => {
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
                title: "A Album",
                year: 2024,
                coverUrl: "https://example.test/cover.jpg",
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 200 }],
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
                duration: 200,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/A Album/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSearch2(
            buildReq({
                query: "artist one",
                artistCount: "5",
                albumCount: "5",
                songCount: "5",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult2: expect.objectContaining({
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

    it("treats quoted empty search2 query with zero counts as full-sync request", async () => {
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
                title: "A Album",
                year: 2024,
                coverUrl: "https://example.test/cover.jpg",
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 200 }],
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
                duration: 200,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/A Album/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSearch2(
            buildReq({
                query: "\"\"",
                artistCount: "0",
                albumCount: "0",
                songCount: "0",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    albums: {
                        some: {
                            location: "LIBRARY",
                        },
                    },
                }),
                take: 5000,
            }),
        );
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    location: "LIBRARY",
                }),
                take: 5000,
            }),
        );
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    album: {
                        location: "LIBRARY",
                    },
                }),
                take: 50000,
            }),
        );
    });

    it("returns empty search2 payload for unsupported musicFolderId", async () => {
        await handleSearch2(
            buildReq({
                query: "artist one",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(mockAlbumFindMany).not.toHaveBeenCalled();
        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult2: {
                    artist: [],
                    album: [],
                    song: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("treats quoted empty search3 query with zero counts as full-sync request", async () => {
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
                title: "A Album",
                year: 2024,
                coverUrl: "https://example.test/cover.jpg",
                artist: {
                    id: "artist-1",
                    name: "Artist One",
                },
                tracks: [{ duration: 200 }],
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
                duration: 200,
                fileSize: 1234,
                mime: "audio/mpeg",
                filePath: "Artist One/A Album/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "A Album",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleSearch3(
            buildReq({
                query: "\"\"",
                artistCount: "0",
                albumCount: "0",
                songCount: "0",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 5000,
            }),
        );
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 5000,
            }),
        );
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 50000,
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult3: expect.objectContaining({
                    artist: expect.any(Array),
                    album: expect.any(Array),
                    song: expect.any(Array),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("passes through large search3 offsets without clamping", async () => {
        mockArtistFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);

        await handleSearch3(
            buildReq({
                query: "\"\"",
                artistCount: "100",
                albumCount: "100",
                songCount: "1000",
                artistOffset: "12000",
                albumOffset: "13000",
                songOffset: "14000",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 12000,
                take: 100,
            }),
        );
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 13000,
                take: 100,
            }),
        );
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 14000,
                take: 1000,
            }),
        );
    });

    it("returns ordered top songs by play counts and metadata tie-breakers", async () => {
        mockArtistFindFirst.mockResolvedValue({
            id: "artist-1",
            name: "Artist One",
        });
        mockPlayGroupBy.mockResolvedValue([
            {
                trackId: "track-1",
                _count: {
                    _all: 10,
                },
            },
            {
                trackId: "track-2",
                _count: {
                    _all: 1,
                },
            },
            {
                trackId: "track-3",
                _count: {
                    _all: 1,
                },
            },
            {
                trackId: "track-4",
                _count: {
                _all: 1,
                },
            },
        ]);
        const album = {
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
        };
        const buildTrack = (
            id: string,
            title: string,
            trackNo: number,
            discNo: number,
        ) => ({
            id,
            title,
            trackNo,
            discNo,
            duration: 120,
            fileSize: 1000,
            mime: "audio/mpeg",
            filePath: `Artist One/Album One/${title}.mp3`,
            album,
        });
        mockTrackFindMany.mockResolvedValue([
            buildTrack("track-1", "Omega", 1, 2),
            buildTrack("track-2", "Zulu", 3, 1),
            buildTrack("track-3", "Bravo", 1, 1),
            buildTrack("track-4", "Alpha", 1, 1),
        ]);

        await handleGetTopSongs(
            buildReq({
                artist: "Artist One",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            topSongs: { song: Array<{ id: string }> };
        };
        expect(payload.topSongs.song.map((song) => song.id)).toEqual([
            "tr-track-1",
            "tr-track-4",
            "tr-track-3",
            "tr-track-2",
        ]);
    });

    it("returns generic error when top songs lookup throws", async () => {
        mockArtistFindFirst.mockResolvedValue({
            id: "artist-1",
            name: "Artist One",
        });
        mockPlayGroupBy.mockRejectedValue(new Error("db down"));

        await handleGetTopSongs(
            buildReq({
                artist: "Artist One",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch top songs",
            "json",
            undefined,
        );
    });

    it("returns generic error for similarSongs2 when source track lookup fails", async () => {
        mockTrackFindFirst.mockRejectedValue(new Error("db down"));

        await handleGetSimilarSongs2(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch similar songs",
            "json",
            undefined,
        );
    });

    it("returns empty similarSongs result when artist has no similar artists", async () => {
        mockArtistFindFirst
            .mockResolvedValueOnce({
                id: "artist-1",
            })
            .mockResolvedValueOnce({
                similarFrom: [],
            });

        await handleGetSimilarSongs(
            buildReq({
                id: "ar-artist-1",
                count: "10",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                similarSongs: {
                    song: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("orders similarSongs deterministically by rank and secondary tie-break fields", async () => {
        const buildTrack = (
            id: string,
            artistId: string,
            albumId: string,
            albumTitle: string,
            trackNo: number,
            discNo: number,
        ) => ({
            id,
            title: `Track ${id}`,
            trackNo,
            discNo,
            duration: 120,
            fileSize: 1000,
            mime: "audio/mpeg",
            filePath: `${albumId}/${id}.mp3`,
            album: {
                id: albumId,
                title: albumTitle,
                year: 2026,
                coverUrl: null,
                genres: [],
                userGenres: null,
                artist: {
                    id: artistId,
                    name: `Artist ${artistId}`,
                },
            },
        });

        mockArtistFindFirst
            .mockResolvedValueOnce({
                id: "artist-seed",
            })
            .mockResolvedValueOnce({
                similarFrom: [
                    {
                        toArtist: {
                            id: "artist-primary",
                            albums: [{ id: "album-primary" }],
                        },
                    },
                    {
                        toArtist: {
                            id: "artist-secondary",
                            albums: [{ id: "album-secondary" }],
                        },
                    },
                ],
            });

        mockTrackFindMany.mockResolvedValue([
            buildTrack("track-z", "artist-primary", "album-beta", "Beta", 1, 1),
            buildTrack("track-a", "artist-secondary", "album-alpha", "Alpha", 2, 1),
            buildTrack("track-b", "artist-secondary", "album-alpha", "Alpha", 2, 1),
            buildTrack("track-c", "artist-secondary", "album-alpha", "Alpha", 3, 1),
            buildTrack("track-d", "artist-secondary", "album-alpha", "Alpha", 1, 2),
            buildTrack("track-e", "artist-secondary", "album-beta", "Beta", 5, 1),
        ]);

        await handleGetSimilarSongs(
            buildReq({
                id: "ar-artist-seed",
                count: "10",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls[0][1] as {
            similarSongs: { song: Array<{ id: string }> };
        };
        expect(payload.similarSongs.song.map((song) => song.id)).toEqual([
            "tr-track-z",
            "tr-track-a",
            "tr-track-b",
            "tr-track-c",
            "tr-track-d",
            "tr-track-e",
        ]);
    });

    it("returns generic error for similarSongs when lookup fails", async () => {
        mockArtistFindFirst
            .mockResolvedValueOnce({ id: "artist-1" })
            .mockRejectedValueOnce(new Error("db down"));

        await handleGetSimilarSongs(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch similar songs",
            "json",
            undefined,
        );
    });

    it("returns empty similarSongs2 when musicFolderId is unsupported", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            album: {
                artist: {
                    id: "artist-1",
                },
                genres: [],
                userGenres: null,
            },
            trackGenres: [],
        });

        await handleGetSimilarSongs2(
            buildReq({
                id: "tr-track-1",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                similarSongs2: {
                    song: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns not-found for similarSongs2 when provided id is an artist-prefixed value", async () => {
        await handleGetSimilarSongs2(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockTrackFindFirst).not.toHaveBeenCalled();
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("returns missing-parameter for search2 when query is omitted", async () => {
        await handleSearch2(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'query' is missing",
            "json",
            undefined,
        );
    });

    it("returns generic error when search2 execution throws", async () => {
        mockArtistFindMany.mockRejectedValue(new Error("db down"));

        await handleSearch2(
            buildReq({
                query: "Artist",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to search",
            "json",
            undefined,
        );
    });

    it("returns indexed artists payload for getIndexes without filters", async () => {
        const lastSynced = new Date("2026-01-01T00:00:00.000Z");
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "https://example.test/artist.jpg",
                lastSynced,
                _count: {
                    albums: 2,
                },
            },
        ]);

        await handleGetIndexes(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                indexes: expect.objectContaining({
                    lastModified: lastSynced.getTime(),
                    index: expect.arrayContaining([
                        expect.objectContaining({
                            name: "A",
                            artist: expect.arrayContaining([
                                expect.objectContaining({
                                    id: "ar-artist-1",
                                    name: "Artist One",
                                    albumCount: 2,
                                    coverArt: "ar-artist-1",
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

    it("returns indexed artist groups in artists endpoint", async () => {
        mockArtistFindMany.mockResolvedValue([
            {
                id: "artist-1",
                name: "Band One",
                heroUrl: null,
                _count: {
                    albums: 1,
                },
            },
        ]);

        await handleGetArtists(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                artists: expect.objectContaining({
                    index: expect.arrayContaining([
                        expect.objectContaining({
                            name: "B",
                            artist: expect.arrayContaining([
                                expect.objectContaining({
                                    id: "ar-artist-1",
                                    name: "Band One",
                                    albumCount: 1,
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

    it("returns error when requested music directory does not exist", async () => {
        mockArtistFindFirst.mockResolvedValue(null);

        await handleGetMusicDirectory(
            buildReq({
                id: "ar-missing",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            70,
            "Directory not found",
            "json",
            undefined,
        );
    });

    it("falls back to album lookup for unprefixed directory id", async () => {
        mockArtistFindFirst.mockResolvedValue(null);
        mockAlbumFindFirst.mockResolvedValue({
            id: "album-1",
            title: "Fallback Album",
            year: 2020,
            coverUrl: null,
            genres: [],
            userGenres: null,
            artist: {
                id: "artist-1",
                name: "Artist One",
            },
            tracks: [],
        });

        await handleGetMusicDirectory(
            buildReq({
                id: "album-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                directory: expect.objectContaining({
                    id: "al-album-1",
                    child: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("trims malformed directory id before fallback lookup", async () => {
        mockArtistFindFirst.mockResolvedValue(null);
        mockAlbumFindFirst.mockResolvedValue({
            id: "album-2",
            title: "Trimmed Album",
            year: 2020,
            coverUrl: null,
            genres: [],
            userGenres: null,
            artist: {
                id: "artist-2",
                name: "Artist Two",
            },
            tracks: [],
        });

        await handleGetMusicDirectory(
            buildReq({
                id: "   album-2   ",
            }),
            buildRes(),
        );

        expect(mockAlbumFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "album-2",
                }),
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                directory: expect.objectContaining({
                    id: "al-album-2",
                    child: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when music directory lookup throws", async () => {
        mockArtistFindFirst.mockRejectedValue(new Error("db down"));

        await handleGetMusicDirectory(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            undefined,
            "Failed to fetch directory",
            "json",
            undefined,
        );
    });

    it("returns empty songs-by-genre result for unsupported musicFolderId", async () => {
        await handleGetSongsByGenre(
            buildReq({
                genre: "rock",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                songsByGenre: {
                    song: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns empty randomSongs result for unsupported musicFolderId", async () => {
        await handleGetRandomSongs(
            buildReq({
                size: "10",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                randomSongs: {
                    song: [],
                },
            }),
            "json",
            undefined,
        );
    });

    it("returns empty search3 payload for unsupported musicFolderId", async () => {
        await handleSearch3(
            buildReq({
                query: "artist one",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(mockAlbumFindMany).not.toHaveBeenCalled();
        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                searchResult3: expect.objectContaining({
                    artist: [],
                    album: [],
                    song: [],
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns missing-track error for similarSongs2 when source track is absent", async () => {
        mockTrackFindFirst.mockResolvedValue(null);

        await handleGetSimilarSongs2(
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
    });

    it("returns not-found for topSongs when artist cannot be resolved", async () => {
        mockArtistFindFirst.mockResolvedValue(null);

        await handleGetTopSongs(
            buildReq({
                artist: "Unknown Artist",
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

    it("returns empty albumList2 payload for unsupported music folder", async () => {
        await handleGetAlbumList2(
            buildReq({
                type: "random",
                musicFolderId: "99",
            }),
            buildRes(),
        );

        expect(mockAlbumFindMany).not.toHaveBeenCalled();
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumList2: expect.objectContaining({
                    album: [],
                }),
            }),
            "json",
            undefined,
        );
    });
});
