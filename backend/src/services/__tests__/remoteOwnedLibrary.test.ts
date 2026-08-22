jest.mock("../../utils/db", () => ({
    prisma: {
        trackTidal: {
            findMany: jest.fn(),
            count: jest.fn(),
        },
        trackYtMusic: {
            findMany: jest.fn(),
            count: jest.fn(),
        },
    },
}));

import { prisma } from "../../utils/db";
import {
    addRemoteOwnedArtists,
    buildRemoteOwnedArtistFilters,
    countRemoteOwnedTracksForUser,
    loadRemoteOwnedTracksForUser,
    toLibraryRemoteTrack,
} from "../remoteOwnedLibrary";

const mockTidalFindMany = prisma.trackTidal.findMany as jest.Mock;
const mockTidalCount = prisma.trackTidal.count as jest.Mock;
const mockYtMusicFindMany = prisma.trackYtMusic.findMany as jest.Mock;
const mockYtMusicCount = prisma.trackYtMusic.count as jest.Mock;

describe("remote owned library", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTidalFindMany.mockResolvedValue([]);
        mockYtMusicFindMany.mockResolvedValue([]);
        mockTidalCount.mockResolvedValue(0);
        mockYtMusicCount.mockResolvedValue(0);
    });

    it("builds artist ownership predicates scoped to one user's provider likes", () => {
        expect(buildRemoteOwnedArtistFilters("user-1")).toEqual([
            {
                tracksTidal: {
                    some: {
                        likedBy: {
                            some: { userId: "user-1" },
                        },
                    },
                },
            },
            {
                tracksYtMusic: {
                    some: {
                        likedBy: {
                            some: { userId: "user-1" },
                        },
                    },
                },
            },
        ]);
    });

    it("adds remote ownership to the owned all-origin artist filter", () => {
        const where: any = {
            OR: [{ libraryAlbumCount: { gt: 0 } }],
        };

        addRemoteOwnedArtists(where, "user-1", "all", "owned");

        expect(where.OR).toEqual([
            { libraryAlbumCount: { gt: 0 } },
            ...buildRemoteOwnedArtistFilters("user-1"),
        ]);
    });

    it("loads only user-owned provider tracks with canonical playback IDs", async () => {
        mockTidalFindMany.mockResolvedValueOnce([
            {
                id: "tidal-row-1",
                tidalId: 9001,
                title: "Zulu",
                artist: "TIDAL Artist",
                album: "TIDAL Album",
                duration: 200,
                artistId: "artist-tidal",
                albumId: "album-tidal",
            },
        ]);
        mockYtMusicFindMany.mockResolvedValueOnce([
            {
                id: "yt-row-1",
                videoId: "yt-video-1",
                title: "Alpha",
                artist: "YouTube Artist",
                album: "YouTube Album",
                duration: 180,
                thumbnailUrl: "https://example.test/thumb.jpg",
                artistId: "artist-youtube",
                albumId: "album-youtube",
            },
        ]);

        const tracks = await loadRemoteOwnedTracksForUser("user-1", {
            take: 10,
            sort: "asc",
        });

        expect(mockTidalFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    likedBy: {
                        some: { userId: "user-1" },
                    },
                },
                orderBy: { title: "asc" },
                take: 10,
            }),
        );
        expect(mockYtMusicFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    likedBy: {
                        some: { userId: "user-1" },
                    },
                },
                orderBy: { title: "asc" },
                take: 10,
            }),
        );

        expect(tracks.map((track) => track.id)).toEqual([
            "yt:yt-video-1",
            "tidal:9001",
        ]);
        expect(tracks.map((track) => track.source)).toEqual([
            "youtube",
            "tidal",
        ]);

        const tidalLibraryTrack = toLibraryRemoteTrack(tracks[1]);
        expect(tidalLibraryTrack).toEqual(
            expect.objectContaining({
                id: "tidal:9001",
                source: "tidal",
                streamSource: "tidal",
                tidalTrackId: 9001,
                albumId: "album-tidal",
                album: expect.objectContaining({
                    id: "album-tidal",
                    artist: {
                        id: "artist-tidal",
                        name: "TIDAL Artist",
                    },
                }),
            }),
        );
    });

    it("matches user-owned provider search by title, artist, or album", async () => {
        await loadRemoteOwnedTracksForUser("user-search", {
            query: "paranoid",
            take: 20,
            match: "any",
        });

        expect(mockTidalFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    likedBy: {
                        some: { userId: "user-search" },
                    },
                    OR: [
                        {
                            title: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                        {
                            artist: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                        {
                            album: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                    ],
                },
            }),
        );
        expect(mockYtMusicFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    likedBy: {
                        some: { userId: "user-search" },
                    },
                    OR: [
                        {
                            title: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                        {
                            artist: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                        {
                            album: {
                                contains: "paranoid",
                                mode: "insensitive",
                            },
                        },
                    ],
                },
            }),
        );
    });

    it("counts only the authenticated user's provider likes", async () => {
        mockTidalCount.mockResolvedValueOnce(4);
        mockYtMusicCount.mockResolvedValueOnce(3);

        await expect(countRemoteOwnedTracksForUser("user-count")).resolves.toBe(
            7,
        );

        expect(mockTidalCount).toHaveBeenCalledWith({
            where: {
                likedBy: {
                    some: { userId: "user-count" },
                },
            },
        });
        expect(mockYtMusicCount).toHaveBeenCalledWith({
            where: {
                likedBy: {
                    some: { userId: "user-count" },
                },
            },
        });
    });
});
