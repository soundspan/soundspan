const mockPrisma = {
    album: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        createMany: jest.fn(),
        update: jest.fn(),
    },
};

const mockResolveExternalAlbum = jest.fn();
const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue(mockLog),
    },
}));

jest.mock("../trackAlbumResolution", () => ({
    resolveAlbumForExternalTrack: mockResolveExternalAlbum,
}));

import {
    resolveAlbumForRemoteTrack,
    buildSyntheticRgMbid,
} from "../albumResolutionService";

describe("albumResolutionService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveExternalAlbum.mockResolvedValue({ status: "miss" });
    });

    describe("resolveAlbumForRemoteTrack", () => {
        it("returns null for empty title", async () => {
            const result = await resolveAlbumForRemoteTrack(
                "",
                "artist-1",
                "tidal",
            );
            expect(result).toBeNull();
        });

        it("returns null for 'Single'", async () => {
            const result = await resolveAlbumForRemoteTrack(
                "Single",
                "artist-1",
                "tidal",
            );
            expect(result).toBeNull();
        });

        it("returns null for 'Unknown Album'", async () => {
            const result = await resolveAlbumForRemoteTrack(
                "Unknown Album",
                "artist-1",
                "youtube",
            );
            expect(result).toBeNull();
        });

        it("returns null for 'N/A'", async () => {
            const result = await resolveAlbumForRemoteTrack(
                "N/A",
                "artist-1",
                "tidal",
            );
            expect(result).toBeNull();
        });

        it("persists a real rgMbid when a missing tag resolves externally", async () => {
            mockResolveExternalAlbum.mockResolvedValueOnce({
                status: "resolved",
                resolution: {
                    albumTitle: "OK Computer",
                    rgMbid: "rg-ok-computer",
                    artistName: "Radiohead",
                    source: "musicbrainz-recording",
                },
            });
            mockPrisma.album.findFirst.mockResolvedValueOnce(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 1 });
            mockPrisma.album.findUnique.mockResolvedValueOnce({
                id: "resolved-album",
                title: "OK Computer",
            });

            const result = await resolveAlbumForRemoteTrack(
                "",
                "artist-1",
                "tidal",
                {
                    artistName: "Radiohead",
                    trackTitle: "Paranoid Android",
                },
            );

            expect(result).toEqual({
                id: "resolved-album",
                title: "OK Computer",
                created: false,
            });
            expect(mockPrisma.album.createMany).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    title: "OK Computer",
                    rgMbid: "rg-ok-computer",
                }),
                skipDuplicates: true,
            });
        });

        it("reuses an existing synthetic album without mutating its rgMbid", async () => {
            mockResolveExternalAlbum.mockResolvedValueOnce({
                status: "resolved",
                resolution: {
                    albumTitle: "OK Computer",
                    rgMbid: "rg-ok-computer",
                    artistName: "Radiohead",
                    source: "musicbrainz-recording",
                },
            });
            mockPrisma.album.findFirst.mockResolvedValueOnce({
                id: "synthetic-album",
                title: "OK Computer",
            });

            const result = await resolveAlbumForRemoteTrack(
                "Unknown Album",
                "artist-1",
                "youtube",
                {
                    artistName: "Radiohead",
                    trackTitle: "Paranoid Android",
                },
            );

            expect(result?.id).toBe("synthetic-album");
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
            expect(mockPrisma.album.createMany).not.toHaveBeenCalled();
            expect(mockPrisma.album.findUnique).not.toHaveBeenCalled();
        });

        it("keeps a generic album unlinked when external resolution misses", async () => {
            mockResolveExternalAlbum.mockResolvedValueOnce({ status: "miss" });

            const result = await resolveAlbumForRemoteTrack(
                "Single",
                "artist-1",
                "tidal",
                { artistName: "Radiohead", trackTitle: "Creep" },
            );

            expect(result).toBeNull();
            expect(mockPrisma.album.createMany).not.toHaveBeenCalled();
        });

        it("converges two providers onto one normalized-title row", async () => {
            mockResolveExternalAlbum
                .mockResolvedValueOnce({
                    status: "resolved",
                    resolution: {
                        albumTitle: "OK Computer",
                        rgMbid: "rg-ok-computer",
                        artistName: "Radiohead",
                        source: "musicbrainz-recording",
                    },
                })
                .mockResolvedValueOnce({
                    status: "resolved",
                    resolution: {
                        albumTitle: "ok computer",
                        rgMbid: "rg-provider-variant",
                        artistName: "Radiohead",
                        source: "deezer",
                    },
                });
            mockPrisma.album.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    id: "shared-album",
                    title: "OK Computer",
                });
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 1 });
            mockPrisma.album.findUnique.mockResolvedValueOnce({
                id: "shared-album",
                title: "OK Computer",
            });

            const tidal = await resolveAlbumForRemoteTrack(
                "Unknown Album",
                "artist-1",
                "tidal",
                { artistName: "Radiohead", trackTitle: "Paranoid Android" },
            );
            const youtube = await resolveAlbumForRemoteTrack(
                "Unknown Album",
                "artist-1",
                "youtube",
                { artistName: "Radiohead", trackTitle: "Paranoid Android" },
            );

            expect(tidal?.id).toBe("shared-album");
            expect(youtube?.id).toBe("shared-album");
            expect(mockPrisma.album.createMany).toHaveBeenCalledTimes(1);
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
        });

        it("reuses an edition variant found by the existing title ladder", async () => {
            mockResolveExternalAlbum.mockResolvedValueOnce({
                status: "resolved",
                resolution: {
                    albumTitle: "Abbey Road (2019 Remaster)",
                    rgMbid: "rg-abbey-road-remaster",
                    artistName: "The Beatles",
                    source: "musicbrainz-recording",
                },
            });
            mockPrisma.album.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    id: "base-album",
                    title: "Abbey Road",
                });

            const result = await resolveAlbumForRemoteTrack(
                "Single",
                "artist-1",
                "youtube",
                { artistName: "The Beatles", trackTitle: "Come Together" },
            );

            expect(result).toEqual({
                id: "base-album",
                title: "Abbey Road",
                created: false,
            });
            expect(mockPrisma.album.createMany).not.toHaveBeenCalled();
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
        });

        it("warns and surfaces database failures during generic resolution", async () => {
            const databaseError = new Error("database unavailable");
            mockResolveExternalAlbum.mockResolvedValueOnce({
                status: "resolved",
                resolution: {
                    albumTitle: "OK Computer",
                    rgMbid: "rg-ok-computer",
                    artistName: "Radiohead",
                    source: "musicbrainz-recording",
                },
            });
            mockPrisma.album.findFirst.mockResolvedValueOnce(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockRejectedValueOnce(databaseError);

            await expect(
                resolveAlbumForRemoteTrack(
                    "Unknown Album",
                    "artist-1",
                    "tidal",
                    {
                        artistName: "Radiohead",
                        trackTitle: "Paranoid Android",
                    },
                ),
            ).rejects.toBe(databaseError);

            expect(mockLog.warn).toHaveBeenCalledWith(
                "Failed to persist resolved remote album",
                {
                    artistId: "artist-1",
                    provider: "tidal",
                    error: databaseError,
                },
            );
        });

        it("keeps synthetic creation for a usable remote album title", async () => {
            mockPrisma.album.findFirst.mockResolvedValue(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 1 });
            mockPrisma.album.findUnique.mockResolvedValueOnce({
                id: "synthetic-album",
                title: "Garbage Tag",
            });

            const result = await resolveAlbumForRemoteTrack(
                "Garbage Tag",
                "artist-1",
                "youtube",
                {
                    artistName: "Radiohead",
                    trackTitle: "Paranoid Android",
                },
            );

            expect(result?.id).toBe("synthetic-album");
            expect(mockPrisma.album.createMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        rgMbid: expect.stringMatching(/^remote:/),
                    }),
                }),
            );
            expect(mockResolveExternalAlbum).not.toHaveBeenCalled();
        });

        it("exact match (case-insensitive)", async () => {
            mockPrisma.album.findFirst.mockResolvedValueOnce({
                id: "album-1",
                title: "OK Computer",
            });

            const result = await resolveAlbumForRemoteTrack(
                "ok computer",
                "artist-1",
                "tidal",
            );
            expect(result).toEqual({
                id: "album-1",
                title: "OK Computer",
                created: false,
            });
        });

        it("edition-stripped match finds base album", async () => {
            // No exact match
            mockPrisma.album.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            // Candidate albums for edition-stripped comparison
            mockPrisma.album.findMany.mockResolvedValueOnce([
                { id: "album-2", title: "Abbey Road" },
            ]);

            const result = await resolveAlbumForRemoteTrack(
                "Abbey Road (2019 Remaster)",
                "artist-1",
                "tidal",
            );
            expect(result).toEqual({
                id: "album-2",
                title: "Abbey Road",
                created: false,
            });
        });

        it("creates new REMOTE album when no match found", async () => {
            mockPrisma.album.findFirst.mockResolvedValue(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 1 });
            mockPrisma.album.findUnique.mockResolvedValueOnce({
                id: "new-album-id",
                title: "Brand New Album",
            });

            const result = await resolveAlbumForRemoteTrack(
                "Brand New Album",
                "artist-1",
                "youtube",
            );
            expect(result).toEqual({
                id: "new-album-id",
                title: "Brand New Album",
                created: false,
            });

            expect(mockPrisma.album.createMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        title: "Brand New Album",
                        artistId: "artist-1",
                        location: "REMOTE",
                        primaryType: "Album",
                    }),
                    skipDuplicates: true,
                }),
            );
        });

        it("returns existing album when createMany reports duplicate race", async () => {
            mockPrisma.album.findFirst.mockResolvedValue(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 0 });
            mockPrisma.album.findUnique.mockResolvedValueOnce({
                id: "existing-album-id",
                title: "Brand New Album",
            });

            const result = await resolveAlbumForRemoteTrack(
                "Brand New Album",
                "artist-1",
                "tidal",
            );
            expect(result).toEqual({
                id: "existing-album-id",
                title: "Brand New Album",
                created: false,
            });
            expect(mockPrisma.album.findUnique).toHaveBeenCalledTimes(1);
        });

        it("rethrows createMany errors", async () => {
            mockPrisma.album.findFirst.mockResolvedValue(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);

            const databaseError = new Error("database unavailable");
            mockPrisma.album.createMany.mockRejectedValueOnce(databaseError);

            await expect(
                resolveAlbumForRemoteTrack("Broken Album", "artist-1", "tidal"),
            ).rejects.toThrow("database unavailable");
            expect(mockPrisma.album.findUnique).not.toHaveBeenCalled();
        });

        it("throws when createMany succeeds but lookup cannot find the album", async () => {
            mockPrisma.album.findFirst.mockResolvedValue(null);
            mockPrisma.album.findMany.mockResolvedValueOnce([]);
            mockPrisma.album.createMany.mockResolvedValueOnce({ count: 1 });
            mockPrisma.album.findUnique.mockResolvedValueOnce(null);

            await expect(
                resolveAlbumForRemoteTrack(
                    "Missing Album",
                    "artist-1",
                    "youtube",
                ),
            ).rejects.toThrow(
                "Failed to resolve remote album row after createMany",
            );
            expect(mockPrisma.album.findUnique).toHaveBeenCalledTimes(1);
        });
    });

    describe("buildSyntheticRgMbid", () => {
        it("is deterministic for same inputs", () => {
            const a = buildSyntheticRgMbid("artist-1", "album title");
            const b = buildSyntheticRgMbid("artist-1", "album title");
            expect(a).toBe(b);
        });

        it("differs for different artist IDs", () => {
            const a = buildSyntheticRgMbid("artist-1", "album title");
            const b = buildSyntheticRgMbid("artist-2", "album title");
            expect(a).not.toBe(b);
        });

        it("differs for different titles", () => {
            const a = buildSyntheticRgMbid("artist-1", "album one");
            const b = buildSyntheticRgMbid("artist-1", "album two");
            expect(a).not.toBe(b);
        });

        it("has the correct prefix format", () => {
            const result = buildSyntheticRgMbid("artist-1", "album title");
            expect(result).toMatch(/^remote:[a-f0-9]{16}$/);
        });

        it("same album from different providers resolves identically", () => {
            const a = buildSyntheticRgMbid("artist-1", "album title");
            const b = buildSyntheticRgMbid("artist-1", "album title");
            expect(a).toBe(b);
        });
    });
});
