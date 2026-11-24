import axios from "axios";
import { deezerService } from "../deezer";

jest.mock("axios");
jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(async (_key: string, fn: () => Promise<unknown>) =>
            fn(),
        ),
    },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
    },
}));

const mockGet = axios.get as jest.Mock;

describe("deezer catalog search", () => {
    beforeEach(() => mockGet.mockReset());

    it("maps artist search results", async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 27,
                        name: "Daft Punk",
                        nb_fan: 4500000,
                        link: "https://www.deezer.com/artist/27",
                        picture_xl: "https://cdn.deezer.test/27-xl.jpg",
                        picture_medium: "https://cdn.deezer.test/27-m.jpg",
                    },
                    { id: 0 },
                ],
            },
        });

        await expect(deezerService.searchArtists("daft", 5)).resolves.toEqual([
            {
                deezerId: "27",
                name: "Daft Punk",
                fans: 4500000,
                url: "https://www.deezer.com/artist/27",
                imageUrl: "https://cdn.deezer.test/27-xl.jpg",
            },
        ]);
        expect(mockGet).toHaveBeenCalledWith(
            "https://api.deezer.com/search/artist",
            expect.objectContaining({ params: { q: "daft", limit: 5 } }),
        );
    });

    it("maps track search results", async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 3135556,
                        title: "Harder, Better, Faster, Stronger",
                        duration: 224,
                        preview: "https://cdn.deezer.test/preview.mp3",
                        link: "https://www.deezer.com/track/3135556",
                        artist: { id: 27, name: "Daft Punk" },
                        album: {
                            id: 302127,
                            title: "Discovery",
                            cover_xl: "https://cdn.deezer.test/302127.jpg",
                        },
                    },
                ],
            },
        });

        await expect(deezerService.searchTracks("harder", 5)).resolves.toEqual([
            {
                deezerId: "3135556",
                title: "Harder, Better, Faster, Stronger",
                artist: "Daft Punk",
                album: "Discovery",
                durationSec: 224,
                previewUrl: "https://cdn.deezer.test/preview.mp3",
                coverUrl: "https://cdn.deezer.test/302127.jpg",
                url: "https://www.deezer.com/track/3135556",
            },
        ]);
    });

    it("propagates request failures so the caller can report them", async () => {
        mockGet.mockRejectedValueOnce(new Error("timeout"));

        await expect(deezerService.searchTracks("x", 5)).rejects.toThrow(
            "timeout",
        );
    });
});
