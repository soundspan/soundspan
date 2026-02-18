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
        NOT_AUTHORIZED: 50,
        NOT_FOUND: 70,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findFirst: jest.fn(),
        },
        playlist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            delete: jest.fn(),
        },
        playbackState: {
            findMany: jest.fn(),
        },
        track: {
            findFirst: jest.fn(),
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
import {
    sendSubsonicError,
    sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
    handleDeletePlaylist,
    handleGetLicense,
    handleGetMusicFolders,
    handleGetNowPlaying,
    handleGetPlaylist,
    handleGetPlaylists,
    handlePing,
    handleGetSimilarSongs,
    handleGetSimilarSongs2,
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

describe("subsonic collections/core compatibility handlers", () => {
    const mockPlaylistFindMany = prisma.playlist.findMany as jest.Mock;
    const mockPlaylistFindFirst = prisma.playlist.findFirst as jest.Mock;
    const mockPlaylistDelete = prisma.playlist.delete as jest.Mock;
    const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
    const mockPlaybackStateFindMany = prisma.playbackState.findMany as jest.Mock;
    const mockTrackFindMany = prisma.track.findMany as jest.Mock;
    const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;
    const mockSendSuccess = sendSubsonicSuccess as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPlaylistFindMany.mockResolvedValue([]);
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockArtistFindFirst.mockResolvedValue(null);
        mockPlaybackStateFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackFindFirst.mockResolvedValue(null);
    });

    it("returns protocol ping payload", () => {
        handlePing(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            { ping: {} },
            "json",
            undefined,
        );
    });

    it("returns protocol license payload", () => {
        handleGetLicense(buildReq({}), buildRes());

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

    it("returns static music folder list", () => {
        handleGetMusicFolders(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {
                musicFolders: {
                    musicFolder: [
                        {
                            id: 1,
                            name: "Music",
                        },
                    ],
                },
            },
            "json",
            undefined,
        );
    });

    it("returns playlists with derived songCount/duration/coverArt", async () => {
        mockPlaylistFindMany.mockResolvedValue([
            {
                id: "playlist-1",
                name: "Road Trip",
                isPublic: false,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                _count: {
                    items: 2,
                },
                items: [
                    {
                        track: {
                            duration: 180,
                            album: {
                                coverUrl: null,
                                genres: null,
                                userGenres: null,
                            },
                        },
                    },
                    {
                        track: {
                            duration: 120,
                            album: {
                                coverUrl: "https://example.test/covers/1.jpg",
                                genres: null,
                                userGenres: null,
                            },
                        },
                    },
                ],
            },
        ]);

        await handleGetPlaylists(buildReq({}), buildRes());

        expect(mockPlaylistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "user-1" },
                orderBy: { createdAt: "desc" },
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playlists: expect.objectContaining({
                    playlist: expect.arrayContaining([
                        expect.objectContaining({
                            id: "pl-playlist-1",
                            name: "Road Trip",
                            owner: "alice",
                            songCount: 2,
                            duration: 300,
                            coverArt: "pl-playlist-1",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns generic error when getPlaylists query fails", async () => {
        mockPlaylistFindMany.mockRejectedValueOnce(new Error("boom"));

        await handleGetPlaylists(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch playlists",
            "json",
            undefined,
        );
    });

    it("returns not-found when getPlaylist id is invalid", async () => {
        await handleGetPlaylist(
            buildReq({
                id: "tr-track-1",
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

    it("returns playlist entries for an owned playlist", async () => {
        mockPlaylistFindFirst.mockResolvedValue({
            id: "playlist-1",
            name: "Road Trip",
            isPublic: true,
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
            items: [
                {
                    track: {
                        id: "track-1",
                        title: "Song One",
                        trackNo: 1,
                        discNo: 1,
                        duration: 205,
                        fileSize: 1234,
                        mime: "audio/mpeg",
                        filePath: "Artist One/Album One/01 Song One.mp3",
                        album: {
                            id: "album-1",
                            title: "Album One",
                            year: 2024,
                            coverUrl: "https://example.test/covers/album-1.jpg",
                            genres: ["rock"],
                            userGenres: null,
                            artist: {
                                id: "artist-1",
                                name: "Artist One",
                            },
                        },
                    },
                },
            ],
        });

        await handleGetPlaylist(
            buildReq({
                id: "pl-playlist-1",
            }),
            buildRes(),
        );

        expect(mockPlaylistFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "playlist-1",
                    userId: "user-1",
                },
            }),
        );
        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playlist: expect.objectContaining({
                    id: "pl-playlist-1",
                    songCount: 1,
                    duration: 205,
                    owner: "alice",
                    coverArt: "pl-playlist-1",
                    entry: expect.arrayContaining([
                        expect.objectContaining({
                            id: "tr-track-1",
                            albumId: "al-album-1",
                            artistId: "ar-artist-1",
                        }),
                    ]),
                }),
            }),
            "json",
            undefined,
        );
    });

    it("returns not-found when getPlaylist id is missing", async () => {
        await handleGetPlaylist(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalled();
    });

    it("returns not-found when playlist is absent for the authenticated user", async () => {
        mockPlaylistFindFirst.mockResolvedValue(null);

        await handleGetPlaylist(
            buildReq({
                id: "pl-playlist-missing",
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

    it("returns generic error when getPlaylist query fails", async () => {
        mockPlaylistFindFirst.mockRejectedValueOnce(new Error("playlist query failed"));

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

    it("returns not-authorized when deleting a playlist the user does not own", async () => {
        mockPlaylistFindFirst.mockResolvedValue(null);

        await handleDeletePlaylist(
            buildReq({
                id: "pl-playlist-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            50,
            "Not authorized to delete this playlist",
            "json",
            undefined,
        );
        expect(mockPlaylistDelete).not.toHaveBeenCalled();
    });

    it("returns not-found when deleting with a malformed playlist id", async () => {
        await handleDeletePlaylist(
            buildReq({
                id: "al-not-a-playlist",
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
        expect(mockPlaylistDelete).not.toHaveBeenCalled();
    });

    it("deletes an owned playlist", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockPlaylistDelete.mockResolvedValue({ id: "playlist-1" });

        await handleDeletePlaylist(
            buildReq({
                id: "pl-playlist-1",
            }),
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

    it("returns generic error when playlist deletion throws", async () => {
        mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
        mockPlaylistDelete.mockRejectedValue(new Error("delete failed"));

        await handleDeletePlaylist(
            buildReq({
                id: "pl-playlist-1",
            }),
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

    it("returns empty nowPlaying list when there are no recent tracked sessions", async () => {
        mockPlaybackStateFindMany.mockResolvedValue([]);

        await handleGetNowPlaying(buildReq({}), buildRes());

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {
                nowPlaying: {
                    entry: [],
                },
            },
            "json",
            undefined,
        );
    });

    it("returns nowPlaying entries and filters playback rows with missing tracks", async () => {
        const now = Date.now();
        mockPlaybackStateFindMany.mockResolvedValue([
            {
                trackId: "track-1",
                updatedAt: new Date(now - 2 * 60 * 1000),
                deviceId: "web-player",
            },
            {
                trackId: "track-missing",
                updatedAt: new Date(now - 1 * 60 * 1000),
                deviceId: "mobile-player",
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
                    year: 2024,
                    coverUrl: "https://example.test/covers/album-1.jpg",
                    genres: ["rock"],
                    userGenres: null,
                    artist: {
                        id: "artist-1",
                        name: "Artist One",
                    },
                },
            },
        ]);

        await handleGetNowPlaying(buildReq({}), buildRes());

        const nowPlayingPayload = mockSendSuccess.mock.calls.at(-1)?.[1] as {
            nowPlaying: { entry: Array<Record<string, unknown>> };
        };

        expect(nowPlayingPayload.nowPlaying.entry).toHaveLength(1);
        expect(nowPlayingPayload.nowPlaying.entry[0]).toEqual(
            expect.objectContaining({
                id: "tr-track-1",
                username: "alice",
                playerId: "web-player",
            }),
        );
    });

    it("returns generic error when getNowPlaying fails", async () => {
        mockPlaybackStateFindMany.mockRejectedValueOnce(new Error("db unavailable"));

        await handleGetNowPlaying(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            0,
            "Failed to fetch now playing",
            "json",
            undefined,
        );
    });

    it("returns empty similarSongs payload for unsupported musicFolderId", async () => {
        await handleGetSimilarSongs(
            buildReq({
                id: "ar-artist-1",
                musicFolderId: "2",
            }),
            buildRes(),
        );

        expect(mockSendSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {
                similarSongs: {
                    song: [],
                },
            },
            "json",
            undefined,
        );
    });

    it("returns not-found for malformed getSimilarSongs id", async () => {
        await handleGetSimilarSongs(
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

    it("returns not-found when getSimilarSongs artist is absent", async () => {
        await handleGetSimilarSongs(
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

    it("deduplicates duplicate tracks when building similarSongs2", async () => {
        const duplicateTrack = {
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
        };

        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            album: {
                artist: {
                    id: "artist-1",
                },
                genres: ["rock"],
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
            .mockResolvedValueOnce([duplicateTrack])
            .mockResolvedValueOnce([duplicateTrack])
            .mockResolvedValueOnce([duplicateTrack]);

        await handleGetSimilarSongs2(
            buildReq({
                id: "tr-track-1",
                count: "10",
            }),
            buildRes(),
        );

        const payload = mockSendSuccess.mock.calls.at(-1)?.[1] as {
            similarSongs2: { song: Array<Record<string, unknown>> };
        };

        expect(payload.similarSongs2.song).toHaveLength(1);
        expect(payload.similarSongs2.song[0]).toEqual(
            expect.objectContaining({
                id: "tr-track-2",
            }),
        );
    });
});
