import { resolveDiscoveryCatalogAlbum } from "../discoveryCatalogAlbum";

function createTransaction() {
    return {
        album: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        discoveryAlbum: {
            updateMany: jest.fn(),
        },
    };
}

describe("resolveDiscoveryCatalogAlbum", () => {
    it("uses a present catalog link without stale identity fallback", async () => {
        const transaction = createTransaction();
        const linkedAlbum = { id: "linked", artist: {} };
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

    it("persists a successful legacy fallback link", async () => {
        const transaction = createTransaction();
        const fallbackAlbum = { id: "fallback", artist: {} };
        transaction.album.findFirst.mockResolvedValue(fallbackAlbum);

        await expect(
            resolveDiscoveryCatalogAlbum(transaction as never, {
                id: "discovery",
                catalogAlbumId: null,
                rgMbid: "legacy-rg",
                albumTitle: "Legacy Title",
                artistName: "Legacy Artist",
            }),
        ).resolves.toBe(fallbackAlbum);

        expect(transaction.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: "discovery", catalogAlbumId: null },
            data: { catalogAlbumId: "fallback" },
        });
    });
});
