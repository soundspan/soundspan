import crypto from "crypto";

describe("wikidataService", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadWikidataService() {
        const client = {
            get: jest.fn(),
        };
        const axiosCreate = jest.fn(() => client);
        const redisClient = {
            get: jest.fn(),
            setEx: jest.fn(),
        };
        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("axios", () => ({
            __esModule: true,
            default: {
                create: axiosCreate,
            },
        }));
        jest.doMock("../../utils/redis", () => ({
            redisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../wikidata");

        return {
            wikidataService: module.wikidataService as {
                getArtistInfo: (
                    artistName: string,
                    mbid: string
                ) => Promise<{ summary?: string; heroUrl?: string }>;
            },
            client,
            axiosCreate,
            redisClient,
            logger,
        };
    }

    it("returns cached artist info when redis has payload", async () => {
        const { wikidataService, redisClient, client } = loadWikidataService();
        redisClient.get.mockResolvedValueOnce(
            JSON.stringify({ summary: "cached summary", heroUrl: "cached hero" })
        );

        const result = await wikidataService.getArtistInfo("Artist A", "mbid-a");

        expect(result).toEqual({
            summary: "cached summary",
            heroUrl: "cached hero",
        });
        expect(client.get).not.toHaveBeenCalled();
    });

    it("handles redis read errors and returns empty object when no wikidata match", async () => {
        const { wikidataService, redisClient, client, logger } =
            loadWikidataService();
        redisClient.get.mockRejectedValueOnce(new Error("redis down"));
        client.get.mockResolvedValueOnce({
            data: { results: { bindings: [] } },
        });

        const result = await wikidataService.getArtistInfo("Artist B", "mbid-b");

        expect(logger.warn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "No Wikidata entry found for Artist B"
        );
        expect(result).toEqual({});
    });

    it("fetches summary/image and caches full wikidata result", async () => {
        const { wikidataService, redisClient, client } = loadWikidataService();
        redisClient.get.mockResolvedValueOnce(null);
        redisClient.setEx.mockResolvedValueOnce("OK");

        client.get.mockImplementation(async (url: string) => {
            if (url.includes("query.wikidata.org/sparql")) {
                return {
                    data: {
                        results: {
                            bindings: [
                                {
                                    item: {
                                        value: "http://www.wikidata.org/entity/Q42",
                                    },
                                },
                            ],
                        },
                    },
                };
            }

            if (url.includes("Special:EntityData/Q42.json")) {
                return {
                    data: {
                        entities: {
                            Q42: {
                                sitelinks: {
                                    enwiki: { title: "Artist Wiki Page" },
                                },
                                claims: {
                                    P18: [
                                        {
                                            mainsnak: {
                                                datavalue: {
                                                    value: "My Image.jpg",
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                };
            }

            if (url.includes("wikipedia.org/api/rest_v1/page/summary/")) {
                return {
                    data: {
                        extract: "Artist summary text",
                    },
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await wikidataService.getArtistInfo("Artist C", "mbid-c");

        const fileName = "My_Image.jpg";
        const md5 = crypto.createHash("md5").update(fileName).digest("hex");
        const expectedHero = `https://upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5[0]}${md5[1]}/${encodeURIComponent(fileName)}`;

        expect(result).toEqual({
            summary: "Artist summary text",
            heroUrl: expectedHero,
        });
        expect(redisClient.setEx).toHaveBeenCalledWith(
            "wikidata:mbid-c",
            2592000,
            JSON.stringify(result)
        );
    });

    it("tolerates summary/image extraction failures and redis cache write failures", async () => {
        const { wikidataService, redisClient, client, logger } =
            loadWikidataService();
        redisClient.get.mockResolvedValueOnce(null);
        redisClient.setEx.mockRejectedValueOnce(new Error("redis write failed"));

        client.get.mockImplementation(async (url: string) => {
            if (url.includes("query.wikidata.org/sparql")) {
                return {
                    data: {
                        results: {
                            bindings: [
                                {
                                    item: {
                                        value: "http://www.wikidata.org/entity/Q99",
                                    },
                                },
                            ],
                        },
                    },
                };
            }
            if (url.includes("Special:EntityData/Q99.json")) {
                return {
                    data: {
                        entities: {
                            Q99: {
                                sitelinks: {},
                                claims: {},
                            },
                        },
                    },
                };
            }
            throw new Error("unexpected url");
        });

        const result = await wikidataService.getArtistInfo("Artist D", "mbid-d");

        expect(result).toEqual({
            summary: undefined,
            heroUrl: undefined,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("returns empty object and logs when wikidata lookup fails", async () => {
        const { wikidataService, redisClient, client, logger } =
            loadWikidataService();
        redisClient.get.mockResolvedValueOnce(null);
        client.get.mockRejectedValueOnce(new Error("wikidata offline"));

        const result = await wikidataService.getArtistInfo("Artist E", "mbid-e");

        expect(result).toEqual({});
        expect(logger.error).toHaveBeenCalledWith(
            "Wikidata fetch failed for Artist E:",
            expect.any(Error)
        );
    });
});
