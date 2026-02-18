jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
        },
        album: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
        mGet: jest.fn(),
        multi: jest.fn(),
    },
}));

jest.mock("../fanart", () => ({
    fanartService: {
        getArtistImage: jest.fn(),
    },
}));

jest.mock("../deezer", () => ({
    deezerService: {
        getArtistImage: jest.fn(),
    },
}));

jest.mock("../lastfm", () => ({
    lastFmService: {
        getArtistInfo: jest.fn(),
    },
}));

jest.mock("../coverArt", () => ({
    coverArtService: {
        getCoverArt: jest.fn(),
    },
}));

jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

import { dataCacheService } from "../dataCache";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { fanartService } from "../fanart";
import { deezerService } from "../deezer";
import { lastFmService } from "../lastfm";
import { coverArtService } from "../coverArt";
import { downloadAndStoreImage } from "../imageStorage";
import { logger } from "../../utils/logger";

const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistUpdate = prisma.artist.update as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockAlbumFindMany = prisma.album.findMany as jest.Mock;

const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockRedisMGet = redisClient.mGet as jest.Mock;
const mockRedisMulti = redisClient.multi as jest.Mock;

const mockFanartGetArtistImage = fanartService.getArtistImage as jest.Mock;
const mockDeezerGetArtistImage = deezerService.getArtistImage as jest.Mock;
const mockLastfmGetArtistInfo = lastFmService.getArtistInfo as jest.Mock;
const mockCoverArtGet = coverArtService.getCoverArt as jest.Mock;
const mockDownloadAndStoreImage = downloadAndStoreImage as jest.Mock;

const mockWarn = logger.warn as jest.Mock;
const mockError = logger.error as jest.Mock;

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const NEGATIVE_CACHE_SECONDS = 30 * 24 * 60 * 60;

function createRedisMulti() {
    return {
        setEx: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
    };
}

