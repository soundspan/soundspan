const groupBy = jest.fn();
const findMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { track: { groupBy, findMany } },
}));

import {
    listDuplicateClusters,
    loadDuplicateClusterCatalog,
} from "../duplicateClusters";

describe("library health duplicate clusters", () => {
    beforeEach(() => jest.clearAllMocks());

    it("claims tracks at the highest durable identity tier", async () => {
        groupBy
            .mockResolvedValueOnce([{ audioHash: "hash", _count: { _all: 2 } }])
            .mockResolvedValueOnce([
                { recordingMbid: "mbid", _count: { _all: 3 } },
            ])
            .mockResolvedValueOnce([{ isrc: "isrc", _count: { _all: 3 } }]);
        const album = (title: string) => ({
            title,
            artist: { name: "Artist" },
        });
        findMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Song",
                filePath: "/a",
                fileSize: 1,
                mime: "audio/mpeg",
                audioHash: "hash",
                recordingMbid: "mbid",
                isrc: "isrc",
                album: album("A"),
            },
            {
                id: "t2",
                title: "Song",
                filePath: "/b",
                fileSize: 1,
                mime: "audio/mpeg",
                audioHash: "hash",
                recordingMbid: "mbid",
                isrc: "isrc",
                album: album("B"),
            },
            {
                id: "t3",
                title: "Song",
                filePath: "/c",
                fileSize: 1,
                mime: "audio/mpeg",
                audioHash: null,
                recordingMbid: "mbid",
                isrc: "isrc",
                album: album("C"),
            },
        ]);

        const catalog = await loadDuplicateClusterCatalog();

        expect(catalog.clusters).toHaveLength(1);
        expect(catalog.clusters[0].tier).toBe("audioHash");
        expect(catalog.clusters[0].members.map((row) => row.id)).toEqual([
            "t1",
            "t2",
        ]);
        expect(
            listDuplicateClusters(catalog, { limit: 75, offset: -1 }),
        ).toEqual(expect.objectContaining({ limit: 50, offset: 0, total: 1 }));
    });
});
