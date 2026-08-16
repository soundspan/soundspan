jest.mock("../../utils/db", () => ({
    prisma: { $executeRaw: jest.fn(), $queryRaw: jest.fn() },
}));

jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { runAnnQuery } from "../../utils/annQuery";
import * as embeddingUtils from "../../utils/embedding";
import {
    countEmbeddedBrowsableTracks,
    countEmbeddedLocalTracks,
    fetchEmbeddingsByTrackIds,
    fetchTrackEmbedding,
    findNearestToEmbedding,
    findTracksByTextEmbedding,
    upsertTrackEmbedding,
} from "../trackEmbeddings";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRunAnnQuery = runAnnQuery as jest.Mock;
const parseEmbeddingSpy = jest.spyOn(embeddingUtils, "parseEmbedding");

beforeEach(() => {
    jest.clearAllMocks();
});

describe("upsertTrackEmbedding", () => {
    it("writes a complete finite CLAP vector", async () => {
        (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

        await upsertTrackEmbedding("track-1", Array(512).fill(0.25));

        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed vectors before writing", async () => {
        await expect(upsertTrackEmbedding("track-1", [0.25])).rejects.toThrow(
            "512 finite values",
        );
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
});

describe("fetchEmbeddingsByTrackIds", () => {
    it("joins visible tracks before returning embeddings", async () => {
        (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

        await fetchEmbeddingsByTrackIds(["track-1"]);

        const query = (prisma.$queryRaw as jest.Mock).mock.calls[0][0];
        expect(query.join(" ")).toContain('JOIN "Track"');
        expect(query.join(" ")).toContain('t."removedAt" IS NULL');
    });

    it("does not query for an empty track list", async () => {
        await expect(fetchEmbeddingsByTrackIds([])).resolves.toEqual([]);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
});

describe("fetchTrackEmbedding", () => {
    it("parses the returned pgvector text", async () => {
        mockQueryRaw.mockResolvedValue([{ embedding: "[0.25,-0.5,1]" }]);

        await expect(fetchTrackEmbedding("track-1")).resolves.toEqual([
            0.25, -0.5, 1,
        ]);
        expect(parseEmbeddingSpy).toHaveBeenCalledWith("[0.25,-0.5,1]");
    });

    it("returns null when the track has no embedding row", async () => {
        mockQueryRaw.mockResolvedValue([]);

        await expect(fetchTrackEmbedding("track-1")).resolves.toBeNull();
    });
});

describe("findNearestToEmbedding", () => {
    it("routes the unfiltered ANN query through runAnnQuery", async () => {
        const rows = [{ id: "track-1", distance: 0.1 }];
        mockRunAnnQuery.mockResolvedValue(rows);

        await expect(findNearestToEmbedding([0.1, 0.2], 5)).resolves.toBe(rows);

        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
        const query = mockRunAnnQuery.mock.calls[0][0];
        expect(query.strings.join(" ")).toContain("FROM track_embeddings te");
        expect(query.strings.join(" ")).not.toContain("!= ALL");
    });

    it("preserves the exclusion branch", async () => {
        mockRunAnnQuery.mockResolvedValue([]);

        await findNearestToEmbedding([0.1, 0.2], 5, ["track-2"]);

        const query = mockRunAnnQuery.mock.calls[0][0];
        expect(query.strings.join(" ")).toContain("!= ALL");
        expect(query.values).toContainEqual(["track-2"]);
    });
});

describe("findTracksByTextEmbedding", () => {
    it("routes the bounded text-search ANN query through runAnnQuery", async () => {
        const rows = [{ id: "track-1", distance: 0.2 }];
        mockRunAnnQuery.mockResolvedValue(rows);

        await expect(
            findTracksByTextEmbedding([0.25, 0.75], 0.8, 60),
        ).resolves.toBe(rows);

        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
        const query = mockRunAnnQuery.mock.calls[0][0];
        expect(query.strings.join(" ")).toContain("FROM track_embeddings te");
        const values = query.values as unknown[];
        // Pin binding positions so a maxDistance/candidateLimit swap cannot
        // pass: LIMIT binds last, preceded by the ORDER BY vector, preceded
        // by the distance bound.
        expect(values[values.length - 1]).toBe(60);
        expect(values[values.length - 2]).toEqual([0.25, 0.75]);
        expect(values[values.length - 3]).toBe(0.8);
    });
});

describe("embedding counts", () => {
    it("counts browsable embeddings and parses bigint rows", async () => {
        mockQueryRaw.mockResolvedValue([{ count: BigInt(4) }]);

        await expect(countEmbeddedBrowsableTracks()).resolves.toBe(4);

        const query = mockQueryRaw.mock.calls[0][0];
        expect(query.join(" ")).toContain("FROM track_embeddings te");
    });

    it("counts only local embeddings for analysis status", async () => {
        mockQueryRaw.mockResolvedValue([{ count: BigInt(3) }]);

        await expect(countEmbeddedLocalTracks()).resolves.toBe(3);

        const query = mockQueryRaw.mock.calls[0][0];
        expect(query.join(" ")).toContain("t.origin =");
    });

    it("returns zero when a count query has no rows", async () => {
        mockQueryRaw.mockResolvedValue([]);

        await expect(countEmbeddedBrowsableTracks()).resolves.toBe(0);
        await expect(countEmbeddedLocalTracks()).resolves.toBe(0);
    });
});
