import { resolveDiscoveryCatalogAlbum } from "../discoveryCatalogAlbum";

function createTransaction() {
    return {
        $queryRaw: jest.fn(),
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
    it("uses a present catalog link without stale identity fallback", async () => {
        const transaction = createTransaction();
        const linkedAlbum = { id: "linked", artist: {} };
        transaction.$queryRaw.mockResolvedValue([{ catalogAlbumId: "linked" }]);
        transaction.album.findUnique.mockResolvedValue(linkedAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: "linked",
                rgMbid: "stale-rg",
                albumTitle: "Stale Title",
                artistName: "Stale Artist",
            }),
        ).resolves.toBe(linkedAlbum);

        expect(transaction.album.findUnique).toHaveBeenCalledWith({
            where: { id: "linked" },
            include: { artist: true },
        });
        expect(transaction.album.findFirst).not.toHaveBeenCalled();
        expect(transaction.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it("prefers an exact release-group MBID over a title and artist decoy", async () => {
        const transaction = createTransaction();
        const exactAlbum = { id: "exact", artist: {} };
        transaction.$queryRaw.mockResolvedValue([{ catalogAlbumId: null }]);
        transaction.album.findFirst.mockResolvedValueOnce(exactAlbum);
        transaction.discoveryAlbum.updateMany.mockResolvedValue({ count: 1 });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: null,
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).resolves.toBe(exactAlbum);

        expect(transaction.album.findFirst).toHaveBeenCalledTimes(1);
        expect(transaction.album.findFirst).toHaveBeenCalledWith({
            where: { rgMbid: "legacy-rg" },
            include: { artist: true },
        });
        expect(transaction.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: "discovery", catalogAlbumId: null },
            data: { catalogAlbumId: "exact" },
        });
    });

    it("falls back to title and artist only when the MBID has no match", async () => {
        const transaction = createTransaction();
        const titleAlbum = { id: "title-match", artist: {} };
        transaction.$queryRaw.mockResolvedValue([{ catalogAlbumId: null }]);
        transaction.album.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(titleAlbum);
        transaction.discoveryAlbum.updateMany.mockResolvedValue({ count: 1 });

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: null,
                rgMbid: "missing-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).resolves.toBe(titleAlbum);

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
    });

    it("returns the authoritative linked album after losing the fallback CAS", async () => {
        const transaction = createTransaction();
        const fallbackAlbum = { id: "fallback", artist: {} };
        const authoritativeAlbum = { id: "authoritative", artist: {} };
        transaction.$queryRaw.mockResolvedValue([{ catalogAlbumId: null }]);
        transaction.album.findFirst.mockResolvedValueOnce(fallbackAlbum);
        transaction.discoveryAlbum.updateMany.mockResolvedValue({ count: 0 });
        transaction.discoveryAlbum.findUnique.mockResolvedValue({
            catalogAlbumId: "authoritative",
        });
        transaction.album.findUnique.mockResolvedValue(authoritativeAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: null,
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).resolves.toBe(authoritativeAlbum);

        expect(transaction.album.findUnique).toHaveBeenCalledWith({
            where: { id: "authoritative" },
            include: { artist: true },
        });
    });
});
