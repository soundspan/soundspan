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

jest.mock("../metadata/artistImageResolver", () => ({
    resolveArtistImage: jest.fn(),
}));

jest.mock("../metadata/albumCoverResolver", () => ({
    resolveAlbumCover: jest.fn(),
}));

jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

import { dataCacheService } from "../dataCache";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { resolveArtistImage } from "../metadata/artistImageResolver";
import { resolveAlbumCover } from "../metadata/albumCoverResolver";
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

const mockResolveArtistImage = resolveArtistImage as jest.Mock;
const mockResolveAlbumCover = resolveAlbumCover as jest.Mock;
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

        mockResolveArtistImage.mockResolvedValue(null);
        mockResolveAlbumCover.mockResolvedValue(null);
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
            "mbid-1",
        );

        expect(result).toBe("native:artists/custom.jpg");
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-1",
            ONE_YEAR_SECONDS,
            "native:artists/custom.jpg",
        );
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockResolveArtistImage).not.toHaveBeenCalled();
    });

    it("uses Redis artist cache and syncs back to DB when DB misses", async () => {
        mockRedisGet.mockResolvedValue("native:artists/from-redis.jpg");

        const result = await dataCacheService.getArtistImage(
            "artist-2",
            "Artist Two",
        );

        expect(result).toBe("native:artists/from-redis.jpg");
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-2" },
            data: { heroUrl: "native:artists/from-redis.jpg" },
        });
        expect(mockResolveArtistImage).not.toHaveBeenCalled();
    });

    it("returns null on negative Redis artist cache hit", async () => {
        mockRedisGet.mockResolvedValue("NOT_FOUND");

        const result = await dataCacheService.getArtistImage(
            "artist-3",
            "Artist Three",
        );

        expect(result).toBeNull();
        expect(mockResolveArtistImage).not.toHaveBeenCalled();
    });

    it("resolves an artist image through the facade, stores it locally, and persists it", async () => {
        mockResolveArtistImage.mockResolvedValue({
            url: "https://fanart/image.jpg",
            source: "fanart",
        });
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/a1.jpg");

        const result = await dataCacheService.getArtistImage(
            "artist-4",
            "Artist Four",
            "mbid-4",
        );

        expect(result).toBe("native:artists/a1.jpg");
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Artist Four",
            mbid: "mbid-4",
        });
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-4" },
            data: { heroUrl: "native:artists/a1.jpg" },
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-4",
            ONE_YEAR_SECONDS,
            "native:artists/a1.jpg",
        );
    });

    it("passes a synthetic MBID to the facade and falls back to the external URL when local download fails", async () => {
        mockResolveArtistImage.mockResolvedValue({
            url: "https://deezer/image.jpg",
            source: "deezer",
        });
        mockDownloadAndStoreImage.mockResolvedValue(null);

        const result = await dataCacheService.getArtistImage(
            "artist-5",
            "Artist Five",
            "temp-artist-5",
        );

        expect(result).toBe("https://deezer/image.jpg");
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Artist Five",
            mbid: "temp-artist-5",
        });
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-5" },
            data: { heroUrl: "https://deezer/image.jpg" },
        });
    });

    it("stores its existing negative cache entry when the facade misses", async () => {
        const result = await dataCacheService.getArtistImage(
            "artist-6",
            "Artist Six",
            "mbid-6",
        );

        expect(result).toBeNull();
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Artist Six",
            mbid: "mbid-6",
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "hero:artist-6",
            NEGATIVE_CACHE_SECONDS,
            "NOT_FOUND",
        );
    });

    it("continues artist lookup when DB read throws", async () => {
        mockArtistFindUnique.mockRejectedValue(new Error("db-down"));

        const result = await dataCacheService.getArtistImage(
            "artist-7",
            "Artist Seven",
        );

        expect(result).toBeNull();
        expect(mockWarn).toHaveBeenCalledWith(
            "[DataCache] DB lookup failed for artist:",
            "artist-7",
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
            "native:albums/from-db.jpg",
        );
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
    });

    it("uses Redis album cover cache and syncs DB", async () => {
        mockRedisGet.mockResolvedValue("native:albums/from-redis.jpg");

        const result = await dataCacheService.getAlbumCover("album-2", "rg-2");

        expect(result).toBe("native:albums/from-redis.jpg");
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-2" },
            data: { coverUrl: "native:albums/from-redis.jpg" },
        });
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
    });

    it("resolves an album cover through the facade and persists it", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            coverUrl: null,
            location: "LIBRARY",
            title: "Album Three",
            artist: { name: "Artist Three" },
        });
        mockResolveAlbumCover.mockResolvedValue({
            url: "https://cover.art/cover.jpg",
            source: "deezer",
        });

        const result = await dataCacheService.getAlbumCover("album-3", "rg-3");

        expect(result).toBe("https://cover.art/cover.jpg");
        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "Artist Three",
            albumTitle: "Album Three",
            rgMbid: "rg-3",
        });
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-3" },
            data: { coverUrl: "https://cover.art/cover.jpg" },
        });
    });

    it("stores negative cache when the album cover facade misses", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            coverUrl: null,
            location: "LIBRARY",
            title: "Album Four",
            artist: { name: "Artist Four" },
        });
        mockResolveAlbumCover.mockResolvedValue(null);

        const result = await dataCacheService.getAlbumCover("album-4", "rg-4");

        expect(result).toBeNull();
        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "Artist Four",
            albumTitle: "Album Four",
            rgMbid: "rg-4",
        });
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "album-cover:album-4",
            NEGATIVE_CACHE_SECONDS,
            "NOT_FOUND",
        );
    });

    it("routes a coverless federated album with a real MBID through the album cover endpoint", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            coverUrl: null,
            location: "FEDERATED",
        });

        const result = await dataCacheService.getAlbumCover(
            "federated-album",
            "11111111-1111-4111-8111-111111111111",
        );

        expect(result).toBe("/api/library/cover-art/federated-album");
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalledWith(
            "album-cover:federated-album",
            NEGATIVE_CACHE_SECONDS,
            "NOT_FOUND",
        );
        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "federated-album" },
            select: {
                coverUrl: true,
                location: true,
                title: true,
                artist: { select: { name: true } },
            },
        });
    });

    it("returns track cover from album row when rgMbid is missing", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            rgMbid: null,
            coverUrl: "native:albums/existing.jpg",
        });

        const result = await dataCacheService.getTrackCover(
            "track-1",
            "album-5",
            undefined,
        );

        expect(result).toBe("native:albums/existing.jpg");
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
    });

    it("resolves rgMbid from album and delegates to album cover retrieval", async () => {
        mockAlbumFindUnique
            .mockResolvedValueOnce({
                rgMbid: "rg-from-db",
                coverUrl: null,
            })
            .mockResolvedValueOnce({
                coverUrl: null,
                location: "LIBRARY",
                title: "Album Six",
                artist: { name: "Artist Six" },
            });
        mockResolveAlbumCover.mockResolvedValue({
            url: "https://cover.art/from-rg.jpg",
            source: "coverartarchive",
        });

        const result = await dataCacheService.getTrackCover(
            "track-2",
            "album-6",
            undefined,
        );

        expect(result).toBe("https://cover.art/from-rg.jpg");
        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "Artist Six",
            albumTitle: "Album Six",
            rgMbid: "rg-from-db",
        });
    });

    it("returns null when track cover has no rgMbid source", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            rgMbid: null,
            coverUrl: null,
        });

        const result = await dataCacheService.getTrackCover(
            "track-3",
            "album-7",
            null,
        );

        expect(result).toBeNull();
    });

    it("returns artist batch images from direct fields and Redis cache", async () => {
        mockRedisMGet.mockResolvedValue([
            "native:artists/cached.jpg",
            "NOT_FOUND",
        ]);

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
            "native:artists/1.jpg",
        );
        expect(firstMulti.exec).toHaveBeenCalled();
        expect(secondMulti.setEx).toHaveBeenCalledWith(
            "album-cover:album-1",
            ONE_YEAR_SECONDS,
            "native:albums/1.jpg",
        );
        expect(secondMulti.exec).toHaveBeenCalled();
    });

    it("logs warmup failures without throwing", async () => {
        mockArtistFindMany.mockRejectedValue(new Error("warmup failed"));

        await expect(dataCacheService.warmupCache()).resolves.toBeUndefined();
        expect(mockError).toHaveBeenCalledWith(
            "[DataCache] Cache warmup failed:",
            expect.any(Error),
        );
    });
});
