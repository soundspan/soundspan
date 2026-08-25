const prisma = {
    $queryRaw: jest.fn(),
    artist: {
        findMany: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
    },
    track: {
        findMany: jest.fn(),
    },
};

const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

jest.mock("../../utils/logger", () => ({
    logger,
}));

import { searchService } from "../search";

describe("search stop-word fallback", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockResolvedValue([]);
    });

    it("falls back to trigram-ranked SQL when artist FTS returns zero rows", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "The Artist",
                mbid: "mbid-1",
                heroUrl: null,
                rank: 0.77,
            },
        ]);

        const results = await searchService.searchArtists({ query: "the" });

        expect(results).toEqual([
            {
                id: "artist-1",
                name: "The Artist",
                mbid: "mbid-1",
                heroUrl: null,
                rank: 0.77,
            },
        ]);
        expect(logger.debug).toHaveBeenCalledWith(
            '[SEARCH] FTS returned 0 results for "the", falling back to ILIKE',
        );
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
        expect(prisma.artist.findMany).not.toHaveBeenCalled();
    });

    it("binds an escaped literal ILIKE pattern for fallback search", async () => {
        prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        await searchService.searchArtists({ query: "50%_r\\ock" });

        expect(prisma.$queryRaw.mock.calls[1]).toContain("%50\\%\\_r\\\\ock%");
    });
});
