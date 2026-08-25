const NOW = new Date("2026-08-25T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Candidate {
    id: string;
    rgMbid: string;
    catalogTouchedAt: Date;
    tracks: Array<{ id: string }>;
}

interface GuardedReferences {
    downloads?: string[];
    requests?: string[];
    likedTracks?: string[];
    dislikedTracks?: string[];
    ratedTracks?: string[];
    playlistTracks?: string[];
}

function candidate(index: number, ageDays = 181): Candidate {
    return {
        id: `album-${String(index).padStart(3, "0")}`,
        rgMbid: `rg-${String(index).padStart(3, "0")}`,
        catalogTouchedAt: new Date(NOW.getTime() - ageDays * DAY_MS),
        tracks: [{ id: `track-${String(index).padStart(3, "0")}` }],
    };
}

function loadProcessor(
    candidates: Candidate[],
    references: GuardedReferences = {},
    enabled = true,
) {
    const deletedIds = new Set<string>();
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);

    const prisma = {
        album: {
            findMany: jest.fn(async (args: any) =>
                candidates
                    .filter(
                        (album) =>
                            !deletedIds.has(album.id) &&
                            album.catalogTouchedAt <
                                args.where.catalogTouchedAt.lt,
                    )
                    .sort(
                        (left, right) =>
                            left.catalogTouchedAt.getTime() -
                                right.catalogTouchedAt.getTime() ||
                            left.id.localeCompare(right.id),
                    )
                    .slice(0, args.take),
            ),
            deleteMany: jest.fn(async (args: any) => {
                for (const id of args.where.id.in) deletedIds.add(id);
                return { count: args.where.id.in.length };
            }),
            count: jest.fn(
                async () =>
                    candidates.filter((album) => !deletedIds.has(album.id))
                        .length,
            ),
        },
        downloadJob: {
            findMany: jest.fn(async () =>
                (references.downloads ?? []).map((targetMbid) => ({
                    targetMbid,
                })),
            ),
        },
        musicRequest: {
            findMany: jest.fn(async () =>
                (references.requests ?? []).map((rgMbid) => ({ rgMbid })),
            ),
        },
        likedTrack: {
            findMany: jest.fn(async () =>
                (references.likedTracks ?? []).map((trackId) => ({ trackId })),
            ),
        },
        dislikedEntity: {
            findMany: jest.fn(async () =>
                (references.dislikedTracks ?? []).map((entityId) => ({
                    entityId,
                })),
            ),
        },
        trackRating: {
            findMany: jest.fn(async () =>
                (references.ratedTracks ?? []).map((trackId) => ({ trackId })),
            ),
        },
        playlistItem: {
            findMany: jest.fn(async () =>
                (references.playlistTracks ?? []).map((trackId) => ({
                    trackId,
                })),
            ),
        },
    };
    const recordCatalogReaped = jest.fn();
    const setCatalogAlbumCount = jest.fn();

    jest.resetModules();
    jest.doMock("../../../utils/db", () => ({ prisma }));
    jest.doMock("../../../utils/logger", () => ({ logger }));
    jest.doMock("../../../config", () => ({
        config: {
            catalogPersistence: { enabled, retentionDays: 180 },
        },
    }));
    jest.doMock("../../../metrics", () => ({
        recordCatalogReaped,
        setCatalogAlbumCount,
    }));

    let processCatalogRetention: () => Promise<any>;
    jest.isolateModules(() => {
        ({ processCatalogRetention } = require("../catalogRetentionProcessor"));
    });
    return {
        logger,
        prisma,
        processCatalogRetention: processCatalogRetention!,
        recordCatalogReaped,
        setCatalogAlbumCount,
    };
}

