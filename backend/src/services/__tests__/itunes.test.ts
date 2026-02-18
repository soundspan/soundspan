const mockClient = {
    get: jest.fn(),
};

const mockAxiosCreate = jest.fn((_config?: unknown) => mockClient);

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (config: unknown) => mockAxiosCreate(config),
    },
}));

const mockRedisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

jest.mock("../../utils/redis", () => ({
    redisClient: mockRedisClient,
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import { itunesService } from "../itunes";

interface TestPodcast {
    collectionId: number;
    collectionName: string;
    artistName: string;
    feedUrl: string;
    genres: string[];
}

function podcast(id: number, name: string): TestPodcast {
    return {
        collectionId: id,
        collectionName: name,
        artistName: `Artist ${id}`,
        feedUrl: `https://feeds.example/${id}.xml`,
        genres: ["Technology"],
    };
}

describe("itunesService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();

        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.setEx.mockResolvedValue("OK");
        mockClient.get.mockResolvedValue({ data: { results: [] }, status: 200 });

        (itunesService as any).lastRequestTime = 0;
    });

    it("returns cached podcast search results on cache hit without upstream calls", async () => {
        const cached = [podcast(1, "Cached Tech Show")];
        mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cached));

        const result = await itunesService.searchPodcasts("tech", 5);

        expect(result).toEqual(cached);
        expect(mockClient.get).not.toHaveBeenCalled();
        expect(mockRedisClient.setEx).not.toHaveBeenCalled();
    });

    it("fetches and caches podcast search results on cache miss", async () => {
        const fresh = [podcast(2, "Fresh Science Show")];
        mockClient.get.mockResolvedValueOnce({
            data: { results: fresh },
            status: 200,
        });

        const result = await itunesService.searchPodcasts("science", 3);

        expect(result).toEqual(fresh);
        expect(mockClient.get).toHaveBeenCalledWith("/search", {
            params: {
                term: "science",
                media: "podcast",
                entity: "podcast",
                limit: 3,
            },
        });
        expect(mockRedisClient.setEx).toHaveBeenCalledWith(
            "itunes:search:science:3",
            2592000,
            JSON.stringify(fresh)
        );
    });

    it("waits for the rate limiter window before making an uncached request", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

        (itunesService as any).lastRequestTime = Date.now();
        mockClient.get.mockResolvedValueOnce({
            data: { results: [podcast(3, "Rate Limited Show")] },
            status: 200,
        });

        const pending = itunesService.searchPodcasts("timing", 1);
        await Promise.resolve();

        expect(mockClient.get).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(2999);
        expect(mockClient.get).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual([podcast(3, "Rate Limited Show")]);
        expect(mockClient.get).toHaveBeenCalledTimes(1);
    });

    it("extracts top keywords while filtering stopwords, punctuation, and numbers", () => {
        const keywords = itunesService.extractSearchKeywords(
            "The Science Podcast: Space and Rockets",
            "Rockets rockets rockets! Space 2024 episode update.",
            "Jane Space"
        );

        expect(keywords[0]).toBe("rockets");
        expect(keywords).toEqual(
            expect.arrayContaining(["space", "science", "jane"])
        );
        expect(keywords).not.toContain("podcast");
        expect(keywords).not.toContain("2024");
        expect(keywords).not.toContain("the");
        expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it("falls back to searching by title when keyword extraction yields no terms", async () => {
        const fallbackResults = [podcast(4, "Fallback Match")];
        const searchSpy = jest
            .spyOn(itunesService, "searchPodcasts")
            .mockResolvedValueOnce(fallbackResults as any);

        const result = await itunesService.getSimilarPodcasts(
            "The Podcast Show Episode 2024",
            undefined,
            undefined,
            3
        );

        expect(result).toEqual(fallbackResults);
        expect(searchSpy).toHaveBeenCalledWith(
            "The Podcast Show Episode 2024",
            3
        );
    });

    it("filters out near-duplicate original podcasts from similar results", async () => {
        const title = "Neural Narratives Weekly Deep Dive";
        const searchSpy = jest
            .spyOn(itunesService, "searchPodcasts")
            .mockResolvedValueOnce([
                podcast(10, "Neural Narratives Weekly Deep Dive"),
                podcast(11, "AI Research Roundup"),
                podcast(12, "Machine Learning Stories"),
            ] as any);

        const result = await itunesService.getSimilarPodcasts(
            title,
            "Neural models and research conversations",
            "Host Name",
            2
        );

        expect(searchSpy).toHaveBeenCalledWith("neural", 4);
        expect(result).toEqual([
            podcast(11, "AI Research Roundup"),
            podcast(12, "Machine Learning Stories"),
        ]);
    });

    it("continues when redis cache read/write fails", async () => {
        const fresh = [podcast(20, "Resilient Podcast")];
        mockRedisClient.get.mockRejectedValueOnce(new Error("redis read failed"));
        mockRedisClient.setEx.mockRejectedValueOnce(new Error("redis write failed"));
        mockClient.get.mockResolvedValueOnce({
            data: { results: fresh },
            status: 200,
        });

        const result = await itunesService.searchPodcasts("resilience", 2);

        expect(result).toEqual(fresh);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("looks up a podcast by id and returns null when no results exist", async () => {
        mockClient.get
            .mockResolvedValueOnce({
                data: { results: [podcast(31, "Lookup Result")] },
                status: 200,
            })
            .mockResolvedValueOnce({
                data: { results: [] },
                status: 200,
            });

        await expect(itunesService.getPodcastById(31)).resolves.toEqual(
            podcast(31, "Lookup Result")
        );
        (itunesService as any).lastRequestTime = 0;
        await expect(itunesService.getPodcastById(32)).resolves.toBeNull();

        expect(mockClient.get).toHaveBeenNthCalledWith(1, "/lookup", {
            params: {
                id: 31,
                entity: "podcast",
            },
        });
        expect(mockClient.get).toHaveBeenNthCalledWith(2, "/lookup", {
            params: {
                id: 32,
                entity: "podcast",
            },
        });
    });

    it("returns cached top podcasts by genre without HTTP request", async () => {
        const cached = [podcast(90, "Cached Genre Podcast")];
        mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cached));

        const result = await itunesService.getTopPodcastsByGenre(1301, 4);

        expect(result).toEqual(cached);
        expect(mockClient.get).not.toHaveBeenCalled();
    });

    it("maps RSS feed entries for top podcasts by genre and filters invalid IDs", async () => {
        mockClient.get.mockResolvedValueOnce({
            status: 200,
            data: {
                feed: {
                    entry: [
                        {
                            id: { attributes: { "im:id": "101" } },
                            "im:name": { label: "Mapped Show" },
                            "im:artist": { label: "Mapped Host" },
                            "im:image": [
                                { attributes: { height: "60" }, label: "https://img/60.jpg" },
                                { attributes: { height: "170" }, label: "https://img/170.jpg" },
                            ],
                            category: { attributes: { label: "Technology" } },
                            link: { attributes: { href: "https://itunes/show/101" } },
                        },
                        {
                            id: { attributes: { "im:id": "0" } },
                            "im:name": { label: "Invalid Podcast" },
                            "im:artist": { label: "Invalid Host" },
                            "im:image": [],
                        },
                    ],
                },
            },
        });

        const result = await itunesService.getTopPodcastsByGenre(1301, 2);

        expect(result).toEqual([
            {
                collectionId: 101,
                collectionName: "Mapped Show",
                artistName: "Mapped Host",
                artworkUrl600: "https://img/170.jpg",
                artworkUrl100: "https://img/60.jpg",
                feedUrl: "",
                genres: ["Technology"],
                trackCount: 0,
                primaryGenreName: "Technology",
                collectionViewUrl: "https://itunes/show/101",
            },
        ]);
        expect(mockClient.get).toHaveBeenCalledWith(
            "/us/rss/toppodcasts/genre=1301/limit=2/json"
        );
    });

    it("handles RSS single-entry payloads and title/artist fallbacks", async () => {
        mockClient.get.mockResolvedValueOnce({
            status: 200,
            data: {
                feed: {
                    entry: {
                        id: { attributes: { "im:id": "222" } },
                        title: { label: "Single Entry Show - Single Entry Host" },
                        "im:image": [],
                        category: { attributes: { label: "Business" } },
                        link: { attributes: { href: "https://itunes/show/222" } },
                    },
                },
            },
        });

        const result = await itunesService.getTopPodcastsByGenre(1321, 1);

        expect(result).toEqual([
            expect.objectContaining({
                collectionId: 222,
                collectionName: "Single Entry Show",
                artistName: "Single Entry Host",
            }),
        ]);
    });

    it("returns empty list when top podcasts genre request fails", async () => {
        mockClient.get.mockRejectedValueOnce(new Error("rss down"));

        const result = await itunesService.getTopPodcastsByGenre(1301, 3);

        expect(result).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[iTunes] ERROR in requestFn:",
            expect.any(Error)
        );
    });
});
