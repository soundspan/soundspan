import path from "path";

const logger = {
    debug: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger,
}));

const prisma = {
    podcast: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    podcastEpisode: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

const fsPromises = {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    unlink: jest.fn(),
};

jest.mock("fs/promises", () => ({
    __esModule: true,
    default: fsPromises,
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/srv/music",
        },
    },
}));

import { PodcastCacheService } from "../podcastCache";

function okResponse(size = 8) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(size)),
    };
}

describe("PodcastCacheService", () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (global as any).fetch = fetchMock;

        fsPromises.mkdir.mockResolvedValue(undefined);
        fsPromises.writeFile.mockResolvedValue(undefined);
        fsPromises.readdir.mockResolvedValue([]);
        fsPromises.unlink.mockResolvedValue(undefined);

        prisma.podcast.findMany.mockResolvedValue([]);
        prisma.podcast.update.mockResolvedValue({});
        prisma.podcastEpisode.findMany.mockResolvedValue([]);
        prisma.podcastEpisode.update.mockResolvedValue({});

        fetchMock.mockResolvedValue(okResponse());
    });

    it("syncAllCovers tracks synced, skipped, and failed podcast updates", async () => {
        const service = new PodcastCacheService();

        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                id: "pod-ok",
                title: "OK",
                imageUrl: "https://img.example/ok.jpg",
            },
            {
                id: "pod-skip",
                title: "Skip",
                imageUrl: "https://img.example/skip.jpg",
            },
            {
                id: "pod-fail",
                title: "Fail",
                imageUrl: "https://img.example/fail.jpg",
            },
            {
                id: "pod-no-url",
                title: "No URL",
                imageUrl: null,
            },
        ]);

        fetchMock
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: "Not Found",
            })
            .mockResolvedValueOnce(okResponse(16));

        prisma.podcast.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("db write failed"));

        const result = await service.syncAllCovers();

        expect(result.synced).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toEqual([
            expect.stringContaining(
                "Failed to sync cover for Fail: db write failed"
            ),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(prisma.podcast.update).toHaveBeenCalledTimes(2);
        expect(prisma.podcast.update).toHaveBeenCalledWith({
            where: { id: "pod-ok" },
            data: {
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "podcasts",
                    "podcast_pod-ok.jpg"
                ),
            },
        });
        expect(fsPromises.writeFile).toHaveBeenCalledTimes(2);
    });

    it("syncAllCovers rethrows fatal setup failures", async () => {
        const service = new PodcastCacheService();
        fsPromises.mkdir.mockRejectedValueOnce(new Error("mkdir denied"));

        await expect(service.syncAllCovers()).rejects.toThrow("mkdir denied");
        expect(logger.error).toHaveBeenCalledWith(
            " Podcast cover sync failed:",
            expect.any(Error)
        );
    });

    it("syncEpisodeCovers filters non-unique images and tracks per-episode outcomes", async () => {
        const service = new PodcastCacheService();

        prisma.podcastEpisode.findMany.mockResolvedValueOnce([
            {
                id: "ep-dup",
                title: "Duplicate",
                imageUrl: "https://img.example/shared.jpg",
                podcast: { imageUrl: "https://img.example/shared.jpg" },
            },
            {
                id: "ep-ok",
                title: "Episode OK",
                imageUrl: "https://img.example/ok.jpg",
                podcast: { imageUrl: "https://img.example/shared.jpg" },
            },
            {
                id: "ep-skip",
                title: "Episode Skip",
                imageUrl: "https://img.example/skip.jpg",
                podcast: { imageUrl: "https://img.example/shared.jpg" },
            },
            {
                id: "ep-fail",
                title: "Episode Fail",
                imageUrl: "https://img.example/fail.jpg",
                podcast: { imageUrl: "https://img.example/shared.jpg" },
            },
            {
                id: "ep-no-url",
                title: "Episode No URL",
                imageUrl: null,
                podcast: { imageUrl: "https://img.example/shared.jpg" },
            },
        ]);

        fetchMock
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Server Error",
            })
            .mockResolvedValueOnce(okResponse(24));

        prisma.podcastEpisode.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("episode update failed"));

        const result = await service.syncEpisodeCovers();

        expect(result.synced).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toEqual([
            expect.stringContaining(
                "Failed to sync cover for episode Episode Fail: episode update failed"
            ),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(prisma.podcastEpisode.update).toHaveBeenCalledTimes(2);
    });

    it("syncEpisodeCovers rethrows fatal query failures", async () => {
        const service = new PodcastCacheService();
        prisma.podcastEpisode.findMany.mockRejectedValueOnce(
            new Error("query failed")
        );

        await expect(service.syncEpisodeCovers()).rejects.toThrow("query failed");
        expect(logger.error).toHaveBeenCalledWith(
            " Episode cover sync failed:",
            expect.any(Error)
        );
    });

    it("downloadCover returns null when fetch throws", async () => {
        const service = new PodcastCacheService();
        fetchMock.mockRejectedValueOnce(new Error("network error"));

        const localPath = await (service as any).downloadCover(
            "pod-net",
            "https://img.example/down.jpg",
            "podcast"
        );

        expect(localPath).toBeNull();
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to download cover for podcast pod-net:",
            "network error"
        );
    });

    it("cleanupOrphanedCovers deletes only files not referenced by podcasts or episodes", async () => {
        const service = new PodcastCacheService();

        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "podcasts",
                    "podcast_keep.jpg"
                ),
            },
            { localCoverPath: null },
        ]);
        prisma.podcastEpisode.findMany.mockResolvedValueOnce([
            {
                localCoverPath: path.join(
                    "/tmp",
                    "episode_keep.jpg"
                ),
            },
        ]);
        fsPromises.readdir.mockResolvedValueOnce([
            "podcast_keep.jpg",
            "episode_keep.jpg",
            "orphan.jpg",
        ]);

        const deleted = await service.cleanupOrphanedCovers();

        expect(deleted).toBe(1);
        expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
        expect(fsPromises.unlink).toHaveBeenCalledWith(
            path.join(
                "/srv/music",
                "cover-cache",
                "podcasts",
                "orphan.jpg"
            )
        );
    });
});