describe("catalog retention processor", () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        jest.resetModules();
    });

    it("deletes only catalog albums older than the retention cutoff", async () => {
        const oldAlbum = candidate(1, 181);
        const freshAlbum = candidate(2, 179);
        const loaded = loadProcessor([oldAlbum, freshAlbum]);

        const result = await loaded.processCatalogRetention();

        expect(loaded.prisma.album.findMany).toHaveBeenCalledWith({
            where: {
                location: "CATALOG",
                catalogTouchedAt: {
                    lt: new Date(NOW.getTime() - 180 * DAY_MS),
                },
            },
            orderBy: [{ catalogTouchedAt: "asc" }, { id: "asc" }],
            take: 50,
            select: {
                id: true,
                rgMbid: true,
                tracks: { select: { id: true } },
            },
        });
        expect(loaded.prisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: [oldAlbum.id] },
                location: "CATALOG",
                catalogTouchedAt: {
                    lt: new Date(NOW.getTime() - 180 * DAY_MS),
                },
            },
        });
        expect(result).toMatchObject({ scanned: 1, protected: 0, reaped: 1 });
    });

    it.each([
        ["download job", { downloads: ["rg-001"] }],
        ["music request", { requests: ["rg-001"] }],
        ["liked-track preference", { likedTracks: ["track-001"] }],
        ["disliked-track preference", { dislikedTracks: ["track-001"] }],
        ["track rating", { ratedTracks: ["track-001"] }],
        ["playlist item", { playlistTracks: ["track-001"] }],
    ])("retains an expired album referenced by a %s", async (_label, refs) => {
        const loaded = loadProcessor([candidate(1)], refs);

        const result = await loaded.processCatalogRetention();

        expect(loaded.prisma.album.deleteMany).not.toHaveBeenCalled();
        expect(result).toMatchObject({ scanned: 1, protected: 1, reaped: 0 });
    });

    it("guards active or recently updated download jobs by target MBID", async () => {
        const loaded = loadProcessor([candidate(1)]);

        await loaded.processCatalogRetention();

        expect(loaded.prisma.downloadJob.findMany).toHaveBeenCalledWith({
            where: {
                targetMbid: { in: ["rg-001"] },
                OR: [
                    { status: { in: ["pending", "processing"] } },
                    {
                        updatedAt: {
                            gte: new Date(NOW.getTime() - 30 * DAY_MS),
                        },
                    },
                ],
            },
            select: { targetMbid: true },
        });
    });

    it("queries each reference table through its persisted key shape", async () => {
        const loaded = loadProcessor([candidate(1)]);

        await loaded.processCatalogRetention();

        expect(loaded.prisma.musicRequest.findMany).toHaveBeenCalledWith({
            where: { rgMbid: { in: ["rg-001"] } },
            select: { rgMbid: true },
        });
        expect(loaded.prisma.likedTrack.findMany).toHaveBeenCalledWith({
            where: { trackId: { in: ["track-001"] } },
            select: { trackId: true },
        });
        expect(loaded.prisma.dislikedEntity.findMany).toHaveBeenCalledWith({
            where: {
                entityType: "track",
                entityId: { in: ["track-001"] },
            },
            select: { entityId: true },
        });
        expect(loaded.prisma.trackRating.findMany).toHaveBeenCalledWith({
            where: { trackId: { in: ["track-001"] } },
            select: { trackId: true },
        });
        expect(loaded.prisma.playlistItem.findMany).toHaveBeenCalledWith({
            where: { trackId: { in: ["track-001"] } },
            select: { trackId: true },
        });
    });

    it("bounds one oldest-first run to 50 candidates", async () => {
        const loaded = loadProcessor(
            Array.from({ length: 60 }, (_, index) => candidate(index + 1)),
        );

        const result = await loaded.processCatalogRetention();

        expect(loaded.prisma.album.findMany.mock.calls[0][0].take).toBe(50);
        expect(
            loaded.prisma.album.deleteMany.mock.calls[0][0].where.id.in,
        ).toHaveLength(50);
        expect(result.reaped).toBe(50);
    });

    it("skips all database and metric work when persistence is disabled", async () => {
        const loaded = loadProcessor([candidate(1)], {}, false);

        const result = await loaded.processCatalogRetention();

        expect(loaded.prisma.album.findMany).not.toHaveBeenCalled();
        expect(loaded.prisma.album.count).not.toHaveBeenCalled();
        expect(loaded.recordCatalogReaped).not.toHaveBeenCalled();
        expect(loaded.setCatalogAlbumCount).not.toHaveBeenCalled();
        expect(result).toEqual({
            skipped: true,
            scanned: 0,
            protected: 0,
            reaped: 0,
            remaining: 0,
        });
    });

    it("records reaped rows, refreshes the gauge, and logs one summary", async () => {
        const loaded = loadProcessor([candidate(1), candidate(2)]);

        const result = await loaded.processCatalogRetention();

        expect(loaded.recordCatalogReaped).toHaveBeenCalledWith(2);
        expect(loaded.setCatalogAlbumCount).toHaveBeenCalledWith(0);
        expect(loaded.logger.info).toHaveBeenCalledTimes(1);
        expect(loaded.logger.info).toHaveBeenCalledWith(
            "Catalog retention sweep complete",
            result,
        );
    });
});
