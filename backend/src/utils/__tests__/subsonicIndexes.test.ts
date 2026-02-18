import { buildArtistIndexes } from "../subsonicIndexes";

describe("buildArtistIndexes", () => {
    it("groups artists by first letter and sorts buckets", () => {
        const result = buildArtistIndexes(
            [
                { id: "3", name: "3 Doors Down", albumCount: 1 },
                { id: "2", name: "Blur", albumCount: 2 },
                { id: "1", name: "ABBA", albumCount: 4, coverArtId: "ar-1" },
            ],
            { lastModified: 12345 },
        );

        expect(result.lastModified).toBe(12345);
        expect(result.index.map((bucket) => bucket.name)).toEqual(["A", "B", "#"]);
        expect(result.index[0].artist[0]).toEqual({
            id: "ar-1",
            name: "ABBA",
            albumCount: 4,
            coverArt: "ar-1",
        });
        expect(result.index[2].artist[0].name).toBe("3 Doors Down");
    });

    it("sorts artists alphabetically within each bucket", () => {
        const result = buildArtistIndexes(
            [
                { id: "2", name: "Arcade Fire", albumCount: 1 },
                { id: "1", name: "ABBA", albumCount: 1 },
            ],
            { lastModified: 1 },
        );

        expect(result.index).toHaveLength(1);
        expect(result.index[0].name).toBe("A");
        expect(result.index[0].artist.map((artist) => artist.name)).toEqual([
            "ABBA",
            "Arcade Fire",
        ]);
    });
});
