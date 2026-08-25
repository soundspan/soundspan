describe("artistCountsService", () => {
    function loadModule() {
        jest.resetModules();

        const prisma = {
            $executeRaw: jest.fn(),
            album: {
                count: jest.fn(),
                findUnique: jest.fn(),
            },
            track: {
                count: jest.fn(),
                findUnique: jest.fn(),
            },
            trackTidal: {
                count: jest.fn().mockResolvedValue(0),
            },
            trackYtMusic: {
                count: jest.fn().mockResolvedValue(0),
            },
            artist: {
                update: jest.fn(),
                count: jest.fn(),
                findMany: jest.fn(),
                updateMany: jest.fn(),
            },
        };

        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));

        const mod =
            require("../artistCountsService") as typeof import("../artistCountsService");

        return { mod, prisma, logger };
    }

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("calculates artist counts from album and track tables", async () => {
        const { mod, prisma } = loadModule();
        prisma.album.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
        prisma.track.count.mockResolvedValueOnce(11);

        await expect(mod.calculateArtistCounts("artist-1")).resolves.toEqual({
            libraryAlbumCount: 3,
            discoveryAlbumCount: 2,
            totalTrackCount: 11,
            remoteTrackCount: 0,
        });

        expect(prisma.album.count).toHaveBeenNthCalledWith(1, {
            where: {
                artistId: "artist-1",
                location: "LIBRARY",
                tracks: {
                    some: {
                        removedAt: null,
                        origin: "LOCAL",
                        album: {
                            location: {
                                in: [
                                    "LIBRARY",
                                    "DISCOVER",
                                    "REMOTE",
                                    "FEDERATED",
                                ],
                            },
                        },
                    },
                },
            },
        });
        expect(prisma.album.count).toHaveBeenNthCalledWith(2, {
            where: {
                artistId: "artist-1",
                location: "DISCOVER",
                tracks: {
                    some: {
                        removedAt: null,
                        origin: "LOCAL",
                        album: {
                            location: {
                                in: [
                                    "LIBRARY",
                                    "DISCOVER",
                                    "REMOTE",
                                    "FEDERATED",
                                ],
                            },
                        },
                    },
                },
            },
        });
        expect(prisma.track.count).toHaveBeenCalledWith({
            where: {
                removedAt: null,
                origin: "LOCAL",
                album: { artistId: "artist-1" },
            },
        });
    });

    it("updates a single artist and logs errors on failure", async () => {
        const { mod, prisma, logger } = loadModule();
        prisma.album.count.mockResolvedValue(1);
        prisma.track.count.mockResolvedValue(4);
        prisma.artist.update.mockResolvedValueOnce({});

        await expect(
            mod.updateArtistCounts("artist-2"),
        ).resolves.toBeUndefined();
        expect(prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-2" },
            data: expect.objectContaining({
                libraryAlbumCount: 1,
                discoveryAlbumCount: 1,
                totalTrackCount: 4,
            }),
        });

        prisma.artist.update.mockRejectedValueOnce(new Error("update failed"));

        await expect(mod.updateArtistCounts("artist-3")).rejects.toThrow(
            "update failed",
        );
        expect(logger.error).toHaveBeenCalledWith(
            "[ArtistCounts] Failed to update counts for artist-3:",
            expect.any(Error),
        );
    });

    it("updates multiple artists with one set-based statement", async () => {
        const { mod, prisma } = loadModule();
        prisma.$executeRaw.mockResolvedValue(2);

        await expect(
            mod.updateMultipleArtistCounts(["artist-a", "artist-b"]),
        ).resolves.toEqual({
            updated: 2,
            errors: 0,
        });
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.album.count).not.toHaveBeenCalled();
        expect(prisma.track.count).not.toHaveBeenCalled();
        expect(prisma.artist.update).not.toHaveBeenCalled();
    });

    it("updates a large scoped artist set without per-artist statements", async () => {
        const { mod, prisma } = loadModule();
        const artistIds = Array.from(
            { length: 205 },
            (_, index) => `artist-${index}`,
        );
        prisma.$executeRaw.mockResolvedValue(205);

        await expect(
            mod.updateArtistCountsInBatches(artistIds),
        ).resolves.toEqual({ updated: 205, failed: 0 });
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.artist.update).not.toHaveBeenCalled();
    });

    it("updates by album id and track id when related artist exists", async () => {
        const { mod, prisma } = loadModule();
        prisma.album.count.mockResolvedValue(0);
        prisma.track.count.mockResolvedValue(0);
        prisma.artist.update.mockResolvedValue({});

        prisma.album.findUnique
            .mockResolvedValueOnce({ artistId: "artist-album" })
            .mockResolvedValueOnce(null);
        prisma.track.findUnique
            .mockResolvedValueOnce({ album: { artistId: "artist-track" } })
            .mockResolvedValueOnce({ album: null });

        await mod.updateArtistCountsByAlbumId("album-1");
        await mod.updateArtistCountsByAlbumId("album-2");
        await mod.updateArtistCountsByTrackId("track-1");
        await mod.updateArtistCountsByTrackId("track-2");

        expect(prisma.artist.update).toHaveBeenCalledTimes(2);
        expect(prisma.artist.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "artist-album" } }),
        );
        expect(prisma.artist.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "artist-track" } }),
        );
    });

    it("returns running status and blocks concurrent backfills", async () => {
        const { mod, prisma, logger } = loadModule();

        let resolveTotal: (value: number) => void = () => undefined;
        const pendingTotal = new Promise<number>((resolve) => {
            resolveTotal = resolve;
        });

        prisma.artist.count.mockReturnValueOnce(pendingTotal as any);
        prisma.artist.findMany.mockResolvedValue([]);

        const firstRun = mod.backfillAllArtistCounts();
        await Promise.resolve();

        expect(mod.isBackfillInProgress()).toBe(true);
        await expect(mod.getBackfillProgress()).resolves.toEqual({
            processed: 0,
            total: 0,
            percent: 0,
            isRunning: true,
            errors: 0,
        });

        await expect(mod.backfillAllArtistCounts()).resolves.toEqual({
            processed: 0,
            errors: 0,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "[ArtistCounts] Backfill already in progress, skipping",
        );

        resolveTotal(0);
        await firstRun;
        expect(mod.isBackfillInProgress()).toBe(false);
    });

    it("backfills every artist with one set-based statement", async () => {
        const { mod, prisma, logger } = loadModule();
        const onProgress = jest.fn();

        prisma.artist.count.mockResolvedValueOnce(2);
        prisma.$executeRaw.mockResolvedValueOnce(2);

        await expect(mod.backfillAllArtistCounts(onProgress)).resolves.toEqual({
            processed: 2,
            errors: 0,
        });
        expect(onProgress).toHaveBeenCalledWith(2, 2);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.artist.findMany).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            "[ArtistCounts] Starting backfill for 2 artists",
        );
        expect(logger.info).toHaveBeenCalledWith(
            "[ArtistCounts] Backfill complete: 2 processed, 0 errors",
        );
    });

    it("reports progress when not running and checks whether backfill is needed", async () => {
        const { mod, prisma } = loadModule();

        prisma.artist.count
            .mockResolvedValueOnce(7)
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(0);

        await expect(mod.getBackfillProgress()).resolves.toEqual({
            processed: 7,
            total: 10,
            percent: 70,
            isRunning: false,
            errors: 0,
        });

        await expect(mod.isBackfillNeeded()).resolves.toBe(true);
        await expect(mod.isBackfillNeeded()).resolves.toBe(false);
    });

    it("forces recalculation by resetting timestamps and running backfill", async () => {
        const { mod, prisma, logger } = loadModule();

        prisma.artist.updateMany.mockResolvedValue({});
        prisma.artist.count.mockResolvedValueOnce(0);

        await mod.forceRecalculateAllCounts();

        expect(logger.info).toHaveBeenCalledWith(
            "[ArtistCounts] Force recalculating all counts...",
        );
        expect(prisma.artist.updateMany).toHaveBeenCalledWith({
            data: { countsLastUpdated: null },
        });
    });
});
