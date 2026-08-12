import path from "path";

const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
logger.child.mockReturnValue(logger);

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
    rename: jest.fn(),
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

// downloadCover guards with the DNS-resolving SSRF check (async) — a string
// check alone missed hostnames that resolve to internal addresses.
const mockResolveSafeOutboundUrl = jest.fn(async (url: string) =>
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("192.168.") ||
    url.includes("resolves-private")
        ? null
        : url,
);

jest.mock("../outboundUrlSafety", () => ({
    resolveSafeOutboundUrl: (url: string) => mockResolveSafeOutboundUrl(url),
}));

import { PodcastCacheService } from "../podcastCache";
import { MAX_EXTERNAL_IMAGE_BYTES } from "../imageProxy";

function okResponse(size = 8) {
    return new Response(new Uint8Array(size), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
    });
}

function errorResponse(status: number, statusText: string) {
    return new Response(null, { status, statusText });
}

function queuePodcastCoverSync(id: string, imageUrl: string) {
    prisma.podcast.findMany.mockResolvedValueOnce([
        { id, title: id, imageUrl },
    ]);
}

describe("PodcastCacheService", () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (global as any).fetch = fetchMock;

        fsPromises.mkdir.mockResolvedValue(undefined);
        fsPromises.writeFile.mockResolvedValue(undefined);
        fsPromises.rename.mockResolvedValue(undefined);
        fsPromises.readdir.mockResolvedValue([]);
        fsPromises.unlink.mockResolvedValue(undefined);

        prisma.podcast.findMany.mockResolvedValue([]);
        prisma.podcast.update.mockResolvedValue({});
        prisma.podcastEpisode.findMany.mockResolvedValue([]);
        prisma.podcastEpisode.update.mockResolvedValue({});

        fetchMock.mockResolvedValue(okResponse());
    });

    afterEach(() => {
        jest.restoreAllMocks();
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
            .mockResolvedValueOnce(errorResponse(404, "Not Found"))
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
                "Failed to sync cover for Fail: db write failed",
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
                    "podcast_pod-ok.jpg",
                ),
            },
        });
        expect(fsPromises.writeFile).toHaveBeenCalledTimes(2);
    });

    it("syncAllCovers skips a timed-out cover and continues syncing", async () => {
        const service = new PodcastCacheService();
        const timeoutError = Object.assign(
            new Error("The operation was aborted due to timeout"),
            { name: "TimeoutError" },
        );

        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                id: "pod-timeout",
                title: "Timeout",
                imageUrl: "https://img.example/timeout.jpg",
            },
            {
                id: "pod-ok",
                title: "OK",
                imageUrl: "https://img.example/ok.jpg",
            },
        ]);
        fetchMock
            .mockRejectedValueOnce(timeoutError)
            .mockResolvedValueOnce(okResponse());

        const result = await service.syncAllCovers();

        expect(result).toEqual({
            synced: 1,
            failed: 0,
            skipped: 1,
            errors: [],
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(prisma.podcast.update).toHaveBeenCalledTimes(1);
        expect(prisma.podcast.update).toHaveBeenCalledWith({
            where: { id: "pod-ok" },
            data: {
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "podcasts",
                    "podcast_pod-ok.jpg",
                ),
            },
        });
        expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    });

    it("syncAllCovers cancels a non-ok cover response before skipping it", async () => {
        const service = new PodcastCacheService();
        const cancel = jest.fn().mockResolvedValue(undefined);

        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                id: "pod-error",
                title: "Server Error",
                imageUrl: "https://img.example/error.jpg",
            },
        ]);
        fetchMock.mockResolvedValueOnce(
            new Response(new ReadableStream({ cancel }), {
                status: 500,
                statusText: "Server Error",
            }),
        );

        const result = await service.syncAllCovers();

        expect(result).toEqual({
            synced: 0,
            failed: 0,
            skipped: 1,
            errors: [],
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
    });

    it("syncAllCovers rethrows fatal setup failures", async () => {
        const service = new PodcastCacheService();
        fsPromises.mkdir.mockRejectedValueOnce(new Error("mkdir denied"));

        await expect(service.syncAllCovers()).rejects.toThrow("mkdir denied");
        expect(logger.error).toHaveBeenCalledWith(
            " Podcast cover sync failed:",
            expect.any(Error),
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
            .mockResolvedValueOnce(errorResponse(500, "Server Error"))
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
                "Failed to sync cover for episode Episode Fail: episode update failed",
            ),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(prisma.podcastEpisode.update).toHaveBeenCalledTimes(2);
    });

    it("syncEpisodeCovers rethrows fatal query failures", async () => {
        const service = new PodcastCacheService();
        prisma.podcastEpisode.findMany.mockRejectedValueOnce(
            new Error("query failed"),
        );

        await expect(service.syncEpisodeCovers()).rejects.toThrow(
            "query failed",
        );
        expect(logger.error).toHaveBeenCalledWith(
            " Episode cover sync failed:",
            expect.any(Error),
        );
    });

    it("downloadCover returns null when fetch throws", async () => {
        const service = new PodcastCacheService();
        fetchMock.mockRejectedValueOnce(new Error("network error"));

        const localPath = await (service as any).downloadCover(
            "pod-net",
            "https://img.example/down.jpg",
            "podcast",
        );

        expect(localPath).toBeNull();
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to download cover for podcast pod-net:",
            "network error",
        );
    });

    it("downloadCover passes a timeout signal and handles its abort", async () => {
        const service = new PodcastCacheService();
        const abortController = new AbortController();
        const timeoutSpy = jest
            .spyOn(AbortSignal, "timeout")
            .mockReturnValue(abortController.signal);
        let fetchOptions: RequestInit | undefined;
        let markFetchStarted: () => void = () => undefined;
        const fetchStarted = new Promise<void>((resolve) => {
            markFetchStarted = resolve;
        });

        fetchMock.mockImplementationOnce(
            (
                _url: string | URL | Request,
                options?: RequestInit,
            ): Promise<never> => {
                fetchOptions = options;
                markFetchStarted();
                return new Promise((_resolve, reject) => {
                    abortController.signal.addEventListener(
                        "abort",
                        () => {
                            reject(
                                Object.assign(
                                    new Error(
                                        "The operation was aborted due to timeout",
                                    ),
                                    { name: "TimeoutError" },
                                ),
                            );
                        },
                        { once: true },
                    );
                });
            },
        );

        const download = (service as any).downloadCover(
            "pod-timeout",
            "https://img.example/timeout.jpg",
            "podcast",
        );
        await fetchStarted;
        abortController.abort();

        await expect(download).resolves.toBeNull();
        expect(timeoutSpy).toHaveBeenCalledWith(15000);
        expect(fetchOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(fetchOptions?.signal).toBe(abortController.signal);
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
    });

    it("downloadCover rejects private/localhost URLs (SSRF protection)", async () => {
        const service = new PodcastCacheService();

        const localPath = await (service as any).downloadCover(
            "pod-ssrf",
            "http://127.0.0.1:9200/internal",
            "podcast",
        );

        expect(localPath).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("SSRF-blocked"),
            expect.stringContaining("127.0.0.1"),
        );
    });

    it("downloadCover rejects private network URLs (SSRF protection)", async () => {
        const service = new PodcastCacheService();

        const localPath = await (service as any).downloadCover(
            "pod-priv",
            "http://192.168.1.1/admin",
            "podcast",
        );

        expect(localPath).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("downloadCover allows valid external URLs", async () => {
        const service = new PodcastCacheService();
        fetchMock.mockResolvedValueOnce(okResponse());

        const localPath = await (service as any).downloadCover(
            "pod-ext",
            "https://cdn.podcast.example/cover.jpg",
            "podcast",
        );

        expect(localPath).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockResolveSafeOutboundUrl).toHaveBeenCalledWith(
            "https://cdn.podcast.example/cover.jpg",
        );
    });

    it("downloadCover rejects a declared oversized image and cancels its body", async () => {
        const service = new PodcastCacheService();
        const cancel = jest.fn();
        const body = new ReadableStream({ cancel });
        queuePodcastCoverSync(
            "pod-declared-large",
            "https://img.example/declared-large.jpg",
        );
        fetchMock.mockResolvedValueOnce(
            new Response(body, {
                status: 200,
                headers: {
                    "content-type": "image/jpeg",
                    "content-length": String(MAX_EXTERNAL_IMAGE_BYTES + 1),
                },
            }),
        );

        const result = await service.syncAllCovers();

        expect(result).toEqual({
            synced: 0,
            failed: 0,
            skipped: 1,
            errors: [],
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(prisma.podcast.update).not.toHaveBeenCalled();
    });

    it("downloadCover rejects and cancels an oversized streamed image", async () => {
        const service = new PodcastCacheService();
        const cancel = jest.fn();
        queuePodcastCoverSync(
            "pod-streamed-large",
            "https://img.example/streamed-large.jpg",
        );
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(
                    new Uint8Array(MAX_EXTERNAL_IMAGE_BYTES + 1),
                );
            },
            cancel,
        });
        fetchMock.mockResolvedValueOnce(
            new Response(body, {
                status: 200,
                headers: { "content-type": "image/jpeg" },
            }),
        );

        const result = await service.syncAllCovers();

        expect(result.skipped).toBe(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(prisma.podcast.update).not.toHaveBeenCalled();
    });

    it.each(["text/html", null])(
        "syncAllCovers rejects the %s media type without writing it",
        async (contentType) => {
            const service = new PodcastCacheService();
            queuePodcastCoverSync(
                "pod-invalid-media",
                "https://img.example/login-page",
            );
            const headers = contentType
                ? { "content-type": contentType }
                : undefined;
            fetchMock.mockResolvedValueOnce(
                new Response("not an image", { status: 200, headers }),
            );

            const result = await service.syncAllCovers();

            expect(result.skipped).toBe(1);
            expect(fsPromises.writeFile).not.toHaveBeenCalled();
            expect(fsPromises.rename).not.toHaveBeenCalled();
            expect(prisma.podcast.update).not.toHaveBeenCalled();
        },
    );

    it("downloadCover rejects an id that would escape the cover cache", async () => {
        const service = new PodcastCacheService();
        queuePodcastCoverSync(
            "../../../../outside",
            "https://img.example/cover.jpg",
        );

        const result = await service.syncAllCovers();

        expect(result.skipped).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
        expect(prisma.podcast.update).not.toHaveBeenCalled();
    });

    it("downloadCover removes a partial temporary file when writing fails", async () => {
        const service = new PodcastCacheService();
        queuePodcastCoverSync("pod-partial", "https://img.example/cover.jpg");
        fsPromises.writeFile.mockRejectedValueOnce(new Error("disk full"));

        const result = await service.syncAllCovers();

        expect(result.skipped).toBe(1);
        expect(fsPromises.rename).not.toHaveBeenCalled();
        expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
        expect(fsPromises.unlink).toHaveBeenCalledWith(
            expect.stringMatching(/podcast_pod-partial\.jpg\..+\.tmp$/),
        );
        expect(prisma.podcast.update).not.toHaveBeenCalled();
    });

    it("downloadCover removes the temporary file when atomic rename fails", async () => {
        const service = new PodcastCacheService();
        queuePodcastCoverSync(
            "pod-rename-fail",
            "https://img.example/cover.jpg",
        );
        fsPromises.rename.mockRejectedValueOnce(new Error("rename failed"));

        const result = await service.syncAllCovers();

        expect(result.skipped).toBe(1);
        expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
        expect(fsPromises.unlink).toHaveBeenCalledWith(
            expect.stringMatching(/podcast_pod-rename-fail\.jpg\..+\.tmp$/),
        );
        expect(prisma.podcast.update).not.toHaveBeenCalled();
    });

    it("downloadCover rejects hostnames that RESOLVE to private addresses", async () => {
        // The string-only check passed any public-looking hostname; the
        // DNS-resolving guard must reject one whose records are internal.
        const service = new PodcastCacheService();

        const localPath = await (service as any).downloadCover(
            "pod-rebind",
            "https://resolves-private.example.com/cover.jpg",
            "podcast",
        );

        expect(localPath).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("cleanupOrphanedCovers deletes only files not referenced by podcasts or episodes", async () => {
        const service = new PodcastCacheService();

        prisma.podcast.findMany.mockResolvedValueOnce([
            {
                localCoverPath: path.join(
                    "/srv/music",
                    "cover-cache",
                    "podcasts",
                    "podcast_keep.jpg",
                ),
            },
            { localCoverPath: null },
        ]);
        prisma.podcastEpisode.findMany.mockResolvedValueOnce([
            {
                localCoverPath: path.join("/tmp", "episode_keep.jpg"),
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
            path.join("/srv/music", "cover-cache", "podcasts", "orphan.jpg"),
        );
    });
});
