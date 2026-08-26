const mockTransaction = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    album: { findMany: jest.fn(), update: jest.fn() },
    discoveryAlbum: { updateMany: jest.fn() },
    ownedAlbum: {
        deleteMany: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
    track: { count: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
    trackTidal: { updateMany: jest.fn() },
    trackYtMusic: { updateMany: jest.fn() },
};
const mockPrisma = {
    $transaction: jest.fn(),
    album: { count: jest.fn(), findMany: jest.fn() },
};
const mockLogger = {
    child: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
};
const mockRecomputeAlbumLoudness = jest.fn();
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../albumLoudness", () => ({
    recomputeAlbumLoudness: mockRecomputeAlbumLoudness,
}));

import {
    deduplicateScannerAlbums,
    groupScannerAlbumDuplicates,
    SCANNER_ALBUM_DEDUP_MAX_GROUPS,
    selectScannerAlbumKeeper,
    trackDirectoriesOverlap,
    type ScannerAlbumDedupCandidate,
} from "../scannerAlbumDedup";
import { selectPreferredAlbumOwnershipSource } from "../albumOwnershipPromotion";

function album(
    id: string,
    title: string,
    rgMbid: string,
    activeTrackCount: number,
    artistId = "artist-1",
    location: "LIBRARY" | "DISCOVER" = "LIBRARY",
    hasUserOverrides = false,
): ScannerAlbumDedupCandidate {
    return {
        id,
        artistId,
        title,
        rgMbid,
        activeTrackCount,
        location,
        hasUserOverrides,
    };
}

function mockLockedTrackIds(...ids: string[]): void {
    mockTransaction.track.findMany.mockResolvedValueOnce(
        ids.map((id) => ({ id })),
    );
    mockTransaction.$queryRaw
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValueOnce([{ id: "keeper" }, { id: "loser" }]);
}

function lockedTable(query: { strings: readonly string[] }): string {
    const sql = query.strings.join("");
    if (sql.includes('FROM "Track"')) return "Track";
    if (sql.includes('FROM "Album"')) return "Album";
    return "unknown";
}

