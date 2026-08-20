import {
    DiscoveryCatalogResolutionError,
    DiscoveryLinkDriftError,
    resolveDiscoveryCatalogAlbum,
    retryDiscoveryLinkDrift,
} from "../discoveryCatalogAlbum";

interface LockedRow {
    id: string;
    catalogAlbumId: string | null;
    status: "ACTIVE" | "LIKED";
}

function createTransaction(lockedRows: LockedRow[]) {
    const operations: string[] = [];
    return {
        operations,
        $queryRaw: jest.fn(
            async (query: {
                strings: readonly string[];
            }): Promise<object[]> => {
                const sql = query.strings.join("");
                if (sql.includes('FROM "Album"')) {
                    operations.push("lock-album");
                    return [{ artistId: "artist" }];
                }
                if (sql.includes('FROM "Artist"')) {
                    operations.push("lock-artist");
                    return [{ id: "artist" }];
                }
                operations.push("lock-discovery");
                return lockedRows;
            },
        ),
        album: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        discoveryAlbum: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
    };
}

describe("resolveDiscoveryCatalogAlbum", () => {
    it("locks the linked album before the discovery row and uses the authoritative link", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: "linked", status: "ACTIVE" },
        ]);
        const preLockAlbum = { id: "linked", rgMbid: "stale", artist: {} };
        const linkedAlbum = { id: "linked", rgMbid: "current", artist: {} };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: "linked",
        });
        transaction.album.findUnique
            .mockResolvedValueOnce(preLockAlbum)
            .mockResolvedValueOnce(linkedAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: "linked",
                rgMbid: "stale-rg",
                albumTitle: "Stale Title",
                artistName: "Stale Artist",
            }),
        ).resolves.toEqual({
            catalogAlbum: linkedAlbum,
            discoveryRows: [
                {
                    id: "discovery",
                    catalogAlbumId: "linked",
                    status: "ACTIVE",
                },
            ],
        });

        expect(transaction.operations).toEqual([
            "lock-album",
            "lock-discovery",
        ]);
        expect(transaction.album.findFirst).not.toHaveBeenCalled();
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("prefers an exact release-group MBID and persists its fallback link after locking", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: null, status: "ACTIVE" },
        ]);
        const exactAlbum = { id: "exact", rgMbid: "legacy-rg", artist: {} };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst.mockResolvedValueOnce(exactAlbum);
        transaction.album.findUnique.mockResolvedValueOnce(exactAlbum);
        transaction.discoveryAlbum.updateMany.mockResolvedValue({ count: 1 });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: null,
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).resolves.toEqual(
            expect.objectContaining({ catalogAlbum: exactAlbum }),
        );

        expect(transaction.album.findFirst).toHaveBeenCalledTimes(1);
        expect(transaction.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: "discovery", catalogAlbumId: null },
            data: { catalogAlbumId: "exact" },
        });
        expect(transaction.operations).toEqual([
            "lock-album",
            "lock-discovery",
        ]);
    });

    it("falls back to title and artist only when the MBID has no match", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: null, status: "ACTIVE" },
        ]);
        const titleAlbum = {
            id: "title-match",
            artistId: "artist",
            rgMbid: "other-rg",
            title: "legacy title",
            artist: { name: "LEGACY ARTIST" },
        };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(titleAlbum)
            .mockResolvedValueOnce(null);
        transaction.album.findUnique.mockResolvedValueOnce(titleAlbum);
        transaction.discoveryAlbum.updateMany.mockResolvedValue({ count: 1 });

        await resolveDiscoveryCatalogAlbum(transaction as never, {
            id: "discovery",
            rgMbid: "missing-rg",
            albumTitle: "Legacy Title",
            artistName: "Legacy Artist",
        });

        expect(transaction.album.findFirst).toHaveBeenNthCalledWith(2, {
            where: {
                title: { equals: "Legacy Title", mode: "insensitive" },
                artist: {
                    name: {
                        equals: "Legacy Artist",
                        mode: "insensitive",
                    },
                },
            },
            include: { artist: true },
        });
        expect(transaction.album.findFirst).toHaveBeenNthCalledWith(3, {
            where: { rgMbid: "missing-rg" },
            include: { artist: true },
        });
        expect(transaction.operations).toEqual([
            "lock-album",
            "lock-artist",
            "lock-discovery",
        ]);
    });

    it("retries when an exact MBID appears while a title and artist fallback waits for its lock", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: null, status: "ACTIVE" },
        ]);
        const titleAlbum = {
            id: "title-match",
            artistId: "artist",
            rgMbid: "other-rg",
            title: "Legacy Title",
            artist: { name: "Legacy Artist" },
        };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(titleAlbum)
            .mockResolvedValueOnce({
                id: "late-exact",
                artistId: "other-artist",
                rgMbid: "missing-rg",
                title: "Other Title",
                artist: { name: "Other Artist" },
            });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                rgMbid: "missing-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).rejects.toBeInstanceOf(DiscoveryLinkDriftError);

        expect(transaction.operations).toEqual(["lock-album", "lock-artist"]);
        expect(transaction.album.findUnique).not.toHaveBeenCalled();
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("retries when an exact MBID fallback no longer matches after its album lock", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: null, status: "ACTIVE" },
        ]);
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst.mockResolvedValueOnce({
            id: "exact",
            rgMbid: "legacy-rg",
            artist: {},
        });
        transaction.album.findUnique.mockResolvedValueOnce({
            id: "exact",
            rgMbid: "changed-rg",
            artist: {},
        });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).rejects.toBeInstanceOf(DiscoveryLinkDriftError);
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("retries when a title and artist fallback no longer matches after its album lock", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: null, status: "ACTIVE" },
        ]);
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "title-match",
                artistId: "artist",
                rgMbid: "other-rg",
                title: "Legacy Title",
                artist: { name: "Legacy Artist" },
            })
            .mockResolvedValueOnce(null);
        transaction.album.findUnique.mockResolvedValueOnce({
            id: "title-match",
            rgMbid: "other-rg",
            title: "Changed Title",
            artist: { name: "Legacy Artist" },
        });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                rgMbid: "missing-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).rejects.toBeInstanceOf(DiscoveryLinkDriftError);
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("aborts the attempt with a retryable error when the catalog link changes before the discovery row lock", async () => {
        const transaction = createTransaction([
            {
                id: "discovery",
                catalogAlbumId: "authoritative",
                status: "ACTIVE",
            },
        ]);
        const fallbackAlbum = {
            id: "fallback",
            rgMbid: "legacy-rg",
            artist: {},
        };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: null,
        });
        transaction.album.findFirst.mockResolvedValueOnce(fallbackAlbum);
        transaction.album.findUnique.mockResolvedValueOnce(fallbackAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).rejects.toBeInstanceOf(DiscoveryLinkDriftError);
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("retries link drift with a fresh attempt", async () => {
        const operation = jest
            .fn<Promise<string>, []>()
            .mockRejectedValueOnce(
                new DiscoveryLinkDriftError(
                    "Discovery catalog link changed during resolution",
                ),
            )
            .mockResolvedValueOnce("authoritative");

        await expect(retryDiscoveryLinkDrift(operation)).resolves.toBe(
            "authoritative",
        );
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it.each([
        {
            name: "Prisma transaction conflict",
            failure: { code: "P2034" },
        },
        {
            name: "PostgreSQL deadlock abort",
            failure: {
                code: "P2010",
                meta: {
                    driverAdapterError: { cause: { code: "40P01" } },
                },
            },
        },
    ])("retries a $name with a fresh attempt", async ({ failure }) => {
        const operation = jest
            .fn<Promise<string>, []>()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce("completed");

        await expect(retryDiscoveryLinkDrift(operation)).resolves.toBe(
            "completed",
        );
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("surfaces a deadlock abort after the bounded attempt cap", async () => {
        const deadlock = { code: "40P01" };
        const operation = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(deadlock);

        await expect(retryDiscoveryLinkDrift(operation)).rejects.toBe(deadlock);
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it("surfaces the existing error after three drift attempts", async () => {
        const drift = new DiscoveryLinkDriftError(
            "Discovery catalog link changed during resolution",
        );
        const operation = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(drift);

        await expect(retryDiscoveryLinkDrift(operation)).rejects.toBe(drift);
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it("does not retry other resolution errors", async () => {
        const failure = new DiscoveryCatalogResolutionError(
            "Discovery status changed during resolution",
        );
        const operation = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(failure);

        await expect(retryDiscoveryLinkDrift(operation)).rejects.toBe(failure);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("aborts when the expected status changes before the discovery row lock", async () => {
        const transaction = createTransaction([
            { id: "discovery", catalogAlbumId: "catalog", status: "LIKED" },
        ]);
        const catalogAlbum = { id: "catalog", artist: {} };
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: "catalog",
        });
        transaction.album.findUnique.mockResolvedValue(catalogAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(
                transaction as never,
                {
                    id: "discovery",
                    rgMbid: "catalog-rg",
                    albumTitle: "Catalog",
                    artistName: "Artist",
                },
                { expectedStatuses: ["ACTIVE"] },
            ),
        ).rejects.toBeInstanceOf(DiscoveryCatalogResolutionError);
    });
});
