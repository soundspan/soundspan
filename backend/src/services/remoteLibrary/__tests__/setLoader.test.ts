jest.mock("../../../utils/db", () => ({
    prisma: {
        likedRemoteTrack: { findMany: jest.fn() },
    },
}));

jest.mock("../providers", () => ({
    loadRemoteLibraryAccess: jest.fn(),
}));

jest.mock("../../../metrics", () => ({
    recordRemoteLibraryRowsCapped: jest.fn(),
}));

const mockRemoteLibraryWarn = jest.fn();
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({ warn: mockRemoteLibraryWarn })),
    },
}));

import { prisma } from "../../../utils/db";
import { recordRemoteLibraryRowsCapped } from "../../../metrics";
import { loadRemoteLibraryAccess } from "../providers";
import { loadRemoteLibrarySet, REMOTE_LIBRARY_ROW_CAP } from "../setLoader";

const mockFindMany = prisma.likedRemoteTrack.findMany as jest.Mock;
const mockAccess = loadRemoteLibraryAccess as jest.Mock;
const mockRecordCapped = recordRemoteLibraryRowsCapped as jest.Mock;

function tidalEntry(index: number) {
    return {
        likedAt: new Date(REMOTE_LIBRARY_ROW_CAP - index),
        trackTidal: {
            id: `tidal-${index}`,
            title: `Track ${index}`,
            artistId: "artist-1",
            albumId: "album-1",
            albumEntity: null,
            mappings: [] as Array<{ id: string; trackId: string | null }>,
        },
    };
}

