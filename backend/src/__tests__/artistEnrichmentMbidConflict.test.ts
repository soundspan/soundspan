export {};

var mockPrisma = {
    artist: {
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
        update: jest.fn(),
    },
    similarArtist: {
        deleteMany: jest.fn(),
        upsert: jest.fn(),
    },
};

jest.mock("../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../services/wikidata", () => ({
    wikidataService: {
        getArtistInfo: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../services/lastfm", () => ({
    lastFmService: {
        getArtistInfo: jest.fn().mockResolvedValue(null),
        getSimilarArtists: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock("../services/fanart", () => ({
    fanartService: {
        getArtistImage: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../services/deezer", () => ({
    deezerService: {
        getArtistImage: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn().mockResolvedValue([
            { id: "11111111-2222-4333-8444-555555555555" },
        ]),
    },
}));

jest.mock("../services/coverArt", () => ({
    coverArtService: {
        getCoverArt: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../utils/redis", () => ({
    redisClient: {
        setEx: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../services/imageStorage", () => ({
    downloadAndStoreImage: jest.fn().mockResolvedValue(null),
    isNativePath: jest.fn().mockReturnValue(false),
}));

const { enrichSimilarArtist } = require("../workers/artistEnrichment");

describe("artist enrichment MBID conflict handling", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.artist.update.mockResolvedValue({});
        mockPrisma.artist.findUnique.mockResolvedValue({
            id: "other-artist-id",
        });
        mockPrisma.artist.findFirst.mockResolvedValue(null);
        mockPrisma.album.findMany.mockResolvedValue([]);
        mockPrisma.album.update.mockResolvedValue({});
        mockPrisma.similarArtist.deleteMany.mockResolvedValue({});
        mockPrisma.similarArtist.upsert.mockResolvedValue({});
    });

    it("does not attempt MBID write when resolved MBID is already claimed", async () => {
        const artist = {
            id: "artist-1",
            name: "Test Artist",
            mbid: "temp-1234",
        } as any;

        await expect(enrichSimilarArtist(artist)).resolves.toBeUndefined();

        expect(mockPrisma.artist.findUnique).toHaveBeenCalledWith({
            where: { mbid: "11111111-2222-4333-8444-555555555555" },
            select: { id: true },
        });

        const attemptedMbidWrite = mockPrisma.artist.update.mock.calls.some(
            (call) =>
                call?.[0]?.where?.id === "artist-1" &&
                call?.[0]?.data?.mbid === "11111111-2222-4333-8444-555555555555"
        );
        expect(attemptedMbidWrite).toBe(false);
    });
});
