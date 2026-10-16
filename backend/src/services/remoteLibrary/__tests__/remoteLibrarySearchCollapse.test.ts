jest.mock("../../../utils/db", () => ({
    prisma: {
        likedRemoteTrack: { findMany: jest.fn() },
        trackTidal: { findMany: jest.fn() },
        trackYtMusic: { findMany: jest.fn() },
    },
}));

jest.mock("../providers", () => ({
    loadRemoteLibraryAccess: jest.fn(),
}));

jest.mock("../../../metrics", () => ({
    recordRemoteLibraryRowsCapped: jest.fn(),
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({ warn: jest.fn() })),
    },
}));

import { prisma } from "../../../utils/db";
import { loadRemoteLibraryAccess } from "../providers";
import { searchRemoteLibraryTracks } from "../remoteLibrarySearch";

const mockLikedFindMany = prisma.likedRemoteTrack.findMany as jest.Mock;
const mockTidalFindMany = prisma.trackTidal.findMany as jest.Mock;
const mockYoutubeFindMany = prisma.trackYtMusic.findMany as jest.Mock;
const mockAccess = loadRemoteLibraryAccess as jest.Mock;

const sharedMapping = [{ id: "mapping-1", trackId: "canonical-1" }];

function tidalLike() {
    return {
        likedAt: new Date(2),
        trackTidal: {
            id: "tidal-preferred",
            title: "Preferred metadata",
            artistId: null,
            albumId: null,
            albumEntity: null,
            mappings: sharedMapping,
        },
    };
}

function youtubeLike() {
    return {
        likedAt: new Date(1),
        trackYtMusic: {
            id: "youtube-duplicate",
            title: "YouTube-only match",
            artistId: null,
            albumId: null,
            albumEntity: null,
            mappings: sharedMapping,
        },
    };
}

function tidalDisplayRow() {
    return {
        id: "tidal-preferred",
        tidalId: 42,
        title: "Preferred metadata",
        artist: "Remote Artist",
        album: "Remote Album",
        duration: 180,
        artistId: null,
        albumId: null,
        artistEntity: null,
        albumEntity: null,
    };
}

describe("remote library search duplicate collapse", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAccess.mockResolvedValue({
            providers: { tidal: true, youtube: true },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        mockLikedFindMany.mockImplementation((args) =>
            Promise.resolve(
                args.where.trackTidal ? [tidalLike()] : [youtubeLike()],
            ),
        );
        mockYoutubeFindMany.mockResolvedValue([{ id: "youtube-duplicate" }]);
    });

    it("returns nothing when only the collapsed YouTube duplicate matches", async () => {
        mockTidalFindMany.mockResolvedValueOnce([]);

        await expect(
            searchRemoteLibraryTracks("user-1", "youtube-only", 5),
        ).resolves.toEqual([]);

        expect(mockLikedFindMany).toHaveBeenCalledTimes(2);
        expect(mockTidalFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { in: ["tidal-preferred"] },
                }),
            }),
        );
        expect(mockYoutubeFindMany).not.toHaveBeenCalled();
    });

    it("returns the preferred TIDAL duplicate when that row matches", async () => {
        mockTidalFindMany
            .mockResolvedValueOnce([{ id: "tidal-preferred" }])
            .mockResolvedValueOnce([tidalDisplayRow()]);

        const result = await searchRemoteLibraryTracks(
            "user-1",
            "preferred",
            5,
        );

        expect(result).toEqual([
            expect.objectContaining({
                id: "tidal:42",
                source: "tidal",
                title: "Preferred metadata",
            }),
        ]);
        expect(mockYoutubeFindMany).not.toHaveBeenCalled();
    });
});
