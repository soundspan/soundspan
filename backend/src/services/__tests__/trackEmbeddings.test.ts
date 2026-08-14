jest.mock("../../utils/db", () => ({
    prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { fetchEmbeddingsByTrackIds } from "../trackEmbeddings";

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
