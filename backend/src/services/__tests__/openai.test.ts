describe("openAIService", () => {
    type LoadOverrides = {
        apiKey?: string;
    };

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadOpenAIService(overrides: LoadOverrides = {}) {
        const client = {
            post: jest.fn(),
        };
        const create = jest.fn(() => client);
        const logger = {
            error: jest.fn(),
        };

        jest.doMock("axios", () => ({
            __esModule: true,
            default: { create },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("../../config", () => ({
            config: {
                openai: {
                    apiKey: overrides.apiKey ?? "test-openai-key",
                },
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../openai");

        return {
            openAIService: module.openAIService as {
                generateWeeklyPlaylist: (params: any) => Promise<any[]>;
                enhanceTrackRecommendation: (
                    track: { artist: string; title: string },
                    userContext: string
                ) => Promise<string>;
            },
            client,
            create,
            logger,
        };
    }

    function playlistParams() {
        return {
            userId: "u1",
            topArtists: [
                { name: "Artist A", playCount: 50, genres: ["rock"] },
                { name: "Artist B", playCount: 20, genres: ["funk"] },
            ],
            recentDiscoveries: ["New Artist"],
            likedArtists: ["Artist A"],
            dislikedArtists: ["Artist X"],
            targetCount: 20,
        };
    }

    it("creates axios client with OpenAI auth headers", () => {
        const { create } = loadOpenAIService({ apiKey: "abc123" });

        expect(create).toHaveBeenCalledWith({
            baseURL: "https://api.openai.com/v1",
            timeout: 60000,
            headers: {
                Authorization: "Bearer abc123",
                "Content-Type": "application/json",
            },
        });
    });

    it("generates weekly playlist and parses markdown JSON response", async () => {
        const { openAIService, client } = loadOpenAIService();

        client.post.mockResolvedValueOnce({
            data: {
                choices: [
                    {
                        message: {
                            content:
                                "```json\n{\"tracks\":[{\"artistName\":\"A\",\"trackTitle\":\"T\",\"reason\":\"R\"}]}\n```",
                        },
                    },
                ],
            },
        });

        const result = await openAIService.generateWeeklyPlaylist(playlistParams());

        expect(client.post).toHaveBeenCalledWith(
            "/chat/completions",
            expect.objectContaining({
                model: "gpt-4-turbo",
                max_tokens: 2000,
                temperature: 0.7,
                response_format: { type: "json_object" },
                messages: expect.any(Array),
            })
        );
        expect(result).toEqual([
            { artistName: "A", trackTitle: "T", reason: "R" },
        ]);
    });

    it("handles fenced non-json markdown and falls back to empty tracks array", async () => {
        const { openAIService, client } = loadOpenAIService();

        client.post.mockResolvedValueOnce({
            data: {
                choices: [
                    {
                        message: {
                            content: "```\n{\"notTracks\":true}\n```",
                        },
                    },
                ],
            },
        });

        const result = await openAIService.generateWeeklyPlaylist(playlistParams());
        expect(result).toEqual([]);
    });

    it("throws normalized error and logs parse failures", async () => {
        const { openAIService, client, logger } = loadOpenAIService();

        client.post.mockResolvedValueOnce({
            data: {
                choices: [{ message: { content: "{bad-json" } }],
            },
        });

        await expect(
            openAIService.generateWeeklyPlaylist(playlistParams())
        ).rejects.toThrow("Failed to generate playlist with AI");
        expect(logger.error).toHaveBeenCalledWith(
            "OpenAI API error:",
            expect.stringContaining("Expected property name")
        );
        expect(logger.error).toHaveBeenCalledWith("Failed to parse JSON response");
    });

    it("throws normalized error and logs API response payload on failures", async () => {
        const { openAIService, client, logger } = loadOpenAIService();

        client.post.mockRejectedValueOnce({
            response: { data: { error: "rate limited" } },
            message: "request failed",
        });

        await expect(
            openAIService.generateWeeklyPlaylist(playlistParams())
        ).rejects.toThrow("Failed to generate playlist with AI");
        expect(logger.error).toHaveBeenCalledWith("OpenAI API error:", {
            error: "rate limited",
        });
    });

    it("enhances recommendation text and trims output", async () => {
        const { openAIService, client } = loadOpenAIService();

        client.post.mockResolvedValueOnce({
            data: {
                choices: [{ message: { content: "  Fits your groove.  " } }],
            },
        });

        const result = await openAIService.enhanceTrackRecommendation(
            { artist: "Artist A", title: "Track A" },
            "loves funky basslines"
        );

        expect(client.post).toHaveBeenCalledWith(
            "/chat/completions",
            expect.objectContaining({
                model: "gpt-3.5-turbo",
                max_tokens: 50,
                temperature: 0.7,
            })
        );
        expect(result).toBe("Fits your groove.");
    });

    it("returns fallback recommendation when enhancement call fails", async () => {
        const { openAIService, client, logger } = loadOpenAIService();
        client.post.mockRejectedValueOnce(new Error("upstream down"));

        const result = await openAIService.enhanceTrackRecommendation(
            { artist: "Artist B", title: "Track B" },
            "context"
        );

        expect(logger.error).toHaveBeenCalledWith(
            "OpenAI enhancement error:",
            expect.any(Error)
        );
        expect(result).toBe("Recommended based on your listening history");
    });
});