describe("scanner album dedup policy", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger.child.mockReturnValue(mockLogger);
        mockPrisma.album.count.mockResolvedValue(0);
        mockPrisma.$transaction.mockImplementation(async (operation) =>
            operation(mockTransaction),
        );
        mockTransaction.$executeRaw.mockResolvedValue(0);
        mockTransaction.$queryRaw.mockResolvedValue([]);
        mockTransaction.album.update.mockResolvedValue({});
        mockTransaction.discoveryAlbum.updateMany.mockResolvedValue({
            count: 0,
        });
        mockTransaction.ownedAlbum.deleteMany.mockResolvedValue({ count: 0 });
        mockTransaction.ownedAlbum.findMany.mockResolvedValue([]);
        mockTransaction.ownedAlbum.findUnique.mockResolvedValue(null);
        mockTransaction.ownedAlbum.upsert.mockResolvedValue({});
        mockTransaction.track.count.mockResolvedValue(0);
        mockTransaction.track.findMany.mockResolvedValue([]);
        mockTransaction.track.updateMany.mockResolvedValue({ count: 0 });
        mockTransaction.trackTidal.updateMany.mockResolvedValue({ count: 0 });
        mockTransaction.trackYtMusic.updateMany.mockResolvedValue({ count: 0 });
        mockRecomputeAlbumLoudness.mockResolvedValue(undefined);
    });

    it("groups scanner albums by artist and normalized exact title", () => {
        const groups = groupScannerAlbumDuplicates([
            album("album-1", "Café & Rain", "real-1", 10),
            album("album-2", "Cafe and Rain", "temp-2", 1),
            album("album-3", "Cafe—And—Rain", "temp-3", 2),
            album("album-4", "Cafe and Rain", "temp-4", 1, "artist-2"),
            album("album-5", "Take Care (Deluxe)", "temp-5", 1),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].albums.map((candidate) => candidate.id)).toEqual([
            "album-1",
            "album-2",
            "album-3",
        ]);
    });

    it("selects the sole real release-group identity as keeper", () => {
        const real = album("album-real", "Album", "real-rg", 1);
        const temporary = album("album-temp", "album", "temp-rg", 20);

        expect(selectScannerAlbumKeeper([temporary, real])).toEqual({
            keeper: real,
            losers: [temporary],
        });
    });

    it("uses active track count and then oldest id for temporary rows", () => {
        const oldest = album("album-a", "Album", "temp-a", 5);
        const newer = album("album-b", "album", "temp-b", 5);
        const sparse = album("album-c", "ALBUM", "temp-c", 1);

        expect(selectScannerAlbumKeeper([newer, sparse, oldest])).toEqual({
            keeper: oldest,
            losers: [newer, sparse],
        });
    });

    it("prefers a LIBRARY temporary row before active track count", () => {
        const discover = album(
            "album-a",
            "Album",
            "temp-a",
            20,
            "artist-1",
            "DISCOVER",
        );
        const library = album(
            "album-b",
            "album",
            "temp-b",
            1,
            "artist-1",
            "LIBRARY",
        );

        expect(selectScannerAlbumKeeper([discover, library])).toEqual({
            keeper: library,
            losers: [discover],
        });
    });

    it("leaves groups with multiple real release-group identities untouched", () => {
        expect(
            selectScannerAlbumKeeper([
                album("album-a", "Album", "real-a", 3),
                album("album-b", "album", "real-b", 2),
                album("album-c", "ALBUM", "temp-c", 1),
            ]),
        ).toBeNull();
    });

    it("requires every loser directory to already belong to the keeper", () => {
        expect(
            trackDirectoriesOverlap(
                ["Artist/Album/01.flac", "Artist/Album/bonus/02.flac"],
                ["Artist/Album/03.flac"],
            ),
        ).toBe(true);
        expect(
            trackDirectoriesOverlap(
                ["Artist/Album/01.flac"],
                ["Artist/Album/02.flac", "Artist/Other/03.flac"],
            ),
        ).toBe(false);
    });

    it("caps duplicate groups per maintenance run", () => {
        const candidates = Array.from(
            { length: SCANNER_ALBUM_DEDUP_MAX_GROUPS + 1 },
            (_unused, index) => [
                album(
                    `album-${index.toString().padStart(3, "0")}-a`,
                    `Album ${index}`,
                    `real-${index}`,
                    2,
                ),
                album(
                    `album-${index.toString().padStart(3, "0")}-b`,
                    `album ${index}`,
                    `temp-${index}`,
                    1,
                ),
            ],
        ).flat();

        expect(groupScannerAlbumDuplicates(candidates)).toHaveLength(
            SCANNER_ALBUM_DEDUP_MAX_GROUPS,
        );
    });

    it("uses canonical ownership precedence when merging a loser", () => {
        expect(
            selectPreferredAlbumOwnershipSource(
                "enrichment",
                "discovery_liked",
            ),
        ).toBe("discovery_liked");
        expect(
            selectPreferredAlbumOwnershipSource(
                "discovery_liked",
                "native_scan",
            ),
        ).toBe("native_scan");
    });

    it("locks track rows before album rows within the merge transaction", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-track",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        await deduplicateScannerAlbums();

        expect(
            mockTransaction.$queryRaw.mock.calls.map(([query]) =>
                lockedTable(query),
            ),
        ).toEqual(["Track", "Album"]);
    });

    it("reparents only the locked loser track ids and refreshes derived state", async () => {
        const identities = [
            album("keeper", "Café & Rain", "real-keeper", 0),
            album("loser", "Cafe and Rain", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-active", "loser-active", "loser-removed");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-active",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-active",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-removed",
                albumId: "loser",
                filePath: "Artist/Old/03.flac",
                origin: "LOCAL",
                removedAt: new Date("2026-08-25T00:00:00.000Z"),
            },
        ]);
        mockTransaction.ownedAlbum.findUnique
            .mockResolvedValueOnce({ source: "enrichment" })
            .mockResolvedValueOnce({ source: "discovery_liked" });
        mockTransaction.ownedAlbum.deleteMany.mockResolvedValueOnce({
            count: 1,
        });
        mockTransaction.discoveryAlbum.updateMany.mockResolvedValueOnce({
            count: 1,
        });
        mockTransaction.trackTidal.updateMany.mockResolvedValueOnce({
            count: 1,
        });
        mockTransaction.track.updateMany.mockResolvedValueOnce({ count: 2 });

        const result = await deduplicateScannerAlbums();

        expect(mockTransaction.track.findMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["keeper-active", "loser-active", "loser-removed"] },
            },
            orderBy: { id: "asc" },
            select: {
                albumId: true,
                filePath: true,
                id: true,
                origin: true,
                removedAt: true,
            },
        });
        expect(mockPrisma.album.findMany).toHaveBeenNthCalledWith(1, {
            where: { location: { in: ["LIBRARY", "DISCOVER"] } },
            orderBy: { id: "asc" },
            take: 100,
            select: {
                id: true,
                artistId: true,
                hasUserOverrides: true,
                location: true,
                title: true,
                rgMbid: true,
            },
        });
        expect(mockTransaction.track.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["loser-active", "loser-removed"] } },
            data: { albumId: "keeper" },
        });
        expect(mockTransaction.ownedAlbum.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: { source: "discovery_liked" },
            }),
        );
        expect(mockTransaction.discoveryAlbum.updateMany).toHaveBeenCalled();
        expect(mockTransaction.trackTidal.updateMany).toHaveBeenCalled();
        expect(mockTransaction.trackYtMusic.updateMany).toHaveBeenCalled();
        expect(mockRecomputeAlbumLoudness).toHaveBeenCalledWith(
            mockTransaction,
            ["keeper"],
        );
        expect(result).toEqual(
            expect.objectContaining({
                affectedArtistIds: ["artist-1"],
                merged: 1,
                skippedNoDirOverlap: 0,
            }),
        );
    });

    it("drops locked tracks that no longer belong to the revalidated group", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-locked", "moved-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-locked",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "moved-track",
                albumId: "other-album",
                filePath: "Artist/Album/03.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        await deduplicateScannerAlbums();

        expect(mockTransaction.track.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["loser-locked"] } },
            data: { albumId: "keeper" },
        });
    });

    it("skips the full group when a loser has an active local null path", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-path", "loser-null");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-path",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-null",
                albumId: "loser",
                filePath: null,
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        const result = await deduplicateScannerAlbums();

        expect(result.skippedNullActiveLocalPath).toBe(1);
        expect(result.merged).toBe(0);
        expect(mockTransaction.track.updateMany).not.toHaveBeenCalled();
    });

    it("skips the full group when a loser has user overrides", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album(
                "loser",
                "album",
                "temp-loser",
                0,
                "artist-1",
                "LIBRARY",
                true,
            ),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-track",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        const result = await deduplicateScannerAlbums();

        expect(result.skippedUserOverrides).toBe(1);
        expect(result.merged).toBe(0);
        expect(mockTransaction.track.updateMany).not.toHaveBeenCalled();
    });

    it("promotes a DISCOVER real keeper before transferring LIBRARY ownership", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0, "artist-1", "DISCOVER"),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-track",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);
        mockTransaction.ownedAlbum.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ source: "native_scan" });

        await deduplicateScannerAlbums();

        expect(mockTransaction.album.update).toHaveBeenCalledWith({
            where: { id: "keeper" },
            data: { location: "LIBRARY" },
        });
        expect(
            mockTransaction.album.update.mock.invocationCallOrder[0],
        ).toBeLessThan(
            mockTransaction.ownedAlbum.upsert.mock.invocationCallOrder[0],
        );
        expect(mockTransaction.ownedAlbum.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ source: "native_scan" }),
                update: { source: "native_scan" },
            }),
        );
    });

    it("does not let a soft-removed keeper path satisfy the guard", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Other/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-track",
                albumId: "loser",
                filePath: "Artist/Target/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        const result = await deduplicateScannerAlbums();

        expect(result.skippedNoDirOverlap).toBe(1);
        expect(mockTransaction.track.updateMany).not.toHaveBeenCalled();
    });

    it("skips a loser with no active local tracks", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);

        const result = await deduplicateScannerAlbums();

        expect(result.skippedNoActiveLocalTracks).toBe(1);
        expect(mockTransaction.track.updateMany).not.toHaveBeenCalled();
    });

    it("skips a group above the total track-row ceiling", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.track.findMany.mockResolvedValueOnce(
            Array.from({ length: 2_001 }, (_unused, index) => ({
                id: `track-${index}`,
            })),
        );

        const result = await deduplicateScannerAlbums();

        expect(result.skippedTrackLimit).toBe(1);
        expect(mockTransaction.track.findMany).toHaveBeenCalledTimes(1);
    });

    it("skips the full group when ownership references violate album identity", async () => {
        const identities = [
            album("keeper", "Album", "real-keeper", 0),
            album("loser", "album", "temp-loser", 0),
        ];
        mockPrisma.album.findMany.mockResolvedValueOnce(identities);
        mockTransaction.album.findMany.mockResolvedValueOnce(identities);
        mockLockedTrackIds("keeper-track", "loser-track");
        mockTransaction.track.findMany.mockResolvedValueOnce([
            {
                id: "keeper-track",
                albumId: "keeper",
                filePath: "Artist/Album/01.flac",
                origin: "LOCAL",
                removedAt: null,
            },
            {
                id: "loser-track",
                albumId: "loser",
                filePath: "Artist/Album/02.flac",
                origin: "LOCAL",
                removedAt: null,
            },
        ]);
        mockTransaction.ownedAlbum.findMany.mockResolvedValueOnce([
            {
                artistId: "different-artist",
                rgMbid: "temp-loser",
            },
        ]);

        const result = await deduplicateScannerAlbums();

        expect(result.skippedUnsafeReferences).toBe(1);
        expect(mockTransaction.track.updateMany).not.toHaveBeenCalled();
    });

    it("counts a failed group and continues to the next group", async () => {
        mockPrisma.album.findMany.mockResolvedValueOnce([
            album("a-keeper", "Album A", "real-a", 0),
            album("a-loser", "album a", "temp-a", 0),
            album("b-keeper", "Album B", "real-b", 0),
            album("b-loser", "album b", "temp-b", 0),
        ]);
        mockPrisma.$transaction
            .mockRejectedValueOnce(new Error("group failed"))
            .mockResolvedValueOnce({
                merged: [],
                skippedBothReal: 0,
                skippedNoActiveLocalTracks: 1,
                skippedNoDirOverlap: 0,
                skippedNullActiveLocalPath: 0,
                skippedRevalidation: 0,
                skippedTrackLimit: 0,
                skippedUnsafeReferences: 0,
                skippedUserOverrides: 0,
                affectedArtistIds: [],
            });

        const result = await deduplicateScannerAlbums();

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        expect(result).toEqual(
            expect.objectContaining({
                failed: 1,
                skippedNoActiveLocalTracks: 1,
            }),
        );
    });

    it("reports duplicate groups deferred by the group cap", async () => {
        const candidates = Array.from({ length: 201 }, (_unused, index) => [
            album(`keeper-${index}`, `Album ${index}`, `real-${index}`, 0),
            album(`loser-${index}`, `album ${index}`, `temp-${index}`, 0),
        ]).flat();
        for (let offset = 0; offset < candidates.length; offset += 100) {
            mockPrisma.album.findMany.mockResolvedValueOnce(
                candidates.slice(offset, offset + 100),
            );
        }
        mockPrisma.$transaction.mockResolvedValue({
            merged: [],
            skippedBothReal: 0,
            skippedNoActiveLocalTracks: 0,
            skippedNoDirOverlap: 0,
            skippedNullActiveLocalPath: 0,
            skippedRevalidation: 1,
            skippedTrackLimit: 0,
            skippedUnsafeReferences: 0,
            skippedUserOverrides: 0,
            affectedArtistIds: [],
        });

        const result = await deduplicateScannerAlbums();

        expect(result.groupsFound).toBe(201);
        expect(result.groupsDeferredByCap).toBe(1);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(200);
    });

    it("reports albums remaining after the discovery batch cap", async () => {
        let batch = 0;
        mockPrisma.album.findMany.mockImplementation(async () => {
            const batchNumber = batch;
            batch += 1;
            return Array.from({ length: 100 }, (_unused, index) =>
                album(
                    `album-${batchNumber}-${index}`,
                    `Unique ${batchNumber}-${index}`,
                    `real-${batchNumber}-${index}`,
                    0,
                ),
            );
        });
        mockPrisma.album.count.mockResolvedValueOnce(7);

        const result = await deduplicateScannerAlbums();

        expect(mockPrisma.album.findMany).toHaveBeenCalledTimes(100);
        expect(result.albumsDeferredByBatchCap).toBe(7);
    });
});
