jest.mock("../../utils/db", () => ({
    prisma: {
        play: {
            groupBy: jest.fn(),
        },
        likedTrack: {
            findMany: jest.fn(),
        },
        trackRating: {
            findMany: jest.fn(),
        },
    },
}));

import { prisma } from "../../utils/db";
import { loadSongEnrichmentByTrackId } from "../subsonic/songEnrichment";

const GROUP_BY_ID_CHUNK_SIZE = 25_000;

describe("loadSongEnrichmentByTrackId", () => {
    const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
    const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
    const mockTrackRatingFindMany = (
        prisma as unknown as { trackRating: { findMany: jest.Mock } }
    ).trackRating.findMany;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPlayGroupBy.mockResolvedValue([]);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockTrackRatingFindMany.mockResolvedValue([]);
    });

    it("loads play enrichment in bounded groupBy chunks", async () => {
        const ids = Array.from(
            { length: GROUP_BY_ID_CHUNK_SIZE + 1 },
            (_, index) => `track-${index}`,
        );
        const firstPlayedAt = new Date("2026-08-20T12:00:00.000Z");
        const secondPlayedAt = new Date("2026-08-21T12:00:00.000Z");
        mockPlayGroupBy
            .mockResolvedValueOnce([
                {
                    trackId: ids[0],
                    _count: { _all: 2 },
                    _max: { playedAt: firstPlayedAt },
                },
            ])
            .mockResolvedValueOnce([
                {
                    trackId: ids[GROUP_BY_ID_CHUNK_SIZE],
                    _count: { _all: 3 },
                    _max: { playedAt: secondPlayedAt },
                },
            ]);

        const result = await loadSongEnrichmentByTrackId("user-1", ids);

        expect(mockPlayGroupBy).toHaveBeenCalledTimes(2);
        expect(mockPlayGroupBy).toHaveBeenNthCalledWith(1, {
            by: ["trackId"],
            where: {
                userId: "user-1",
                trackId: { in: ids.slice(0, GROUP_BY_ID_CHUNK_SIZE) },
            },
            _count: { _all: true },
            _max: { playedAt: true },
        });
        expect(mockPlayGroupBy).toHaveBeenNthCalledWith(2, {
            by: ["trackId"],
            where: {
                userId: "user-1",
                trackId: { in: ids.slice(GROUP_BY_ID_CHUNK_SIZE) },
            },
            _count: { _all: true },
            _max: { playedAt: true },
        });
        expect(result.get(ids[0])).toEqual({
            playedAt: firstPlayedAt,
            playCount: 2,
        });
        expect(result.get(ids[GROUP_BY_ID_CHUNK_SIZE])).toEqual({
            playedAt: secondPlayedAt,
            playCount: 3,
        });
    });

    it("uses the existing single groupBy call shape for a small id list", async () => {
        const ids = ["track-1", "track-2"];

        await loadSongEnrichmentByTrackId("user-1", ids);

        expect(mockPlayGroupBy).toHaveBeenCalledTimes(1);
        expect(mockPlayGroupBy).toHaveBeenCalledWith({
            by: ["trackId"],
            where: { userId: "user-1", trackId: { in: ids } },
            _count: { _all: true },
            _max: { playedAt: true },
        });
    });
});
