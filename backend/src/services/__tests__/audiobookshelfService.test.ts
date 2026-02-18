const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({
    logger,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: any[]) => mockGetSystemSettings(...args),
}));

const prisma = {
    audiobook: {
        upsert: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockAxiosCreate = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (...args: any[]) => mockAxiosCreate(...args),
    },
    create: (...args: any[]) => mockAxiosCreate(...args),
}));

import { audiobookshelfService } from "../audiobookshelf";

function createClient() {
    return {
        get: jest.fn(),
        patch: jest.fn(),
    };
}

describe("audiobookshelf service behavior", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.AUDIOBOOKSHELF_URL;
        delete process.env.AUDIOBOOKSHELF_API_KEY;

        const svc = audiobookshelfService as any;
        svc.client = null;
        svc.baseUrl = null;
        svc.apiKey = null;
        svc.initialized = false;
        svc.podcastCache = null;

        mockGetSystemSettings.mockResolvedValue(null);
        prisma.audiobook.upsert.mockResolvedValue({});
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it("initializes from DB settings and pings successfully", async () => {
        const client = createClient();
        client.get.mockResolvedValue({ status: 200, data: { libraries: [] } });
        mockAxiosCreate.mockReturnValue(client);
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local/",
            audiobookshelfApiKey: "db-key",
        });

        await expect(audiobookshelfService.ping()).resolves.toBe(true);

        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: "http://abs.local",
            headers: {
                Authorization: "Bearer db-key",
            },
            timeout: 30000,
        });
        expect(client.get).toHaveBeenCalledWith("/api/libraries");
    });

    it("falls back to env settings and handles ping failures", async () => {
        const client = createClient();
        client.get.mockRejectedValueOnce(new Error("network down"));
        mockAxiosCreate.mockReturnValue(client);
        mockGetSystemSettings.mockRejectedValueOnce(new Error("db unavailable"));
        process.env.AUDIOBOOKSHELF_URL = "http://env-abs/";
        process.env.AUDIOBOOKSHELF_API_KEY = "env-key";

        await expect(audiobookshelfService.ping()).resolves.toBe(false);
        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: "http://env-abs",
            headers: {
                Authorization: "Bearer env-key",
            },
            timeout: 30000,
        });
        expect(logger.error).toHaveBeenCalledWith(
            "Audiobookshelf connection failed:",
            expect.any(Error)
        );
    });

    it("throws when Audiobookshelf is explicitly disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: false,
        });

        await expect(audiobookshelfService.getLibraries()).rejects.toThrow(
            "Audiobookshelf is disabled in settings"
        );
    });

    it("returns library and item data, and aggregates only book libraries", async () => {
        const client = createClient();
        mockAxiosCreate.mockReturnValue(client);
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local",
            audiobookshelfApiKey: "db-key",
        });

        client.get.mockImplementation(async (url: string) => {
            if (url === "/api/libraries") {
                return {
                    data: {
                        libraries: [
                            { id: "book-lib", mediaType: "book" },
                            { id: "pod-lib", mediaType: "podcast" },
                        ],
                    },
                };
            }
            if (url === "/api/libraries/book-lib/items") {
                return {
                    data: {
                        results: [
                            {
                                id: "book-1",
                                media: {
                                    metadata: {
                                        title: "Book 1",
                                        seriesName: "Series One",
                                    },
                                },
                            },
                        ],
                    },
                };
            }
            return { data: {} };
        });

        await expect(audiobookshelfService.getLibraries()).resolves.toEqual([
            { id: "book-lib", mediaType: "book" },
            { id: "pod-lib", mediaType: "podcast" },
        ]);
        await expect(audiobookshelfService.getLibraryItems("book-lib")).resolves.toEqual([
            {
                id: "book-1",
                media: {
                    metadata: {
                        title: "Book 1",
                        seriesName: "Series One",
                    },
                },
            },
        ]);
        await expect(audiobookshelfService.getAllAudiobooks()).resolves.toEqual([
            {
                id: "book-1",
                media: {
                    metadata: {
                        title: "Book 1",
                        seriesName: "Series One",
                    },
                },
            },
        ]);
    });

    it("caches podcast responses and tolerates failed podcast libraries", async () => {
        const client = createClient();
        const svc = audiobookshelfService as any;
        svc.client = client;
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        client.get.mockImplementation(async (url: string) => {
            if (url === "/api/libraries") {
                return {
                    data: {
                        libraries: [
                            { id: "pod-lib-a", mediaType: "podcast" },
                            { id: "pod-lib-b", mediaType: "podcast" },
                        ],
                    },
                };
            }
            if (url === "/api/libraries/pod-lib-a/items") {
                return {
                    data: {
                        results: [{ id: "pod-1" }],
                    },
                };
            }
            if (url === "/api/libraries/pod-lib-b/items") {
                throw new Error("podcast library failed");
            }
            return { data: {} };
        });

        const first = await audiobookshelfService.getAllPodcasts();
        expect(first).toEqual([{ id: "pod-1" }]);
        expect(logger.error).toHaveBeenCalledWith(
            "Audiobookshelf: failed to load podcast library pod-lib-b",
            expect.any(Error)
        );

        const second = await audiobookshelfService.getAllPodcasts();
        expect(second).toEqual([{ id: "pod-1" }]);
        expect(client.get).toHaveBeenCalledTimes(3);

        await audiobookshelfService.getAllPodcasts(true);
        expect(client.get).toHaveBeenCalledTimes(6);
    });

    it("reads item/progress endpoints and updates progress payload", async () => {
        const client = createClient();
        const svc = audiobookshelfService as any;
        svc.client = client;
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        client.get
            .mockResolvedValueOnce({ data: { id: "book-1" } })
            .mockResolvedValueOnce({ data: { id: "book-1" } })
            .mockResolvedValueOnce({ data: { currentTime: 120 } })
            .mockResolvedValueOnce({ data: { book: [{ id: "search-1" }] } });
        client.patch.mockResolvedValueOnce({ data: { ok: true } });

        await expect(audiobookshelfService.getAudiobook("book-1")).resolves.toEqual({
            id: "book-1",
        });
        await expect(audiobookshelfService.getPodcast("book-1")).resolves.toEqual({
            id: "book-1",
        });
        await expect(audiobookshelfService.getProgress("book-1")).resolves.toEqual({
            currentTime: 120,
        });
        await expect(
            audiobookshelfService.updateProgress("book-1", 120, 3600, true)
        ).resolves.toEqual({ ok: true });
        await expect(audiobookshelfService.searchAudiobooks("rock & roll")).resolves.toEqual([
            { id: "search-1" },
        ]);
        await expect(audiobookshelfService.getStreamUrl("book-1")).resolves.toBe(
            "http://abs.local/api/items/book-1/play"
        );

        expect(client.patch).toHaveBeenCalledWith("/api/me/progress/book-1", {
            currentTime: 120,
            duration: 3600,
            isFinished: true,
        });
        expect(client.get).toHaveBeenLastCalledWith(
            "/api/search/books?q=rock%20%26%20roll"
        );
    });

    it("streams audiobooks with range support and validates track availability", async () => {
        const client = createClient();
        const svc = audiobookshelfService as any;
        svc.client = client;
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        const getAudiobookSpy = jest.spyOn(audiobookshelfService, "getAudiobook");
        getAudiobookSpy.mockResolvedValueOnce({
            media: {
                tracks: [
                    {
                        contentUrl: "/api/items/book-1/file/123",
                    },
                ],
            },
        } as any);
        client.get.mockResolvedValueOnce({
            data: { pipe: jest.fn() },
            headers: { "content-type": "audio/mpeg" },
            status: 206,
        });

        const streamed = await audiobookshelfService.streamAudiobook(
            "book-1",
            "bytes=0-99"
        );
        expect(streamed.status).toBe(206);
        expect(client.get).toHaveBeenCalledWith("/api/items/book-1/file/123", {
            responseType: "stream",
            timeout: 0,
            headers: {
                Range: "bytes=0-99",
            },
            validateStatus: expect.any(Function),
        });

        getAudiobookSpy.mockResolvedValueOnce({ media: { tracks: [] } } as any);
        await expect(audiobookshelfService.streamAudiobook("book-2")).rejects.toThrow(
            "No audio track found for this audiobook"
        );
    });

    it("streams podcast episodes and handles missing episodes/files", async () => {
        const client = createClient();
        const svc = audiobookshelfService as any;
        svc.client = client;
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        const getPodcastSpy = jest.spyOn(audiobookshelfService, "getPodcast");
        getPodcastSpy.mockResolvedValueOnce({
            media: {
                episodes: [
                    {
                        id: "ep-1",
                        audioTrack: { contentUrl: "/api/items/pod/file/88" },
                    },
                ],
            },
        } as any);
        client.get.mockResolvedValueOnce({
            data: { pipe: jest.fn() },
            headers: { "content-type": "audio/mpeg" },
        });

        await expect(
            audiobookshelfService.streamPodcastEpisode("pod-1", "ep-1")
        ).resolves.toEqual({
            stream: expect.any(Object),
            headers: { "content-type": "audio/mpeg" },
        });

        getPodcastSpy.mockResolvedValueOnce({
            media: { episodes: [] },
        } as any);
        await expect(
            audiobookshelfService.streamPodcastEpisode("pod-1", "missing")
        ).rejects.toThrow("Episode not found");

        getPodcastSpy.mockResolvedValueOnce({
            media: {
                episodes: [{ id: "ep-2" }],
            },
        } as any);
        await expect(
            audiobookshelfService.streamPodcastEpisode("pod-1", "ep-2")
        ).rejects.toThrow("No audio file found for this episode");
    });

    it("syncs audiobooks into prisma cache and continues on per-item write failures", async () => {
        const svc = audiobookshelfService as any;
        svc.client = createClient();
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValueOnce([
            {
                id: "book-1",
                libraryId: "lib-1",
                media: {
                    duration: 1200,
                    numTracks: 12,
                    numChapters: 30,
                    size: "2048",
                    tags: ["fiction"],
                    metadata: {
                        title: "Book One",
                        authorName: "Author One",
                        narratorName: "Narrator One",
                        publishedYear: "2020",
                        series: [{ name: "Series A", sequence: "1" }],
                        coverPath: "/cover/book-1.jpg",
                    },
                },
            },
            {
                id: "book-2",
                libraryId: "lib-2",
                media: {
                    metadata: {
                        title: "Book Two",
                        seriesName: "Series Two",
                        seriesSequence: "2",
                    },
                },
            },
        ] as any);

        prisma.audiobook.upsert
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("db write failed"));

        const result = await audiobookshelfService.syncAudiobooksToCache();
        expect(result).toEqual({ synced: 1, total: 2 });

        expect(prisma.audiobook.upsert).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: { id: "book-1" },
                create: expect.objectContaining({
                    id: "book-1",
                    title: "Book One",
                    author: "Author One",
                    series: "Series A",
                    seriesSequence: "1",
                    coverUrl: "http://abs.local/cover/book-1.jpg",
                    audioUrl: "http://abs.local/api/items/book-1/play",
                }),
            })
        );
    });

    it("rethrows sync failures when audiobook fetch fails", async () => {
        const svc = audiobookshelfService as any;
        svc.client = createClient();
        svc.baseUrl = "http://abs.local";
        svc.initialized = true;

        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockRejectedValueOnce(
            new Error("fetch failed")
        );

        await expect(audiobookshelfService.syncAudiobooksToCache()).rejects.toThrow(
            "fetch failed"
        );
        expect(logger.error).toHaveBeenCalledWith(
            "[AUDIOBOOKSHELF] Audiobook sync failed:",
            expect.any(Error)
        );
    });
});
