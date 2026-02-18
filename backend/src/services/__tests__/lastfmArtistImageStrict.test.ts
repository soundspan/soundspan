jest.mock("../../config", () => ({
    config: {
        lastfm: {
            apiKey: "test-lastfm-key",
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        ),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { lastFmService } from "../lastfm";
import { deezerService } from "../deezer";
import { fanartService } from "../fanart";

describe("lastFmService artist image strict fallback", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("uses strict Deezer artist matching when higher-confidence sources are empty", async () => {
        const getArtistInfoSpy = jest
            .spyOn(lastFmService, "getArtistInfo")
            .mockResolvedValue(null as any);
        const fanartSpy = jest
            .spyOn(fanartService, "getArtistImage")
            .mockResolvedValue(null as any);
        const strictDeezerSpy = jest
            .spyOn(deezerService, "getArtistImageStrict")
            .mockResolvedValue("https://images.example/strict.jpg");
        const nonStrictDeezerSpy = jest
            .spyOn(deezerService, "getArtistImage")
            .mockResolvedValue("https://images.example/non-strict.jpg");

        const result = await (lastFmService as any).buildArtistSearchResult(
            {
                name: "GHOST",
                listeners: "1000",
                mbid: "",
                url: "https://last.fm/music/ghost",
                image: [],
            },
            true
        );

        expect(getArtistInfoSpy).toHaveBeenCalledWith("GHOST", "");
        expect(fanartSpy).not.toHaveBeenCalled();
        expect(strictDeezerSpy).toHaveBeenCalledWith("GHOST");
        expect(nonStrictDeezerSpy).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                image: "https://images.example/strict.jpg",
            })
        );
    });

    it("does not call strict Deezer matching when Last.fm info already has image", async () => {
        jest.spyOn(lastFmService, "getArtistInfo").mockResolvedValue({
            image: [
                {
                    size: "extralarge",
                    "#text": "https://images.example/lastfm.jpg",
                },
            ],
            bio: {},
            tags: { tag: [] },
        } as any);
        jest.spyOn(fanartService, "getArtistImage").mockResolvedValue(null as any);
        const strictDeezerSpy = jest
            .spyOn(deezerService, "getArtistImageStrict")
            .mockResolvedValue("https://images.example/strict.jpg");

        const result = await (lastFmService as any).buildArtistSearchResult(
            {
                name: "Radiohead",
                listeners: "1000",
                mbid: "",
                url: "https://last.fm/music/radiohead",
                image: [],
            },
            true
        );

        expect(strictDeezerSpy).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                image: "https://images.example/lastfm.jpg",
            })
        );
    });

    it("falls back to null image when strict Deezer lookup fails", async () => {
        jest.spyOn(lastFmService, "getArtistInfo").mockResolvedValue(null as any);
        jest
            .spyOn(fanartService, "getArtistImage")
            .mockResolvedValue(null as any);
        const strictDeezerSpy = jest
            .spyOn(deezerService, "getArtistImageStrict")
            .mockRejectedValue(new Error("strict failed"));
        const nonStrictDeezerSpy = jest
            .spyOn(deezerService, "getArtistImage")
            .mockResolvedValue("https://images.example/non-strict.jpg");

        const result = await (lastFmService as any).buildArtistSearchResult(
            {
                name: "Ghost Face",
                listeners: "500",
                mbid: "",
                url: "https://last.fm/music/ghost-face",
                image: [],
            },
            true
        );

        expect(strictDeezerSpy).toHaveBeenCalledWith("Ghost Face");
        expect(nonStrictDeezerSpy).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                image: null,
            })
        );
    });
});
