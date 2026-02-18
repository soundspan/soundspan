const mockParseURL = jest.fn();

jest.mock("rss-parser", () =>
    jest.fn().mockImplementation(() => ({
        parseURL: mockParseURL,
    }))
);

const mockLogger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import { rssParserService } from "../rss-parser";

describe("rssParserService", () => {
    beforeEach(() => {
        mockParseURL.mockReset();
        mockLogger.debug.mockReset();
        mockLogger.warn.mockReset();
        mockLogger.error.mockReset();
    });

    it("parses feed metadata and episode fields for success cases", async () => {
        mockParseURL.mockResolvedValueOnce({
            title: "Tech Talks",
            author: "Feed Author",
            description: "Weekly tech interviews",
            language: "en-US",
            link: "https://podcasts.apple.com/us/podcast/tech-talks/id123456789",
            itunesAuthor: "iTunes Author",
            itunesImage: "https://img.example.com/podcast.jpg",
            itunesExplicit: "yes",
            items: [
                {
                    guid: "ep-1",
                    title: "Episode 1",
                    content: "Long form notes",
                    enclosure: {
                        url: "https://cdn.example.com/ep1.mp3",
                        type: "audio/mpeg",
                        length: "2048",
                    },
                    itunesDuration: "01:02:03",
                    itunesEpisode: "8",
                    itunesSeason: "2",
                    itunesImage: {
                        href: "https://img.example.com/ep1.jpg",
                    },
                    pubDate: "2025-01-01T10:00:00.000Z",
                },
                {
                    link: "https://example.com/e2",
                    title: "Episode 2",
                    contentSnippet: "Short snippet",
                    enclosure: {
                        url: "https://cdn.example.com/ep2.m4a",
                        type: "audio/x-m4a",
                    },
                    itunesDuration: "3600",
                },
                {
                    title: "Episode 3",
                    enclosure: {
                        url: "https://cdn.example.com/ep3.mp3",
                        type: "audio/mpeg",
                    },
                    itunesDuration: "12:34",
                },
                {
                    title: "Episode 4",
                    enclosure: {
                        url: "https://cdn.example.com/ep4.mp3",
                        type: "audio/mpeg",
                    },
                    itunesDuration: "090",
                },
                {
                    title: "Episode 5",
                    enclosure: {
                        url: "https://cdn.example.com/ep5.mp3",
                        type: "audio/mpeg",
                    },
                },
            ],
        });

        const result = await rssParserService.parseFeed(
            "https://example.com/feed.xml"
        );

        expect(mockParseURL).toHaveBeenCalledWith("https://example.com/feed.xml");
        expect(result.podcast).toEqual({
            title: "Tech Talks",
            author: "iTunes Author",
            description: "Weekly tech interviews",
            imageUrl: "https://img.example.com/podcast.jpg",
            language: "en-US",
            explicit: true,
            itunesId: "123456789",
        });

        expect(result.episodes).toHaveLength(5);

        const [ep1, ep2, ep3, ep4, ep5] = result.episodes;

        expect(ep1).toEqual(
            expect.objectContaining({
                guid: "ep-1",
                title: "Episode 1",
                description: "Long form notes",
                audioUrl: "https://cdn.example.com/ep1.mp3",
                duration: 3723,
                episodeNumber: 8,
                season: 2,
                imageUrl: "https://img.example.com/ep1.jpg",
                fileSize: 2048,
                mimeType: "audio/mpeg",
            })
        );
        expect(ep1.publishedAt.toISOString()).toBe("2025-01-01T10:00:00.000Z");

        expect(ep2).toEqual(
            expect.objectContaining({
                guid: "https://example.com/e2",
                description: "Short snippet",
                duration: 3600,
                imageUrl: "https://img.example.com/podcast.jpg",
                fileSize: undefined,
                mimeType: "audio/x-m4a",
            })
        );
        expect(ep2.publishedAt).toBeInstanceOf(Date);
        expect(ep3.duration).toBe(754);
        expect(ep4.duration).toBe(0);
        expect(ep5.duration).toBe(0);
    });

    it("filters items without valid audio enclosures and supports mime-type fallback checks", async () => {
        mockParseURL.mockResolvedValueOnce({
            title: "Feed With Mixed Enclosures",
            author: "Feed Author",
            link: "https://example.com/no-itunes-id",
            image: {
                url: "https://images.example.com/podcast/id987654321/cover.jpg",
            },
            itunesExplicit: "clean",
            items: [
                {
                    title: "No enclosure",
                },
                {
                    title: "Video only enclosure",
                    enclosure: {
                        url: "https://cdn.example.com/video.mp4",
                        type: "video/mp4",
                    },
                },
                {
                    title: "Audio from enclosures array",
                    enclosure: {
                        url: "https://cdn.example.com/not-audio.bin",
                        type: "application/octet-stream",
                    },
                    enclosures: [
                        {
                            url: "https://cdn.example.com/fallback.mp3",
                            type: "application/octet-stream+mp3",
                            length: "4096",
                        },
                    ],
                    itunesDuration: "45",
                },
                {
                    title: "Still invalid",
                    enclosures: [
                        {
                            url: "https://cdn.example.com/no-type.mp3",
                        },
                        {
                            url: "",
                            type: "audio/mpeg",
                        },
                    ],
                },
                {
                    title: "MPEG marker accepted",
                    enclosure: {
                        url: "https://cdn.example.com/stream1",
                        type: "application/mpeg",
                    },
                },
                {
                    title: "M4A marker accepted",
                    enclosure: {
                        url: "https://cdn.example.com/stream2",
                        type: "video/m4a",
                    },
                },
            ],
        });

        const result = await rssParserService.parseFeed(
            "https://example.com/mixed-enclosures.xml"
        );

        expect(result.podcast.explicit).toBe(false);
        expect(result.podcast.itunesId).toBe("987654321");
        expect(result.episodes).toHaveLength(3);
        expect(result.episodes.map((episode) => episode.audioUrl)).toEqual([
            "https://cdn.example.com/fallback.mp3",
            "https://cdn.example.com/stream1",
            "https://cdn.example.com/stream2",
        ]);
        expect(result.episodes[0].duration).toBe(45);
        expect(result.episodes[0].fileSize).toBe(4096);
        expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    });

    it("extracts image urls from feed and item variants and falls back to podcast image", async () => {
        mockParseURL.mockResolvedValueOnce({
            title: "Image Variant Podcast",
            itunesAuthor: "Image Tester",
            itunesImage: {
                $: {
                    href: "https://img.example.com/feed-from-dollar.jpg",
                },
            },
            itunesExplicit: "explicit",
            items: [
                {
                    title: "Item iTunes image string",
                    enclosure: {
                        url: "https://cdn.example.com/1.mp3",
                        type: "audio/mpeg",
                    },
                    itunesImage: "https://img.example.com/item-1.jpg",
                },
                {
                    title: "Item iTunes image href",
                    enclosure: {
                        url: "https://cdn.example.com/2.mp3",
                        type: "audio/mpeg",
                    },
                    itunesImage: {
                        href: "https://img.example.com/item-2.jpg",
                    },
                },
                {
                    title: "Item iTunes image $.href",
                    enclosure: {
                        url: "https://cdn.example.com/3.mp3",
                        type: "audio/mpeg",
                    },
                    itunesImage: {
                        $: {
                            href: "https://img.example.com/item-3.jpg",
                        },
                    },
                },
                {
                    title: "Item image string",
                    enclosure: {
                        url: "https://cdn.example.com/4.mp3",
                        type: "audio/mpeg",
                    },
                    image: "https://img.example.com/item-4.jpg",
                },
                {
                    title: "Item image url",
                    enclosure: {
                        url: "https://cdn.example.com/5.mp3",
                        type: "audio/mpeg",
                    },
                    image: {
                        url: "https://img.example.com/item-5.jpg",
                    },
                },
                {
                    title: "No item image",
                    enclosure: {
                        url: "https://cdn.example.com/6.mp3",
                        type: "audio/mpeg",
                    },
                },
            ],
        });

        const result = await rssParserService.parseFeed(
            "https://example.com/image-variants.xml"
        );

        expect(result.podcast.imageUrl).toBe(
            "https://img.example.com/feed-from-dollar.jpg"
        );
        expect(result.podcast.explicit).toBe(true);
        expect(result.episodes.map((episode) => episode.imageUrl)).toEqual([
            "https://img.example.com/item-1.jpg",
            "https://img.example.com/item-2.jpg",
            "https://img.example.com/item-3.jpg",
            "https://img.example.com/item-4.jpg",
            "https://img.example.com/item-5.jpg",
            "https://img.example.com/feed-from-dollar.jpg",
        ]);
    });

    it("supports feed image variants for itunes href objects and plain image strings", async () => {
        mockParseURL
            .mockResolvedValueOnce({
                title: "Feed iTunes href",
                itunesImage: {
                    href: "https://img.example.com/feed-from-href.jpg",
                },
                itunesExplicit: "true",
                items: [
                    {
                        title: "Episode A",
                        enclosure: {
                            url: "https://cdn.example.com/a.mp3",
                            type: "audio/mpeg",
                        },
                    },
                ],
            })
            .mockResolvedValueOnce({
                title: "Feed image string",
                image: "https://img.example.com/feed-from-string.jpg",
                items: [
                    {
                        title: "Episode B",
                        enclosure: {
                            url: "https://cdn.example.com/b.mp3",
                            type: "audio/mpeg",
                        },
                    },
                ],
            });

        const hrefImageFeed = await rssParserService.parseFeed(
            "https://example.com/feed-itunes-href.xml"
        );
        const plainImageFeed = await rssParserService.parseFeed(
            "https://example.com/feed-image-string.xml"
        );

        expect(hrefImageFeed.podcast.imageUrl).toBe(
            "https://img.example.com/feed-from-href.jpg"
        );
        expect(hrefImageFeed.podcast.explicit).toBe(true);
        expect(hrefImageFeed.episodes[0].imageUrl).toBe(
            "https://img.example.com/feed-from-href.jpg"
        );
        expect(hrefImageFeed.podcast.itunesId).toBeUndefined();

        expect(plainImageFeed.podcast.imageUrl).toBe(
            "https://img.example.com/feed-from-string.jpg"
        );
        expect(plainImageFeed.podcast.explicit).toBe(false);
        expect(plainImageFeed.episodes[0].imageUrl).toBe(
            "https://img.example.com/feed-from-string.jpg"
        );
        expect(plainImageFeed.podcast.itunesId).toBeUndefined();
    });

    it("continues parsing when an individual episode throws during mapping", async () => {
        const brokenItem: Record<string, unknown> = {
            title: "Broken item",
            enclosure: {
                url: "https://cdn.example.com/broken.mp3",
                type: "audio/mpeg",
            },
        };
        Object.defineProperty(brokenItem, "itunesImage", {
            get() {
                throw new Error("bad image metadata");
            },
        });

        mockParseURL.mockResolvedValueOnce({
            title: "Partial Failures Podcast",
            image: "https://img.example.com/podcast-fallback.jpg",
            items: [
                {
                    title: "Good item",
                    enclosure: {
                        url: "https://cdn.example.com/good.mp3",
                        type: "audio/mpeg",
                    },
                },
                brokenItem,
            ],
        });

        const result = await rssParserService.parseFeed(
            "https://example.com/partial-failures.xml"
        );

        expect(result.episodes).toHaveLength(1);
        expect(result.episodes[0].title).toBe("Good item");
        expect(mockLogger.error).toHaveBeenCalledWith(
            '    Error parsing episode "Broken item":',
            "bad image metadata"
        );
    });

    it("wraps and rethrows top-level parseURL failures", async () => {
        mockParseURL.mockRejectedValueOnce(new Error("request timed out"));

        await expect(
            rssParserService.parseFeed("https://example.com/unreachable.xml")
        ).rejects.toThrow("Failed to parse podcast feed: request timed out");

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining("[RSS PARSER] Failed to parse feed:"),
            "request timed out"
        );
    });
});
