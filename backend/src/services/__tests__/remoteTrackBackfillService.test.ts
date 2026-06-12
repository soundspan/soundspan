const mockPrisma = {
    trackTidal: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    trackYtMusic: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

const mockResolveArtist = jest.fn();
jest.mock("../artistResolutionService", () => ({
    resolveArtistForRemoteTrack: (...args: unknown[]) => mockResolveArtist(...args),
}));

const mockResolveAlbum = jest.fn();
jest.mock("../albumResolutionService", () => ({
    resolveAlbumForRemoteTrack: (...args: unknown[]) => mockResolveAlbum(...args),
}));

const mockBackfillCounts = jest.fn().mockResolvedValue({ processed: 0, errors: 0 });
jest.mock("../artistCountsService", () => ({
    backfillAllArtistCounts: (...args: unknown[]) => mockBackfillCounts(...args),
}));

import {
    backfillRemoteArtistAlbumLinks,
    isRemoteBackfillInProgress,
} from "../remoteTrackBackfillService";

describe("remoteTrackBackfillService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
                    { id: "tt-1", artist: "Artist A", album: "Album A", artistId: null },
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
                    { id: "yt-1", artist: "Artist B", album: "Album B", artistId: null },
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
                    { id: "tt-2", artist: "Artist C", album: "Single", artistId: null },
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

        it("retries album resolution when artistId set but albumId null", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    { id: "tt-3", artist: "Artist D", album: "Album D", artistId: "existing-artist" },
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
            expect(mockResolveAlbum).toHaveBeenCalledWith("Album D", "existing-artist", "tidal");
            expect(result.tidalProcessed).toBe(1);
        });

        it("counts errors but continues processing", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    { id: "tt-fail", artist: "Bad Artist", album: "Bad Album", artistId: null },
                    { id: "tt-ok", artist: "Good Artist", album: "Good Album", artistId: null },
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

        it("breaks out of loop when entire batch fails", async () => {
            mockPrisma.trackTidal.findMany
                .mockResolvedValueOnce([
                    { id: "tt-fail-1", artist: "Bad", album: "Bad", artistId: null },
                    { id: "tt-fail-2", artist: "Bad2", album: "Bad2", artistId: null },
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
                    { id: "tt-1", artist: "Artist", album: "Album", artistId: null },
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