describe("dataCacheService", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistUpdate.mockResolvedValue({});
        mockArtistFindMany.mockResolvedValue([]);
        mockAlbumFindUnique.mockResolvedValue(null);
        mockAlbumUpdate.mockResolvedValue({});
        mockAlbumFindMany.mockResolvedValue([]);

        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockRedisMGet.mockResolvedValue([]);
        mockRedisMulti.mockImplementation(() => createRedisMulti());

        mockFanartGetArtistImage.mockResolvedValue(null);
        mockDeezerGetArtistImage.mockResolvedValue(null);
        mockLastfmGetArtistInfo.mockResolvedValue(null);
        mockCoverArtGet.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
    });

    it("returns userHeroUrl from DB and refreshes Redis cache", async () => {
        mockArtistFindUnique.mockResolvedValue({
            heroUrl: "native:artists/default.jpg",
            userHeroUrl: "native:artists/custom.jpg",
        });

        const result = await dataCacheService.getArtistImage(
            "artist-1",
            "Artist Name",
            "mbid-1"
        );

        expect(result).toBe("native:artists/custom.jpg");
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-1",
            ONE_YEAR_SECONDS,
            "native:artists/custom.jpg"
        );
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockFanartGetArtistImage).not.toHaveBeenCalled();
    });

    it("uses Redis artist cache and syncs back to DB when DB misses", async () => {
        mockRedisGet.mockResolvedValue("native:artists/from-redis.jpg");

        const result = await dataCacheService.getArtistImage(
            "artist-2",
            "Artist Two"
        );

        expect(result).toBe("native:artists/from-redis.jpg");
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-2" },
            data: { heroUrl: "native:artists/from-redis.jpg" },
        });
        expect(mockFanartGetArtistImage).not.toHaveBeenCalled();
    });

    it("returns null on negative Redis artist cache hit", async () => {
        mockRedisGet.mockResolvedValue("NOT_FOUND");

        const result = await dataCacheService.getArtistImage(
            "artist-3",
            "Artist Three"
        );

        expect(result).toBeNull();
        expect(mockFanartGetArtistImage).not.toHaveBeenCalled();
        expect(mockDeezerGetArtistImage).not.toHaveBeenCalled();
        expect(mockLastfmGetArtistInfo).not.toHaveBeenCalled();
    });

    it("fetches artist image from Fanart, stores local path, and persists", async () => {
        mockFanartGetArtistImage.mockResolvedValue("https://fanart/image.jpg");
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/a1.jpg");

        const result = await dataCacheService.getArtistImage(
            "artist-4",
            "Artist Four",
            "mbid-4"
        );

        expect(result).toBe("native:artists/a1.jpg");
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-4" },
            data: { heroUrl: "native:artists/a1.jpg" },
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-4",
            ONE_YEAR_SECONDS,
            "native:artists/a1.jpg"
        );
    });

    it("skips Fanart for temp MBID, uses Deezer, and falls back to external URL when local download fails", async () => {
        mockDeezerGetArtistImage.mockResolvedValue("https://deezer/image.jpg");
        mockDownloadAndStoreImage.mockResolvedValue(null);

        const result = await dataCacheService.getArtistImage(
            "artist-5",
            "Artist Five",
            "temp-artist-5"
        );

        expect(result).toBe("https://deezer/image.jpg");
        expect(mockFanartGetArtistImage).not.toHaveBeenCalled();
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-5" },
            data: { heroUrl: "https://deezer/image.jpg" },
        });
    });

    it("ignores Last.fm placeholder image and stores a negative cache entry", async () => {
        mockLastfmGetArtistInfo.mockResolvedValue({
            image: [
                {
                    size: "extralarge",
                    "#text":
                        "https://lastfm/2a96cbd8b46e442fc41c2b86b821562f.png",
                },
            ],
        });

        const result = await dataCacheService.getArtistImage(
            "artist-6",
            "Artist Six",
            "mbid-6"
        );

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-6",
            NEGATIVE_CACHE_SECONDS,
            "NOT_FOUND"
        );
    });

    it("continues artist lookup when DB read throws", async () => {
        mockArtistFindUnique.mockRejectedValue(new Error("db-down"));

        const result = await dataCacheService.getArtistImage(
            "artist-7",
            "Artist Seven"
        );

        expect(result).toBeNull();
        expect(mockWarn).toHaveBeenCalledWith(
            "[DataCache] DB lookup failed for artist:",
            "artist-7"
        );
    });

    it("returns album cover from DB and refreshes Redis cache", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            coverUrl: "native:albums/from-db.jpg",
        });

        const result = await dataCacheService.getAlbumCover("album-1", "rg-1");

        expect(result).toBe("native:albums/from-db.jpg");
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "album-cover:album-1",
            ONE_YEAR_SECONDS,
            "native:albums/from-db.jpg"
        );
    });

    it("uses Redis album cover cache and syncs DB", async () => {
        mockRedisGet.mockResolvedValue("native:albums/from-redis.jpg");

        const result = await dataCacheService.getAlbumCover("album-2", "rg-2");

        expect(result).toBe("native:albums/from-redis.jpg");
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-2" },
            data: { coverUrl: "native:albums/from-redis.jpg" },
        });
    });

    it("fetches album cover from Cover Art service and persists", async () => {
        mockCoverArtGet.mockResolvedValue("https://cover.art/cover.jpg");

        const result = await dataCacheService.getAlbumCover("album-3", "rg-3");

        expect(result).toBe("https://cover.art/cover.jpg");
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-3" },
            data: { coverUrl: "https://cover.art/cover.jpg" },
        });
    });

    it("stores negative cache for missing album cover", async () => {
        mockCoverArtGet.mockResolvedValue(null);

        const result = await dataCacheService.getAlbumCover("album-4", "rg-4");

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "album-cover:album-4",
            NEGATIVE_CACHE_SECONDS,
            "NOT_FOUND"
        );
    });

    it("returns track cover from album row when rgMbid is missing", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            rgMbid: null,
            coverUrl: "native:albums/existing.jpg",
        });

        const result = await dataCacheService.getTrackCover(
            "track-1",
            "album-5",
            undefined
        );

        expect(result).toBe("native:albums/existing.jpg");
        expect(mockCoverArtGet).not.toHaveBeenCalled();
    });

    it("resolves rgMbid from album and delegates to album cover retrieval", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            rgMbid: "rg-from-db",
            coverUrl: null,
        });
        mockCoverArtGet.mockResolvedValue("https://cover.art/from-rg.jpg");

        const result = await dataCacheService.getTrackCover(
            "track-2",
            "album-6",
            undefined
        );

        expect(result).toBe("https://cover.art/from-rg.jpg");
        expect(mockCoverArtGet).toHaveBeenCalledWith("rg-from-db");
    });

    it("returns null when track cover has no rgMbid source", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            rgMbid: null,
            coverUrl: null,
        });

        const result = await dataCacheService.getTrackCover(
            "track-3",
            "album-7",
            null
        );

        expect(result).toBeNull();
    });

    it("returns artist batch images from direct fields and Redis cache", async () => {
        mockRedisMGet.mockResolvedValue(["native:artists/cached.jpg", "NOT_FOUND"]);

        const result = await dataCacheService.getArtistImagesBatch([
            {
                id: "a-1",
                heroUrl: "native:artists/db.jpg",
                userHeroUrl: null,
            },
            { id: "a-2" },
            { id: "a-3" },
        ]);

        expect(result.get("a-1")).toBe("native:artists/db.jpg");
        expect(result.get("a-2")).toBe("native:artists/cached.jpg");
        expect(result.has("a-3")).toBe(false);
        expect(mockRedisMGet).toHaveBeenCalledWith(["hero:a-2", "hero:a-3"]);
    });

    it("returns album batch covers from direct fields and Redis cache", async () => {
        mockRedisMGet.mockResolvedValue(["native:albums/cached.jpg"]);

        const result = await dataCacheService.getAlbumCoversBatch([
            { id: "al-1", coverUrl: "native:albums/db.jpg" },
            { id: "al-2", coverUrl: null },
        ]);

        expect(result.get("al-1")).toBe("native:albums/db.jpg");
        expect(result.get("al-2")).toBe("native:albums/cached.jpg");
        expect(mockRedisMGet).toHaveBeenCalledWith(["album-cover:al-2"]);
    });

    it("warms up Redis cache from DB records", async () => {
        const firstMulti = createRedisMulti();
        const secondMulti = createRedisMulti();
        mockRedisMulti
            .mockImplementationOnce(() => firstMulti)
            .mockImplementationOnce(() => secondMulti);

        mockArtistFindMany.mockResolvedValue([
            { id: "artist-1", heroUrl: "native:artists/1.jpg" },
            { id: "artist-2", heroUrl: null },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            { id: "album-1", coverUrl: "native:albums/1.jpg" },
        ]);

        await dataCacheService.warmupCache();

        expect(firstMulti.setEx).toHaveBeenCalledWith(
            "hero:artist-1",
            ONE_YEAR_SECONDS,
            "native:artists/1.jpg"
        );
        expect(firstMulti.exec).toHaveBeenCalled();
        expect(secondMulti.setEx).toHaveBeenCalledWith(
            "album-cover:album-1",
            ONE_YEAR_SECONDS,
            "native:albums/1.jpg"
        );
        expect(secondMulti.exec).toHaveBeenCalled();
    });

    it("logs warmup failures without throwing", async () => {
        mockArtistFindMany.mockRejectedValue(new Error("warmup failed"));

        await expect(dataCacheService.warmupCache()).resolves.toBeUndefined();
        expect(mockError).toHaveBeenCalledWith(
            "[DataCache] Cache warmup failed:",
            expect.any(Error)
        );
    });
});
