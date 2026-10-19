const mockPrisma = {
    album: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};
const mockLogger = {
    child: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
const mockGetReleaseGroupsWithCredits = jest.fn();
const mockSearchReleaseGroups = jest.fn();

mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroupsWithCredits: mockGetReleaseGroupsWithCredits,
        searchReleaseGroups: mockSearchReleaseGroups,
    },
}));

import { VARIOUS_ARTISTS_MBID } from "../../utils/artistNormalization";
import { resolveRemoteAlbumMbids } from "../remoteAlbumMbidResolution";

const ARTIST_MBID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ARTIST_MBID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RELEASE_GROUP_MBID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-19T12:00:00.000Z");

function placeholder(
    overrides: Partial<{
        id: string;
        rgMbid: string;
        title: string;
        artist: { name: string; mbid: string | null };
        matchedRgMbid: string | null;
        tracksTidal: Array<{ title: string }>;
        tracksYtMusic: Array<{ title: string }>;
    }> = {},
) {
    return {
        id: "placeholder-album",
        rgMbid: "remote:0123456789abcdef",
        title: "OK Computer",
        artist: { name: "Radiohead", mbid: ARTIST_MBID },
        matchedRgMbid: null,
        tracksTidal: [],
        tracksYtMusic: [],
        ...overrides,
    };
}

function releaseGroup(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: RELEASE_GROUP_MBID,
        title: "OK Computer",
        "primary-type": "Album",
        "artist-credit": [
            {
                name: "Radiohead",
                artist: { id: ARTIST_MBID, name: "Radiohead" },
            },
        ],
        ...overrides,
    };
}

function dependencyError(message: string, status?: number) {
    return Object.assign(new Error(message), {
        ...(status === undefined ? {} : { response: { status } }),
    });
}

