const mockPrisma = {
    album: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        createMany: jest.fn(),
        update: jest.fn(),
    },
    trackTidal: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    trackYtMusic: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
};

const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue(mockLog),
    },
}));

const mockResolveArtist = jest.fn();
jest.mock("../artistResolutionService", () => ({
    resolveArtistForRemoteTrack: (...args: unknown[]) =>
        mockResolveArtist(...args),
}));

const mockResolveAlbum = jest.fn();
jest.mock("../albumResolutionService", () => ({
    resolveAlbumForRemoteTrack: (...args: unknown[]) =>
        mockResolveAlbum(...args),
}));

const mockResolveExternalAlbum = jest.fn();
jest.mock("../trackAlbumResolution", () => ({
    resolveAlbumForExternalTrack: (...args: unknown[]) =>
        mockResolveExternalAlbum(...args),
}));

const mockBackfillCounts = jest
    .fn()
    .mockResolvedValue({ processed: 0, errors: 0 });
jest.mock("../artistCountsService", () => ({
    backfillAllArtistCounts: (...args: unknown[]) =>
        mockBackfillCounts(...args),
}));

import {
    backfillRemoteArtistAlbumLinks,
    isRemoteBackfillInProgress,
} from "../remoteTrackBackfillService";

const { resolveAlbumForRemoteTrack: resolveActualAlbum } = jest.requireActual<
    typeof import("../albumResolutionService")
>("../albumResolutionService");

