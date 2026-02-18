describe("imageBackfill service", () => {
    function loadModule() {
        jest.resetModules();

        const artistCount = jest.fn();
        const artistFindMany = jest.fn();
        const artistUpdate = jest.fn();
        const albumCount = jest.fn();
        const albumFindMany = jest.fn();
        const albumUpdate = jest.fn();

        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        };

        const downloadAndStoreImage = jest.fn();
        const isNativePath = jest.fn();
        const redisSetEx = jest.fn();

        jest.doMock("../../utils/db", () => ({
            prisma: {
                artist: {
                    count: artistCount,
                    findMany: artistFindMany,
                    update: artistUpdate,
                },
                album: {
                    count: albumCount,
                    findMany: albumFindMany,
                    update: albumUpdate,
                },
            },
        }));

        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        jest.doMock("../imageStorage", () => ({
            downloadAndStoreImage,
            isNativePath,
        }));

        jest.doMock("../../utils/redis", () => ({
            redisClient: {
                setEx: redisSetEx,
            },
        }));

        const mod = require("../imageBackfill") as typeof import("../imageBackfill");

        return {
            mod,
            artistCount,
            artistFindMany,
            artistUpdate,
            albumCount,
            albumFindMany,
            albumUpdate,
            logger,
            downloadAndStoreImage,
            isNativePath,
            redisSetEx,
        };
    }

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it("returns a copy of backfill progress", () => {
        const { mod } = loadModule();

        const progress = mod.getImageBackfillProgress();
        progress.total = 999;

        expect(mod.getImageBackfillProgress()).toEqual({
            total: 0,
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            inProgress: false,
        });
    });

    it("computes whether backfill is needed from artist/album external URL counts", async () => {
        const { mod, artistCount, albumCount } = loadModule();

        artistCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
        albumCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

        await expect(mod.isImageBackfillNeeded()).resolves.toEqual({
            needed: true,
            artistsWithExternalUrls: 3,
            albumsWithExternalUrls: 0,
        });

        await expect(mod.isImageBackfillNeeded()).resolves.toEqual({
            needed: false,
            artistsWithExternalUrls: 0,
            albumsWithExternalUrls: 0,
        });
    });

    it("blocks concurrent runs while artist backfill is in progress", async () => {
        const {
            mod,
            artistFindMany,
            artistUpdate,
            albumFindMany,
            logger,
            isNativePath,
            downloadAndStoreImage,
            redisSetEx,
        } = loadModule();

        artistFindMany.mockResolvedValue([
            { id: "artist-1", name: "Artist One", heroUrl: "http://example/one.jpg" },
        ]);
        artistUpdate.mockResolvedValue({});
        redisSetEx.mockResolvedValue("OK");
        isNativePath.mockReturnValue(false);

        let releaseDownload: (value: string | null) => void = () => undefined;
        const pendingDownload = new Promise<string | null>((resolve) => {
            releaseDownload = resolve;
        });
        downloadAndStoreImage.mockReturnValue(pendingDownload);

        const firstRun = mod.backfillArtistImages();
        await Promise.resolve();
        await Promise.resolve();

        await mod.backfillArtistImages();
        await mod.backfillAlbumCovers();

        expect(logger.warn).toHaveBeenCalledWith(
            "[ImageBackfill] Backfill already in progress"
        );
        expect(albumFindMany).not.toHaveBeenCalled();

        releaseDownload("/images/artist-1.jpg");
        await firstRun;
    });

    it("processes artist backfill success, skipped, failed, and error cases", async () => {
        const {
            mod,
            artistFindMany,
            artistUpdate,
            logger,
            isNativePath,
            downloadAndStoreImage,
            redisSetEx,
        } = loadModule();

        artistFindMany.mockResolvedValue([
            { id: "a-skip", name: "Skip Artist", heroUrl: "http://native/skip.jpg" },
            { id: "a-ok", name: "Good Artist", heroUrl: "http://good/ok.jpg" },
            { id: "a-null", name: "Null Artist", heroUrl: "http://null/fail.jpg" },
            { id: "a-err", name: "Err Artist", heroUrl: "http://err/error.jpg" },
        ]);

        isNativePath.mockImplementation((url: string) => url.includes("/native/"));
        downloadAndStoreImage.mockImplementation(async (url: string) => {
            if (url.includes("/good/")) return "/images/a-ok.jpg";
            if (url.includes("/null/")) return null;
            throw new Error("download failed");
        });
        artistUpdate.mockResolvedValue({});
        redisSetEx.mockRejectedValueOnce(new Error("redis unavailable"));

        await mod.backfillArtistImages();

        expect(artistUpdate).toHaveBeenCalledTimes(1);
        expect(artistUpdate).toHaveBeenCalledWith({
            where: { id: "a-ok" },
            data: { heroUrl: "/images/a-ok.jpg" },
        });
        expect(redisSetEx).toHaveBeenCalledWith(
            "hero:a-ok",
            604800,
            "/images/a-ok.jpg"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ImageBackfill] Downloaded image for Good Artist"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ImageBackfill] Failed to download image for Null Artist"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ImageBackfill] Error processing Err Artist: download failed"
        );
        expect(mod.getImageBackfillProgress()).toEqual({
            total: 4,
            processed: 4,
            success: 1,
            failed: 2,
            skipped: 1,
            inProgress: false,
        });
    });

    it("applies batch delay for artist backfill when more than one batch exists", async () => {
        jest.useFakeTimers();
        const { mod, artistFindMany, isNativePath } = loadModule();

        artistFindMany.mockResolvedValue(
            Array.from({ length: 11 }, (_, i) => ({
                id: `artist-${i}`,
                name: `Artist ${i}`,
                heroUrl: `http://native/${i}.jpg`,
            }))
        );
        isNativePath.mockReturnValue(true);

        const run = mod.backfillArtistImages();
        await jest.advanceTimersByTimeAsync(1000);
        await run;

        expect(mod.getImageBackfillProgress()).toEqual({
            total: 11,
            processed: 11,
            success: 0,
            failed: 0,
            skipped: 11,
            inProgress: false,
        });
    });

    it("applies batch delay for album backfill when more than one batch exists", async () => {
        jest.useFakeTimers();
        const { mod, albumFindMany, isNativePath } = loadModule();

        albumFindMany.mockResolvedValue(
            Array.from({ length: 11 }, (_, i) => ({
                id: `album-${i}`,
                title: `Album ${i}`,
                coverUrl: `http://native/${i}.jpg`,
            }))
        );
        isNativePath.mockReturnValue(true);

        const run = mod.backfillAlbumCovers();
        await jest.advanceTimersByTimeAsync(1000);
        await run;

        expect(mod.getImageBackfillProgress()).toEqual({
            total: 11,
            processed: 11,
            success: 0,
            failed: 0,
            skipped: 11,
            inProgress: false,
        });
    });

    it("processes album backfill success, skipped, failed, and error cases", async () => {
        const {
            mod,
            albumFindMany,
            albumUpdate,
            logger,
            isNativePath,
            downloadAndStoreImage,
            redisSetEx,
        } = loadModule();

        albumFindMany.mockResolvedValue([
            { id: "b-skip", title: "Skip Album", coverUrl: "http://native/skip.jpg" },
            { id: "b-ok", title: "Good Album", coverUrl: "http://good/ok.jpg" },
            { id: "b-null", title: "Null Album", coverUrl: "http://null/fail.jpg" },
            { id: "b-err", title: "Err Album", coverUrl: "http://err/error.jpg" },
        ]);

        isNativePath.mockImplementation((url: string) => url.includes("/native/"));
        downloadAndStoreImage.mockImplementation(async (url: string) => {
            if (url.includes("/good/")) return "/images/b-ok.jpg";
            if (url.includes("/null/")) return null;
            throw new Error("album download failed");
        });
        albumUpdate.mockResolvedValue({});
        redisSetEx.mockRejectedValueOnce(new Error("redis unavailable"));

        await mod.backfillAlbumCovers();

        expect(albumUpdate).toHaveBeenCalledTimes(1);
        expect(albumUpdate).toHaveBeenCalledWith({
            where: { id: "b-ok" },
            data: { coverUrl: "/images/b-ok.jpg" },
        });
        expect(redisSetEx).toHaveBeenCalledWith(
            "album-cover:b-ok",
            2592000,
            "/images/b-ok.jpg"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ImageBackfill] Downloaded cover for Good Album"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ImageBackfill] Error processing Err Album: album download failed"
        );
        expect(mod.getImageBackfillProgress()).toEqual({
            total: 4,
            processed: 4,
            success: 1,
            failed: 2,
            skipped: 1,
            inProgress: false,
        });
    });

    it("runs artist and album backfills in order when backfillAllImages is called", async () => {
        const {
            mod,
            artistFindMany,
            albumFindMany,
            artistUpdate,
            albumUpdate,
            isNativePath,
            downloadAndStoreImage,
            redisSetEx,
        } = loadModule();

        artistFindMany.mockResolvedValue([
            { id: "a1", name: "Artist One", heroUrl: "http://good/a1.jpg" },
        ]);
        albumFindMany.mockResolvedValue([
            { id: "b1", title: "Album One", coverUrl: "http://good/b1.jpg" },
        ]);
        artistUpdate.mockResolvedValue({});
        albumUpdate.mockResolvedValue({});
        isNativePath.mockReturnValue(false);
        redisSetEx.mockResolvedValue("OK");
        downloadAndStoreImage.mockImplementation(
            async (_url: string, id: string, type: string) => `/${type}/${id}.jpg`
        );

        await mod.backfillAllImages();

        expect(downloadAndStoreImage).toHaveBeenNthCalledWith(
            1,
            "http://good/a1.jpg",
            "a1",
            "artist"
        );
        expect(downloadAndStoreImage).toHaveBeenNthCalledWith(
            2,
            "http://good/b1.jpg",
            "b1",
            "album"
        );
        expect(artistUpdate).toHaveBeenCalledTimes(1);
        expect(albumUpdate).toHaveBeenCalledTimes(1);
    });
});
