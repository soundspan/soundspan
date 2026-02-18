import axios from "axios";
import { redisClient } from "../../utils/redis";
import { deezerService } from "../deezer";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;

describe("deezerService.getArtistImageStrict", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("returns image only for exact normalized artist-name matches", async () => {
        mockAxiosGet.mockResolvedValue({
            data: {
                data: [
                    {
                        name: "Ghost",
                        picture_xl: "https://images.example/ghost.jpg",
                    },
                    {
                        name: "The Ghost Inside",
                        picture_xl: "https://images.example/the-ghost-inside.jpg",
                    },
                ],
            },
        });

        const image = await deezerService.getArtistImageStrict("GHOST");

        expect(image).toBe("https://images.example/ghost.jpg");
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://api.deezer.com/search/artist",
            expect.objectContaining({
                params: { q: "GHOST", limit: 5 },
            })
        );
    });

    it("returns null when no strict normalized match exists", async () => {
        mockAxiosGet.mockResolvedValue({
            data: {
                data: [
                    {
                        name: "Ghostface Killah",
                        picture_xl: "https://images.example/ghostface.jpg",
                    },
                    {
                        name: "The Ghost Inside",
                        picture_xl: "https://images.example/the-ghost-inside.jpg",
                    },
                ],
            },
        });

        const image = await deezerService.getArtistImageStrict("GHOST");

        expect(image).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringContaining("deezer:artist-strict:"),
            86400,
            "null"
        );
    });
});
