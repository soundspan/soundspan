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
        artist: {
            findFirst: jest.fn(),
        },
        album: {
            findFirst: jest.fn(),
        },
        play: {
            groupBy: jest.fn(),
        },
        track: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
        },
        playlist: {
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
import { getLyrics } from "../../services/lyrics";
import {
    handleGetAlbumInfo2,
    handleGetArtistInfo2,
    handleGetSimilarSongs,
    handleGetSimilarSongs2,
    handleGetTopSongs,
    handleGetLyricsBySongId,
    handleGetCoverArt,
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

describe("subsonic metadata compatibility handlers", () => {
    const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
    const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockPlaylistFindFirst = prisma.playlist.findFirst as jest.Mock;
    const mockGetLyrics = getLyrics as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPlayGroupBy.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
        mockTrackFindMany.mockResolvedValue([]);
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockGetLyrics.mockResolvedValue({
            syncedLyrics: null,
            plainLyrics: null,
        });
    });

    function buildCoverArtRes(): Response {
        const res: Partial<Response> = {
            setHeader: jest.fn(),
            status: jest.fn(),
            send: jest.fn(),
        };
        (res.status as jest.Mock).mockReturnValue(res);
        return res as Response;
    }

    it("returns artistInfo2 payload with similar artists", async () => {
        mockArtistFindFirst.mockResolvedValue({
            id: "artist-1",
            name: "Artist One",
            mbid: "mbid-artist-1",
            summary: "Artist summary",
            heroUrl: "https://example.test/artist.jpg",
            similarFrom: [
                {
                    weight: 1,
                    toArtist: {
                        id: "artist-2",
                        name: "Artist Two",
                        heroUrl: null,
                        albums: [{ id: "album-2" }],
                    },
                },
            ],
        });

        await handleGetArtistInfo2(
            buildReq({
                id: "ar-artist-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                artistInfo2: expect.objectContaining({
                    musicBrainzId: "mbid-artist-1",
                    similarArtist: expect.arrayContaining([
                        expect.objectContaining({
                            id: "ar-artist-2",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns albumInfo2 payload", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            rgMbid: "mbid-album-1",
            title: "Album One",
            coverUrl: "https://example.test/cover.jpg",
        });

        await handleGetAlbumInfo2(
            buildReq({
                id: "al-album-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                albumInfo2: expect.objectContaining({
                    musicBrainzId: "mbid-album-1",
                    notes: "Album One",
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns top songs sorted by play count", async () => {
        mockArtistFindFirst.mockResolvedValue({
            id: "artist-1",
            name: "Artist One",
        });
        mockPlayGroupBy.mockResolvedValue([
            {
                trackId: "track-2",
                _count: {
                    _all: 20,
                },
            },
            {
                trackId: "track-1",
                _count: {
                    _all: 5,
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
                fileSize: 1000,
                mime: "audio/mpeg",
                filePath: "Artist One/Album One/01 Song One.mp3",
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
            {
                id: "track-2",
                title: "Song Two",
                trackNo: 2,
                discNo: 1,
                duration: 200,
                fileSize: 1100,
                mime: "audio/mpeg",
                filePath: "Artist One/Album One/02 Song Two.mp3",
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2024,
                    coverUrl: "https://example.test/cover.jpg",
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleGetTopSongs(
            buildReq({
                artist: "Artist One",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                topSongs: expect.objectContaining({
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-2",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("falls back to name lookup for top songs when artist includes hyphen", async () => {
        mockArtistFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "artist-1",
                name: "Artist One - Live",
            });

        await handleGetTopSongs(
            buildReq({
                artist: "Artist One - Live",
            }),
            buildRes(),
        );

        expect(mockArtistFindFirst).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "Artist One - Live",
                }),
            }),
        );
        expect(mockArtistFindFirst).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    name: expect.objectContaining({
                        equals: "Artist One - Live",
                        mode: "insensitive",
                    }),
                }),
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalled();
    });

    it("returns not-found for unknown top-songs artist", async () => {
        mockArtistFindFirst.mockResolvedValue(null);

        await handleGetTopSongs(
            buildReq({
                artist: "Missing Artist",
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

    it("returns similar songs for an artist", async () => {
        mockArtistFindFirst
            .mockResolvedValueOnce({
                id: "artist-1",
            })
            .mockResolvedValueOnce({
                similarFrom: [
                    {
                        toArtist: {
                            id: "artist-2",
                            albums: [{ id: "album-2" }],
                        },
                    },
                ],
            });
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-2",
                title: "Related Song",
                trackNo: 1,
                discNo: 1,
                duration: 210,
                fileSize: 1200,
                mime: "audio/mpeg",
                filePath: "Artist Two/Album Two/01 Related Song.mp3",
                album: {
                    id: "album-2",
                    title: "Album Two",
                    year: 2023,
                    coverUrl: "https://example.test/cover-2.jpg",
                    genres: ["rock"],
                    userGenres: null,
                    artist: {
                        id: "artist-2",
                        name: "Artist Two",
                    },
                },
            },
        ]);

        await handleGetSimilarSongs(
            buildReq({
                id: "ar-artist-1",
                count: "10",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                similarSongs: expect.objectContaining({
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-2",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns similar songs for a track", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            album: {
                artist: {
                    id: "artist-1",
                },
                genres: ["indie"],
                userGenres: null,
            },
            trackGenres: [
                {
                    genre: {
                        name: "rock",
                    },
                },
            ],
        });
        mockArtistFindFirst.mockResolvedValue({
            similarFrom: [
                {
                    toArtist: {
                        id: "artist-2",
                        albums: [{ id: "album-2" }],
                    },
                },
            ],
        });
        mockTrackFindMany
            .mockResolvedValueOnce([
                {
                    id: "track-2",
                    title: "Related Song",
                    trackNo: 1,
                    discNo: 1,
                    duration: 205,
                    fileSize: 1200,
                    mime: "audio/mpeg",
                    filePath: "Artist Two/Album Two/01 Related Song.mp3",
                    album: {
                        id: "album-2",
                        title: "Album Two",
                        year: 2023,
                        coverUrl: "https://example.test/cover-2.jpg",
                        genres: ["rock"],
                        userGenres: null,
                        artist: {
                            id: "artist-2",
                            name: "Artist Two",
                        },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        await handleGetSimilarSongs2(
            buildReq({
                id: "tr-track-1",
                count: "5",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                similarSongs2: expect.objectContaining({
                    song: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-2",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns not-found when similarSongs2 source track is missing", async () => {
        mockTrackFindFirst.mockResolvedValue(null);

        await handleGetSimilarSongs2(
            buildReq({
                id: "tr-track-missing",
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

    it("returns missing-parameter when similarSongs id is absent", async () => {
        await handleGetSimilarSongs(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns plain lyrics line items when synced lyrics are unavailable", async () => {
        mockTrackFindFirst.mockResolvedValue({
            title: "Song One",
            album: {
                artist: {
                    name: "Artist One",
                },
            },
        });
        mockGetLyrics.mockResolvedValue({
            syncedLyrics: null,
            plainLyrics: "Verse 1\nVerse 2",
        });

        await handleGetLyricsBySongId(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                lyricsList: expect.objectContaining({
                    structuredLyrics: expect.arrayContaining([
                        expect.objectContaining({
                            synced: false,
                            line: expect.arrayContaining([
                                expect.objectContaining({
                                    value: "Verse 1\nVerse 2",
                                    start: 0,
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

    it("resolves cover art from the generic lookup when a typed entity id cannot be parsed", async () => {
        mockAlbumFindFirst.mockResolvedValue(null);
        mockArtistFindFirst.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue(null);
        mockPlaylistFindFirst.mockResolvedValue({
            items: [
                {
                    track: {
                        album: {
                            coverUrl: "https://cdn.soundspan.test/covers/playlist.jpg",
                        },
                    },
                },
            ],
        });

        const originalFetch = global.fetch;
        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest.fn().mockResolvedValue(Buffer.from("playlist-cover")),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const res = buildCoverArtRes();

        await handleGetCoverArt(
            buildReq({
                id: " loose-entity-id ",
            }),
            res,
        );

        expect(mockPlaylistFindFirst).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "loose-entity-id",
                userId: "user-1",
            }),
            select: {
                items: {
                    where: {
                        track: {
                            album: {
                                location: "LIBRARY",
                            },
                        },
                    },
                    orderBy: {
                        sort: "asc",
                    },
                    select: {
                        track: {
                            select: {
                                album: {
                                    select: {
                                        coverUrl: true,
                                        genres: true,
                                        userGenres: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 10,
                },
            },
        });
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/jpeg");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSendError).not.toHaveBeenCalled();

        global.fetch = originalFetch;
    });
});