describe("remote library set loader", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAccess.mockResolvedValue({
            providers: { tidal: false, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        mockFindMany.mockResolvedValue([]);
    });

    it("issues no remote queries without a user or connected provider", async () => {
        await expect(loadRemoteLibrarySet(undefined)).resolves.toMatchObject({
            tracks: [],
        });
        await expect(loadRemoteLibrarySet("user-1")).resolves.toMatchObject({
            tracks: [],
        });
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it("scopes likes to the user and excludes only active visible mappings", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        mockFindMany.mockResolvedValueOnce([tidalEntry(0)]);

        const result = await loadRemoteLibrarySet("user-1");

        expect(result.tracks).toHaveLength(1);
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "user-1",
                    trackTidal: {
                        is: expect.objectContaining({
                            mappings: {
                                none: expect.objectContaining({
                                    stale: false,
                                    trackId: { not: null },
                                    track: {
                                        is: {
                                            OR: [
                                                { AND: expect.any(Array) },
                                                {
                                                    dedupOfTrack: {
                                                        is: {
                                                            AND: expect.any(
                                                                Array,
                                                            ),
                                                        },
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                }),
                            },
                        }),
                    },
                }),
                select: {
                    likedAt: true,
                    trackTidal: {
                        select: expect.objectContaining({
                            albumEntity: {
                                select: expect.objectContaining({
                                    artistId: true,
                                    location: true,
                                }),
                            },
                        }),
                    },
                },
                orderBy: [{ likedAt: "desc" }, { id: "asc" }],
                take: REMOTE_LIBRARY_ROW_CAP + 1,
            }),
        );
        const selectedTrack =
            mockFindMany.mock.calls[0][0].select.trackTidal.select;
        expect(selectedTrack).toEqual({
            id: true,
            title: true,
            artistId: true,
            albumId: true,
            albumEntity: {
                select: { artistId: true, location: true },
            },
            mappings: {
                where: { stale: false },
                select: { id: true, trackId: true },
            },
        });
    });

    it("adds provider and album artist scope to both provider queries", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: true },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });

        await loadRemoteLibrarySet("user-1", { artistId: "artist-1" });

        expect(mockFindMany).toHaveBeenCalledTimes(2);
        for (const relation of ["trackTidal", "trackYtMusic"] as const) {
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        [relation]: {
                            is: expect.objectContaining({
                                OR: [
                                    { artistId: "artist-1" },
                                    {
                                        albumEntity: {
                                            is: { artistId: "artist-1" },
                                        },
                                    },
                                ],
                            }),
                        },
                    }),
                }),
            );
        }
    });

    it("does not add an artist predicate to unscoped provider queries", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: true },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });

        await loadRemoteLibrarySet("user-1");

        expect(mockFindMany).toHaveBeenCalledTimes(2);
        for (const call of mockFindMany.mock.calls) {
            const relation =
                call[0].where.trackTidal ?? call[0].where.trackYtMusic;
            expect(relation.is.OR).toBeUndefined();
        }
    });

    it("includes album owners even when the provider track artist differs", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        const baseEntry = tidalEntry(0);
        const entry = {
            ...baseEntry,
            trackTidal: {
                ...baseEntry.trackTidal,
                artistId: "direct-artist",
                albumEntity: {
                    artistId: "album-artist",
                    location: "REMOTE",
                },
            },
        };
        mockFindMany.mockResolvedValueOnce([entry]);

        const result = await loadRemoteLibrarySet("user-1", {
            artistId: "album-artist",
        });

        expect(result.tracks).toHaveLength(1);
        expect(result.byArtistId.get("direct-artist")).toEqual(
            expect.objectContaining({ trackCount: 1, albumCount: 0 }),
        );
        expect(result.byArtistId.get("album-artist")).toEqual(
            expect.objectContaining({ trackCount: 0, albumCount: 1 }),
        );
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    trackTidal: {
                        is: expect.objectContaining({
                            OR: [
                                { artistId: "album-artist" },
                                {
                                    albumEntity: {
                                        is: { artistId: "album-artist" },
                                    },
                                },
                            ],
                        }),
                    },
                }),
            }),
        );
    });

    it("collapses cross-provider duplicates using playback source order", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: true },
            playbackSourceOrder: ["ytmusic", "tidal", "library", "peers"],
        });
        const tidal = tidalEntry(0);
        tidal.trackTidal.mappings = [
            { id: "tidal-map", trackId: "canonical-1" },
        ];
        const youtube = {
            likedAt: new Date(),
            trackYtMusic: {
                id: "youtube-1",
                videoId: "video-1",
                title: "Track 0",
                artist: "Artist",
                album: "Album",
                duration: 180,
                thumbnailUrl: null,
                artistId: "artist-1",
                albumId: "album-1",
                artistEntity: null,
                albumEntity: null,
                mappings: [{ id: "youtube-map", trackId: "canonical-1" }],
            },
        };
        mockFindMany
            .mockResolvedValueOnce([tidal])
            .mockResolvedValueOnce([youtube]);

        const result = await loadRemoteLibrarySet("user-1");

        expect(result.tracks.map((row) => row.provider)).toEqual(["youtube"]);
    });

    it("keeps exactly the cap without reporting truncation", async () => {
        mockAccess.mockResolvedValueOnce({
            providers: { tidal: true, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        mockFindMany.mockResolvedValueOnce(
            Array.from({ length: REMOTE_LIBRARY_ROW_CAP }, (_, index) =>
                tidalEntry(index),
            ),
        );

        const result = await loadRemoteLibrarySet("user-1");

        expect(result.tracks).toHaveLength(REMOTE_LIBRARY_ROW_CAP);
        expect(result.tracks[0]?.providerRowId).toBe("tidal-0");
        expect(result.tracks.at(-1)?.providerRowId).toBe(
            `tidal-${REMOTE_LIBRARY_ROW_CAP - 1}`,
        );
        expect(mockRecordCapped).not.toHaveBeenCalled();
        expect(mockRemoteLibraryWarn).not.toHaveBeenCalled();
    });

    it("keeps the newest capped rows and reports actual truncation once", async () => {
        mockAccess.mockResolvedValue({
            providers: { tidal: true, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        mockFindMany.mockResolvedValue(
            Array.from({ length: REMOTE_LIBRARY_ROW_CAP + 1 }, (_, index) =>
                tidalEntry(index),
            ),
        );

        const result = await loadRemoteLibrarySet("user-1");
        await loadRemoteLibrarySet("user-1");

        expect(result.tracks).toHaveLength(REMOTE_LIBRARY_ROW_CAP);
        expect(result.tracks[0]?.providerRowId).toBe("tidal-0");
        expect(result.tracks.at(-1)?.providerRowId).toBe(
            `tidal-${REMOTE_LIBRARY_ROW_CAP - 1}`,
        );
        expect(mockRecordCapped).toHaveBeenCalledTimes(2);
        expect(mockRecordCapped).toHaveBeenCalledWith("tidal");
        expect(mockRemoteLibraryWarn).toHaveBeenCalledTimes(1);
        expect(mockRemoteLibraryWarn).toHaveBeenCalledWith(
            "Remote library provider row cap reached",
            {
                userId: "user-1",
                provider: "tidal",
                cap: REMOTE_LIBRARY_ROW_CAP,
            },
        );
    });
});
