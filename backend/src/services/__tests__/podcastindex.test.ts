const mockGetSystemSettings = jest.fn();
const mockDecrypt = jest.fn();

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

jest.mock("../../utils/encryption", () => ({
    decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

const mockPodcastIndexFactory = jest.fn();
jest.mock("podcast-index-api", () => (...args: unknown[]) =>
    mockPodcastIndexFactory(...args)
);

import {
    searchPodcasts,
    getTrendingPodcasts,
    getPodcastsByCategory,
    getCategories,
    getPodcastByFeedUrl,
    getPodcastByItunesId,
    getRecentPodcasts,
} from "../podcastindex";

describe("podcastindex service", () => {
    const client = {
        searchByTerm: jest.fn(),
        podcastsTrending: jest.fn(),
        categoriesList: jest.fn(),
        podcastsByFeedUrl: jest.fn(),
        podcastsByFeedItunesId: jest.fn(),
        recentFeeds: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockGetSystemSettings.mockResolvedValue({
            podcastindexEnabled: true,
            podcastindexApiKey: "enc-key",
            podcastindexApiSecret: "enc-secret",
        });
        mockDecrypt.mockImplementation((value: string) => `dec:${value}`);
        mockPodcastIndexFactory.mockReturnValue(client);

        client.searchByTerm.mockResolvedValue({ feeds: [] });
        client.podcastsTrending.mockResolvedValue({ feeds: [] });
        client.categoriesList.mockResolvedValue({ feeds: [] });
        client.podcastsByFeedUrl.mockResolvedValue({ feed: {} });
        client.podcastsByFeedItunesId.mockResolvedValue({ feed: {} });
        client.recentFeeds.mockResolvedValue({ feeds: [] });
    });

    it("throws when PodcastIndex is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            podcastindexEnabled: false,
        });

        await expect(searchPodcasts("news")).rejects.toThrow(
            "PodcastIndex is not enabled in system settings"
        );
        expect(mockPodcastIndexFactory).not.toHaveBeenCalled();
    });

    it("throws when credentials are missing", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            podcastindexEnabled: true,
            podcastindexApiKey: "",
            podcastindexApiSecret: null,
        });

        await expect(searchPodcasts("news")).rejects.toThrow(
            "PodcastIndex API credentials not configured"
        );
        expect(mockPodcastIndexFactory).not.toHaveBeenCalled();
    });

    it("searches podcasts by term with explicit max", async () => {
        client.searchByTerm.mockResolvedValueOnce({ feeds: [{ id: "f1" }] });

        const result = await searchPodcasts("science", 15);

        expect(mockDecrypt).toHaveBeenCalledWith("enc-key");
        expect(mockDecrypt).toHaveBeenCalledWith("enc-secret");
        expect(mockPodcastIndexFactory).toHaveBeenCalledWith(
            "dec:enc-key",
            "dec:enc-secret",
            "soundspan"
        );
        expect(client.searchByTerm).toHaveBeenCalledWith("science", 15);
        expect(result).toEqual({ feeds: [{ id: "f1" }] });
    });

    it("gets trending podcasts with category", async () => {
        await getTrendingPodcasts(8, "music");
        expect(client.podcastsTrending).toHaveBeenCalledWith(8, null, null, "music");
    });

    it("gets podcasts by category using search fallback", async () => {
        await getPodcastsByCategory("history", 11);
        expect(client.searchByTerm).toHaveBeenCalledWith("", 11, null, null);
    });

    it("fetches categories and podcast feed lookup endpoints", async () => {
        await getCategories();
        expect(client.categoriesList).toHaveBeenCalledTimes(1);

        await getPodcastByFeedUrl("https://example.com/feed.xml");
        expect(client.podcastsByFeedUrl).toHaveBeenCalledWith(
            "https://example.com/feed.xml"
        );

        await getPodcastByItunesId("123456");
        expect(client.podcastsByFeedItunesId).toHaveBeenCalledWith("123456");
    });

    it("fetches recent podcasts with default max", async () => {
        await getRecentPodcasts();
        expect(client.recentFeeds).toHaveBeenCalledWith(20);
    });
});