describe("resolveRemoteAlbumMbids", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger.child.mockReturnValue(mockLogger);
        mockPrisma.album.findMany.mockResolvedValue([placeholder()]);
        mockPrisma.album.updateMany.mockResolvedValue({ count: 1 });
        mockGetReleaseGroupsWithCredits.mockResolvedValue([releaseGroup()]);
        mockSearchReleaseGroups.mockResolvedValue([]);
    });

    it("selects due liked placeholders and stores a guarded matchedRgMbid", async () => {
        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockPrisma.album.findMany).toHaveBeenCalledWith({
            where: {
                location: "REMOTE",
                rgMbid: { startsWith: "remote:" },
                OR: [
                    {
                        matchedRgMbid: null,
                        OR: [
                            { rgMbidCheckedAt: null },
                            {
                                rgMbidCheckedAt: {
                                    lt: new Date("2026-10-12T12:00:00.000Z"),
                                },
                            },
                        ],
                    },
                    {
                        matchedRgMbid: { not: null },
                        rgMbidCheckedAt: {
                            lt: new Date("2026-09-19T12:00:00.000Z"),
                        },
                    },
                ],
                AND: [
                    {
                        OR: [
                            {
                                tracksTidal: {
                                    some: { likedBy: { some: {} } },
                                },
                            },
                            {
                                tracksYtMusic: {
                                    some: { likedBy: { some: {} } },
                                },
                            },
                        ],
                    },
                ],
            },
            orderBy: [
                { rgMbidCheckedAt: { sort: "asc", nulls: "first" } },
                { id: "asc" },
            ],
            take: 25,
            select: {
                id: true,
                rgMbid: true,
                title: true,
                matchedRgMbid: true,
                artist: { select: { name: true, mbid: true } },
                tracksTidal: {
                    where: { likedBy: { some: {} } },
                    take: 50,
                    select: { title: true },
                },
                tracksYtMusic: {
                    where: { likedBy: { some: {} } },
                    take: 50,
                    select: { title: true },
                },
            },
        });
        expect(mockGetReleaseGroupsWithCredits).toHaveBeenCalledWith(
            ARTIST_MBID,
            ["album", "ep", "single"],
            100,
        );
        expect(mockSearchReleaseGroups).not.toHaveBeenCalled();
        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "placeholder-album",
                rgMbid: "remote:0123456789abcdef",
            },
            data: {
                matchedRgMbid: RELEASE_GROUP_MBID,
                rgMbidCheckedAt: NOW,
            },
        });
        expect(result).toEqual({
            scanned: 1,
            matched: 1,
            missed: 0,
            skipped: 0,
            errors: 0,
        });
        expect(mockLogger.info).toHaveBeenCalledWith(
            "Remote album MusicBrainz resolution completed",
            result,
        );
    });

    it.each([
        ["the same match", RELEASE_GROUP_MBID],
        ["a replacement match", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    ])(
        "stores %s when rechecking a matched album",
        async (_label, previous) => {
            mockPrisma.album.findMany.mockResolvedValueOnce([
                placeholder({ matchedRgMbid: previous }),
            ]);

            const result = await resolveRemoteAlbumMbids({ now: NOW });

            expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "placeholder-album",
                    rgMbid: "remote:0123456789abcdef",
                },
                data: {
                    matchedRgMbid: RELEASE_GROUP_MBID,
                    rgMbidCheckedAt: NOW,
                },
            });
            expect(result.matched).toBe(1);
        },
    );

    it("clears a stale match after a confident miss", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ matchedRgMbid: RELEASE_GROUP_MBID }),
        ]);
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "placeholder-album",
                rgMbid: "remote:0123456789abcdef",
            },
            data: { matchedRgMbid: null, rgMbidCheckedAt: NOW },
        });
        expect(result.missed).toBe(1);
    });

    it("allows a Single only when a liked track has the same exact title key", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ tracksTidal: [{ title: "OK, Computer" }] }),
        ]);
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([
            releaseGroup({ "primary-type": "Single" }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(result.matched).toBe(1);
    });

    it("rejects a Single when liked titles match only after edition stripping", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({
                tracksYtMusic: [{ title: "OK Computer (Deluxe Edition)" }],
            }),
        ]);
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([
            releaseGroup({ "primary-type": "Single" }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(result.matched).toBe(0);
        expect(result.missed).toBe(1);
    });

    it("uses artist-credit IDs to reject a wrong artist on a short browse", async () => {
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([
            releaseGroup({
                "artist-credit": [
                    {
                        artist: {
                            id: OTHER_ARTIST_MBID,
                            name: "On A Friday",
                        },
                    },
                ],
            }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockSearchReleaseGroups).not.toHaveBeenCalled();
        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "placeholder-album",
                rgMbid: "remote:0123456789abcdef",
            },
            data: { rgMbidCheckedAt: NOW },
        });
        expect(result.missed).toBe(1);
    });

    it("accepts a short browse without credits only when no result carries credits", async () => {
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([
            releaseGroup({ "artist-credit": undefined }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(result.matched).toBe(1);
        expect(mockSearchReleaseGroups).not.toHaveBeenCalled();
    });

    it("discards a truncated browse and filters strict search by artist ID", async () => {
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce(
            Array.from({ length: 100 }, () => releaseGroup()),
        );
        mockSearchReleaseGroups.mockResolvedValueOnce([
            releaseGroup({
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                score: 100,
                "artist-credit": [
                    { artist: { id: OTHER_ARTIST_MBID, name: "Wrong" } },
                ],
            }),
            releaseGroup({ score: "100" }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockSearchReleaseGroups).toHaveBeenCalledWith(
            "OK Computer",
            "Radiohead",
            25,
            { strict: true },
        );
        expect(result.matched).toBe(1);
    });

    it.each([
        ["Future", "Singles", "Future Islands"],
        ["The Beatles", "Greatest Hits", "The Bootleg Beatles"],
    ])(
        "rejects the search false positive credited to %s for %s",
        async (artistName, albumTitle, creditedArtist) => {
            mockPrisma.album.findMany.mockResolvedValueOnce([
                placeholder({
                    title: albumTitle,
                    artist: { name: artistName, mbid: null },
                }),
            ]);
            mockSearchReleaseGroups.mockResolvedValueOnce([
                releaseGroup({
                    title: albumTitle,
                    score: 100,
                    "artist-credit": [{ name: creditedArtist }],
                }),
            ]);

            const result = await resolveRemoteAlbumMbids({ now: NOW });

            expect(mockGetReleaseGroupsWithCredits).not.toHaveBeenCalled();
            expect(result.missed).toBe(1);
            expect(result.matched).toBe(0);
        },
    );

    it("drops malformed search entries without failing the album lookup", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ artist: { name: "Radiohead", mbid: null } }),
        ]);
        mockSearchReleaseGroups.mockResolvedValueOnce([
            null,
            releaseGroup({ id: "not-an-mbid", score: 100 }),
            releaseGroup({ title: 42, score: 100 }),
            releaseGroup({ "primary-type": null, score: 100 }),
            releaseGroup({ "artist-credit": [{ artist: {} }], score: 100 }),
        ]);

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(result).toEqual({
            scanned: 1,
            matched: 0,
            missed: 1,
            skipped: 0,
            errors: 0,
        });
    });

    it.each([
        [{ name: "Various Artists", mbid: null }],
        [{ name: "Compilation Artist", mbid: VARIOUS_ARTISTS_MBID }],
    ])(
        "marks Various Artists albums checked without a lookup",
        async (artist) => {
            mockPrisma.album.findMany.mockResolvedValueOnce([
                placeholder({ artist }),
            ]);

            const result = await resolveRemoteAlbumMbids({ now: NOW });

            expect(mockGetReleaseGroupsWithCredits).not.toHaveBeenCalled();
            expect(mockSearchReleaseGroups).not.toHaveBeenCalled();
            expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "placeholder-album",
                    rgMbid: "remote:0123456789abcdef",
                },
                data: { rgMbidCheckedAt: NOW },
            });
            expect(result.skipped).toBe(1);
        },
    );

    it("marks a permanent 404 checked and resets the transient-error streak", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ id: "album-1" }),
            placeholder({ id: "album-2" }),
            placeholder({ id: "album-3" }),
            placeholder({ id: "album-4" }),
            placeholder({ id: "album-5" }),
        ]);
        mockGetReleaseGroupsWithCredits
            .mockRejectedValueOnce(dependencyError("timeout"))
            .mockRejectedValueOnce(dependencyError("not found", 404))
            .mockRejectedValueOnce(dependencyError("unavailable"))
            .mockRejectedValueOnce(dependencyError("still unavailable"))
            .mockResolvedValueOnce([]);

        const result = await resolveRemoteAlbumMbids({
            batchSize: 5,
            now: NOW,
        });

        expect(mockGetReleaseGroupsWithCredits).toHaveBeenCalledTimes(5);
        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "album-2",
                rgMbid: "remote:0123456789abcdef",
            },
            data: { rgMbidCheckedAt: NOW },
        });
        expect(result).toEqual({
            scanned: 5,
            matched: 0,
            missed: 1,
            skipped: 0,
            errors: 4,
        });
        expect(mockLogger.debug).toHaveBeenCalledWith(
            "Remote album MusicBrainz lookup failed",
            { albumId: "album-2", status: 404, message: "Error: not found" },
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            "Remote album MusicBrainz resolution completed",
            result,
        );
    });

    it("never clears a stale match after a permanent lookup error", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ matchedRgMbid: RELEASE_GROUP_MBID }),
        ]);
        mockGetReleaseGroupsWithCredits.mockRejectedValueOnce(
            dependencyError("not found", 404),
        );

        await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "placeholder-album",
                rgMbid: "remote:0123456789abcdef",
            },
            data: { rgMbidCheckedAt: NOW },
        });
    });

    it("marks a payload-validation TypeError checked as a permanent error", async () => {
        mockGetReleaseGroupsWithCredits.mockRejectedValueOnce(
            new TypeError("Invalid MusicBrainz release-groups response"),
        );

        const result = await resolveRemoteAlbumMbids({ now: NOW });

        expect(mockPrisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                id: "placeholder-album",
                rgMbid: "remote:0123456789abcdef",
            },
            data: { rgMbidCheckedAt: NOW },
        });
        expect(result.errors).toBe(1);
    });

    it("propagates persistence failures instead of classifying them as lookup errors", async () => {
        const persistenceError = new Error("database unavailable");
        mockGetReleaseGroupsWithCredits.mockResolvedValueOnce([]);
        mockPrisma.album.updateMany.mockRejectedValueOnce(persistenceError);

        await expect(resolveRemoteAlbumMbids({ now: NOW })).rejects.toBe(
            persistenceError,
        );
        expect(mockLogger.debug).not.toHaveBeenCalledWith(
            "Remote album MusicBrainz lookup failed",
            expect.anything(),
        );
    });

    it("leaves transient failures untouched and stops after three consecutive errors", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            placeholder({ id: "album-1" }),
            placeholder({ id: "album-2" }),
            placeholder({ id: "album-3" }),
            placeholder({ id: "album-4" }),
        ]);
        mockGetReleaseGroupsWithCredits.mockRejectedValue(
            dependencyError("unavailable", 503),
        );

        const result = await resolveRemoteAlbumMbids({
            batchSize: 4,
            now: NOW,
        });

        expect(mockGetReleaseGroupsWithCredits).toHaveBeenCalledTimes(3);
        expect(mockPrisma.album.updateMany).not.toHaveBeenCalled();
        expect(result).toEqual({
            scanned: 3,
            matched: 0,
            missed: 0,
            skipped: 0,
            errors: 3,
        });
    });

    it.each([401, 403, 408, 429])(
        "treats an HTTP %i from MusicBrainz as transient and leaves the album unchecked",
        async (status) => {
            mockPrisma.album.findMany.mockResolvedValueOnce([
                placeholder({ matchedRgMbid: RELEASE_GROUP_MBID }),
            ]);
            mockGetReleaseGroupsWithCredits.mockRejectedValueOnce(
                dependencyError("try again later", status),
            );

            const result = await resolveRemoteAlbumMbids({ now: NOW });

            expect(mockPrisma.album.updateMany).not.toHaveBeenCalled();
            expect(result.errors).toBe(1);
        },
    );

    it("rejects batch sizes outside the bounded range", async () => {
        await expect(
            resolveRemoteAlbumMbids({ batchSize: 26 }),
        ).rejects.toThrow("batchSize must be between 1 and 25");
        expect(mockPrisma.album.findMany).not.toHaveBeenCalled();
    });
});
