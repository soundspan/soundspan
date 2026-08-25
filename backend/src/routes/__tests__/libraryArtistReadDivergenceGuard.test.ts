import type { Request, Response } from "express";

const mockReadLibraryArtist = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAdmin: jest.fn(),
    requireAuth: jest.fn(),
    requireAuthOrToken: jest.fn(),
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {},
    Prisma: jest.requireActual("@prisma/client").Prisma,
}));

jest.mock("../../utils/redis", () => ({ redisClient: {} }));
jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));
jest.mock("../../services/musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../services/dataCache", () => ({ dataCacheService: {} }));
jest.mock("../../services/metadata/albumCoverResolver", () => ({
    resolveAlbumCover: jest.fn(),
}));
jest.mock("../../services/metadata/artistImageResolver", () => ({
    resolveArtistImage: jest.fn(),
}));
jest.mock("../../services/metadata/catalogPersistence", () => ({
    logCatalogPersistenceError: jest.fn(),
    persistCatalogReleaseGroups: jest.fn(),
    readFreshCatalogReleaseGroups: jest.fn(),
}));

jest.mock("../../services/libraryArtistReads", () => ({
    readLibraryArtist: mockReadLibraryArtist,
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: jest.fn(() => "json"),
    sendSubsonicError: jest.fn(),
    sendSubsonicSuccess: jest.fn(),
    SubsonicErrorCode: { GENERIC: 0, NOT_FOUND: 70 },
}));

import { handleGetArtist as handleLibraryGetArtist } from "../library/artists";
import { handleGetArtist as handleSubsonicGetArtist } from "../subsonic/browsing";

describe("shared library artist read divergence guard", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockReadLibraryArtist.mockResolvedValue(null);
    });

    it("links both artist handlers to the same visibility-aware service", async () => {
        const libraryResponse = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        } as unknown as Response;
        await handleLibraryGetArtist(
            {
                params: { id: "artist-1" },
                query: {
                    includeDiscography: "false",
                    includeTopTracks: "false",
                    includeSimilarArtists: "false",
                },
                user: { id: "user-1" },
            } as unknown as Request<{ id: string }>,
            libraryResponse,
        );
        await handleSubsonicGetArtist(
            {
                query: { id: "ar-artist-1" },
                user: { id: "user-1" },
            } as unknown as Request,
            {} as Response,
        );

        expect(mockReadLibraryArtist).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                albumLocations: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
                requireVisibleAlbum: false,
            }),
        );
        expect(mockReadLibraryArtist).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                albumLocations: ["LIBRARY", "FEDERATED"],
                requireVisibleAlbum: true,
            }),
        );
    });
});
