jest.mock("../../utils/db", () => ({
    prisma: { $executeRaw: jest.fn(), $queryRaw: jest.fn() },
}));

import { prisma } from "../../utils/db";
import {
    fetchEmbeddingsByTrackIds,
    upsertTrackEmbedding,
} from "../trackEmbeddings";

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
