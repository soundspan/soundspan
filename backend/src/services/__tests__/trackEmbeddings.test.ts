jest.mock("../../utils/db", () => ({
    prisma: {
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
        track: { findMany: jest.fn() },
        trackEmbedding: { deleteMany: jest.fn() },
        embeddingSpace: { findUnique: jest.fn() },
    },
}));

jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

const mockGetActiveSpace = jest.fn();
const mockGetTargetSpaceId = jest.fn();

jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
    getVibeEmbeddingTargetSpaceId: (...args: unknown[]) =>
        mockGetTargetSpaceId(...args),
}));

import { prisma } from "../../utils/db";
import { runAnnQuery } from "../../utils/annQuery";
import * as embeddingUtils from "../../utils/embedding";
import {
    countEmbeddedBrowsableTracks,
    countEmbeddedLocalTracks,
    deleteActiveLocalTrackEmbeddings,
    fetchEmbeddingsByTrackIds,
    fetchTrackEmbedding,
    findLocalTracksNeedingActiveEmbedding,
    findNearestToEmbedding,
    findTracksByTextEmbedding,
    upsertTrackEmbedding,
} from "../trackEmbeddings";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRunAnnQuery = runAnnQuery as jest.Mock;
const parseEmbeddingSpy = jest.spyOn(embeddingUtils, "parseEmbedding");

beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSpace.mockResolvedValue({
        id: "space-active",
        family: "clap-music-audioset",
        checkpointHash: "checkpoint-hash",
        dim: 512,
        preprocessing: {},
    });
    mockGetTargetSpaceId.mockResolvedValue("space-active");
});

describe("upsertTrackEmbedding", () => {
    it("writes a complete finite CLAP vector", async () => {
        (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
        (prisma.embeddingSpace.findUnique as jest.Mock).mockResolvedValue({
            dim: 512,
        });

        await upsertTrackEmbedding(
            "track-1",
            Array(512).fill(0.25),
            "space-target",
        );

        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        const [query, ...values] = (prisma.$executeRaw as jest.Mock).mock
            .calls[0];
        expect(query.join(" ")).toContain("space_id");
        expect(query.join(" ")).not.toContain("model_version");
        expect(values).toContain("space-target");
        expect(query.join(" ")).toContain("ON CONFLICT (track_id, space_id)");
        expect(prisma.embeddingSpace.findUnique).toHaveBeenCalledWith({
            where: { id: "space-target" },
            select: { dim: true },
        });
    });

    it("rejects malformed vectors before writing", async () => {
        (prisma.embeddingSpace.findUnique as jest.Mock).mockResolvedValue({
            dim: 2,
        });
        await expect(
            upsertTrackEmbedding("track-1", [0.25], "space-two-dimensional"),
        ).rejects.toThrow("2 finite values");
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
});

describe("active-space maintenance", () => {
    it("selects local tracks missing an active-space embedding", async () => {
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

        await findLocalTracksNeedingActiveEmbedding(25, "space-target");

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    origin: "LOCAL",
                    removedAt: null,
                    filePath: { not: null },
                    embeddings: {
                        none: { spaceId: "space-target" },
                    },
                }),
                take: 25,
            }),
        );
    });

    it.each(["space-active", "space-migrating"])(
        "uses the target-space absence and shared status gate for %s",
        async (targetSpaceId) => {
            (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

            await findLocalTracksNeedingActiveEmbedding(25, targetSpaceId);

            expect(prisma.track.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        embeddings: {
                            none: { spaceId: targetSpaceId },
                        },
                        OR: [
                            { vibeAnalysisStatus: null },
                            { vibeAnalysisStatus: "pending" },
                            { vibeAnalysisStatus: "completed" },
                        ],
                    }),
                }),
            );
        },
    );

    it("uses the worker-resolved target when the producer omits an override", async () => {
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        mockGetTargetSpaceId.mockResolvedValue("space-worker-target");

        await findLocalTracksNeedingActiveEmbedding(25);

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    embeddings: {
                        none: { spaceId: "space-worker-target" },
                    },
                }),
            }),
        );
    });

    it("deletes only local vectors in the active space", async () => {
        (prisma.trackEmbedding.deleteMany as jest.Mock).mockResolvedValue({
            count: 3,
        });

        await expect(deleteActiveLocalTrackEmbeddings()).resolves.toBe(3);
        expect(prisma.trackEmbedding.deleteMany).toHaveBeenCalledWith({
            where: {
                spaceId: "space-active",
                track: { origin: "LOCAL" },
            },
        });
    });
});

describe("fetchEmbeddingsByTrackIds", () => {
    it("joins visible tracks before returning embeddings", async () => {
        (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

        await fetchEmbeddingsByTrackIds(["track-1"]);

        const query = (prisma.$queryRaw as jest.Mock).mock.calls[0][0];
        expect(query.join(" ")).toContain('JOIN "Track"');
        expect(query.join(" ")).toContain('t."removedAt" IS NULL');
        expect(query.join(" ")).toContain("te.space_id =");
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
        const [query, ...values] = mockQueryRaw.mock.calls[0];
        expect(query.join(" ")).toContain("te.space_id =");
        expect(values).toContain("space-active");
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
        expect(query.strings.join(" ")).toContain("te.space_id =");
        expect(query.values).toContain("space-active");
        expect(query.strings.join(" ")).not.toContain("!= ALL");
    });

    it("preserves the exclusion branch", async () => {
        mockRunAnnQuery.mockResolvedValue([]);

        await findNearestToEmbedding([0.1, 0.2], 5, ["track-2"]);

        const query = mockRunAnnQuery.mock.calls[0][0];
        expect(query.strings.join(" ")).toContain("!= ALL");
        expect(query.values).toContainEqual(["track-2"]);
        expect(query.values).toContain("space-active");
    });
});

describe("findTracksByTextEmbedding", () => {
    it("queries the requested provider space for text search", async () => {
        const rows = [{ id: "track-1", distance: 0.2 }];
        mockRunAnnQuery.mockResolvedValue(rows);

        await expect(
            findTracksByTextEmbedding([0.25, 0.75], 0.8, 60, "space-migrating"),
        ).resolves.toBe(rows);

        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
        const query = mockRunAnnQuery.mock.calls[0][0];
        expect(query.strings.join(" ")).toContain("FROM track_embeddings te");
        expect(query.strings.join(" ")).toContain("te.space_id =");
        expect(query.values).toContain("space-migrating");
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
        expect(query.join(" ")).toContain("te.space_id =");
    });

    it("counts only local embeddings for analysis status", async () => {
        mockQueryRaw.mockResolvedValue([{ count: BigInt(3) }]);

        await expect(countEmbeddedLocalTracks()).resolves.toBe(3);

        const query = mockQueryRaw.mock.calls[0][0];
        expect(query.join(" ")).toContain("t.origin =");
        expect(query.join(" ")).toContain("te.space_id =");
    });

    it("returns zero when a count query has no rows", async () => {
        mockQueryRaw.mockResolvedValue([]);

        await expect(countEmbeddedBrowsableTracks()).resolves.toBe(0);
        await expect(countEmbeddedLocalTracks()).resolves.toBe(0);
    });
});