describe("remoteTrackBackfillService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveExternalAlbum.mockResolvedValue({
            status: "resolved",
            resolution: {
                albumTitle: "OK Computer",
                rgMbid: "rg-ok-computer",
                artistName: "Radiohead",
                source: "musicbrainz-recording",
            },
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("isRemoteBackfillInProgress", () => {
        it("returns false when not running", () => {
            expect(isRemoteBackfillInProgress()).toBe(false);
        });
    });

    describe("backfillRemoteArtistAlbumLinks", () => {
        it("processes TrackTidal rows with null artistId", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    {
                        id: "tt-1",
                        artist: "Artist A",
                        album: "Album A",
                        artistId: null,
                    },
                ])
                .mockResolvedValueOnce([]);

            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveArtist.mockResolvedValue({
                id: "resolved-artist-1",
                name: "Artist A",
                created: true,
            });
            mockResolveAlbum.mockResolvedValue({
                id: "resolved-album-1",
                title: "Album A",
                created: true,
            });
            mockPrisma.trackTidal.update.mockResolvedValue({});

            const result = await backfillRemoteArtistAlbumLinks();

            expect(result.tidalProcessed).toBe(1);
            expect(result.errors).toBe(0);
            expect(mockPrisma.trackTidal.update).toHaveBeenCalledWith({
                where: { id: "tt-1" },
                data: {
                    artistId: "resolved-artist-1",
                    albumId: "resolved-album-1",
                },
            });
        });

        it("processes TrackYtMusic rows with null artistId", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValue([]);
            mockPrisma.trackYtMusic.findMany
                .mockResolvedValueOnce([
                    {
                        id: "yt-1",
                        artist: "Artist B",
                        album: "Album B",
                        artistId: null,
                    },
                ])
                .mockResolvedValueOnce([]);

            mockResolveArtist.mockResolvedValue({
                id: "resolved-artist-2",
                name: "Artist B",
                created: false,
            });
            mockResolveAlbum.mockResolvedValue({
                id: "resolved-album-2",
                title: "Album B",
                created: false,
            });
            mockPrisma.trackYtMusic.update.mockResolvedValue({});

            const result = await backfillRemoteArtistAlbumLinks();

            expect(result.ytMusicProcessed).toBe(1);
            expect(mockPrisma.trackYtMusic.update).toHaveBeenCalledWith({
                where: { id: "yt-1" },
                data: {
                    artistId: "resolved-artist-2",
                    albumId: "resolved-album-2",
                },
            });
        });

        it("sets albumId to null when album resolution returns null", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    {
                        id: "tt-2",
                        artist: "Artist C",
                        album: "Single",
                        artistId: null,
                    },
                ])
                .mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveArtist.mockResolvedValue({
                id: "resolved-artist-3",
                name: "Artist C",
                created: false,
            });
            mockResolveAlbum.mockResolvedValue(null);
            mockPrisma.trackTidal.update.mockResolvedValue({});

            const result = await backfillRemoteArtistAlbumLinks();

            expect(mockPrisma.trackTidal.update).toHaveBeenCalledWith({
                where: { id: "tt-2" },
                data: {
                    artistId: "resolved-artist-3",
                    albumId: null,
                },
            });
            expect(result.tidalProcessed).toBe(1);
        });

        it("advances the TrackTidal cursor when album resolution remains null", async () => {
            const row = {
                id: "tt-sticky",
                artist: "Artist C",
                album: "Generic Album",
                artistId: null,
            };
            mockPrisma.trackTidal.findMany.mockImplementation(async (args) => {
                const lastId = args.where?.AND?.[1]?.id?.gt;
                if (lastId === undefined) {
                    throw new Error(
                        "TrackTidal query did not include a cursor",
                    );
                }
                return lastId < row.id ? [row] : [];
            });
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
            mockResolveArtist.mockResolvedValue({ id: "resolved-artist-3" });
            mockResolveAlbum.mockResolvedValue(null);
            mockPrisma.trackTidal.update.mockResolvedValue({});

            await expect(backfillRemoteArtistAlbumLinks()).resolves.toEqual({
                tidalProcessed: 1,
                ytMusicProcessed: 0,
                errors: 0,
            });

            expect(mockPrisma.trackTidal.update).toHaveBeenCalledTimes(1);
            expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledTimes(2);
            expect(mockPrisma.trackTidal.findMany).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    where: {
                        AND: [
                            { OR: [{ artistId: null }, { albumId: null }] },
                            { id: { gt: "tt-sticky" } },
                        ],
                    },
                }),
            );
        });

        it("stops TrackTidal pagination at the fixed iteration bound", async () => {
            let batchNumber = 0;
            mockPrisma.trackTidal.findMany.mockImplementation(async () => {
                batchNumber++;
                const row = {
                    id: `tt-bound-${batchNumber.toString().padStart(6, "0")}`,
                    artist: "Artist",
                    album: "",
                    artistId: "artist-id",
                };
                return {
                    length: 50,
                    49: row,
                    *[Symbol.iterator]() {
                        yield row;
                    },
                };
            });
            mockPrisma.trackTidal.update.mockResolvedValue({});
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
            jest.spyOn(global, "setTimeout").mockImplementation((callback) => {
                callback();
                return {} as NodeJS.Timeout;
            });

            await expect(backfillRemoteArtistAlbumLinks()).resolves.toEqual({
                tidalProcessed: 100_000,
                ytMusicProcessed: 0,
                errors: 0,
            });

            expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledTimes(
                100_000,
            );
            expect(mockLog.warn).toHaveBeenCalledWith(
                "TrackTidal backfill exceeded 100000 iterations, stopping",
            );
        });

        it("retries album resolution when artistId set but albumId null", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    {
                        id: "tt-3",
                        title: "Track D",
                        artist: "Artist D",
                        album: "Album D",
                        artistId: "existing-artist",
                    },
                ])
                .mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveAlbum.mockResolvedValue({
                id: "resolved-album-d",
                title: "Album D",
                created: true,
            });
            mockPrisma.trackTidal.update.mockResolvedValue({});

            const result = await backfillRemoteArtistAlbumLinks();

            // Should NOT call resolveArtist since artistId is already set
            expect(mockResolveArtist).not.toHaveBeenCalled();
            // Should call resolveAlbum with the existing artistId
            expect(mockResolveAlbum).toHaveBeenCalledWith(
                "Album D",
                "existing-artist",
                "tidal",
                { artistName: "Artist D", trackTitle: "Track D" },
            );
            expect(result.tidalProcessed).toBe(1);
        });

        it("counts errors but continues processing", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    {
                        id: "tt-fail",
                        artist: "Bad Artist",
                        album: "Bad Album",
                        artistId: null,
                    },
                    {
                        id: "tt-ok",
                        artist: "Good Artist",
                        album: "Good Album",
                        artistId: null,
                    },
                ])
                .mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveArtist
                .mockRejectedValueOnce(new Error("DB error"))
                .mockResolvedValueOnce({
                    id: "good-artist",
                    name: "Good Artist",
                    created: false,
                });
            mockResolveAlbum.mockResolvedValue({
                id: "good-album",
                title: "Good Album",
                created: false,
            });
            mockPrisma.trackTidal.update.mockResolvedValue({});

            const result = await backfillRemoteArtistAlbumLinks();

            expect(result.tidalProcessed).toBe(1);
            expect(result.errors).toBe(1);
        });

        it("counts album persistence failures without clearing albumId", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                {
                    id: "tt-prisma-fail",
                    title: "Paranoid Android",
                    artist: "Radiohead",
                    album: "Unknown Album",
                    artistId: "artist-1",
                },
            ]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
            mockPrisma.album.findFirst.mockRejectedValueOnce(
                new Error("prisma album lookup failed"),
            );
            mockResolveAlbum.mockImplementationOnce(resolveActualAlbum);

            const result = await backfillRemoteArtistAlbumLinks();

            expect(result).toEqual({
                tidalProcessed: 0,
                ytMusicProcessed: 0,
                errors: 1,
            });
            expect(mockPrisma.trackTidal.update).not.toHaveBeenCalled();
        });

        it("breaks out of loop when entire batch fails", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
                {
                    id: "tt-fail-1",
                    artist: "Bad",
                    album: "Bad",
                    artistId: null,
                },
                {
                    id: "tt-fail-2",
                    artist: "Bad2",
                    album: "Bad2",
                    artistId: null,
                },
            ]);
            // Should not be called again because we break after full-batch failure
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveArtist.mockRejectedValue(new Error("All fail"));

            const result = await backfillRemoteArtistAlbumLinks();

            expect(result.tidalProcessed).toBe(0);
            expect(result.errors).toBe(2);
            // Tidal findMany should only be called once (no second batch query)
            expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledTimes(1);
        });

        it("refreshes artist counts after processing", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    {
                        id: "tt-1",
                        artist: "Artist",
                        album: "Album",
                        artistId: null,
                    },
                ])
                .mockResolvedValueOnce([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            mockResolveArtist.mockResolvedValue({
                id: "a-id",
                name: "Artist",
                created: false,
            });
            mockResolveAlbum.mockResolvedValue({
                id: "alb-id",
                title: "Album",
                created: false,
            });
            mockPrisma.trackTidal.update.mockResolvedValue({});

            await backfillRemoteArtistAlbumLinks();

            expect(mockBackfillCounts).toHaveBeenCalled();
        });

        it("skips count refresh when nothing was processed", async () => {
            mockPrisma.trackTidal.findMany.mockResolvedValue([]);
            mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);

            await backfillRemoteArtistAlbumLinks();

            expect(mockBackfillCounts).not.toHaveBeenCalled();
        });
    });
});
