const groupBy = jest.fn();
const findMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { track: { groupBy, findMany } },
}));

import {
    DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT,
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

    it("caps embedded members while preserving exact cluster totals", async () => {
        const memberCount = DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT + 3;
        groupBy
            .mockResolvedValueOnce([
                { audioHash: "large-hash", _count: { _all: memberCount } },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        findMany.mockResolvedValueOnce(
            Array.from({ length: memberCount }, (_, index) => ({
                id: `track-${String(index).padStart(2, "0")}`,
                title: `Track ${index}`,
                filePath: `/music/${index}.mp3`,
                fileSize: index + 1,
                mime: "MPEG 1 Layer 3",
                audioHash: "large-hash",
                recordingMbid: null,
                isrc: null,
                album: { title: "Album", artist: { name: "Artist" } },
            })),
        );

        const catalog = await loadDuplicateClusterCatalog();
        const cluster = catalog.clusters[0];

        expect(cluster.memberCount).toBe(memberCount);
        expect(cluster.totalFileSize).toBe(
            (memberCount * (memberCount + 1)) / 2,
        );
        expect(cluster.members).toHaveLength(
            DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT,
        );
        expect(cluster.members.map((member) => member.id)).toEqual(
            Array.from(
                { length: DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT },
                (_, index) => `track-${String(index).padStart(2, "0")}`,
            ),
        );
    });
});
