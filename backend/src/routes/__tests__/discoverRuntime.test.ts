import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        discover: {
            mode: "recommendation",
        },
        music: {
            musicPath: "/music",
        },
    },
}));

const prisma = {
    userDiscoverConfig: {
        upsert: jest.fn(async (args: any) => ({
            userId: args.where.userId,
            playlistSize: args.update.playlistSize ?? args.create.playlistSize,
            maxRetryAttempts:
                args.update.maxRetryAttempts ?? args.create.maxRetryAttempts,
            exclusionMonths:
                args.update.exclusionMonths ?? args.create.exclusionMonths,
            downloadRatio: args.update.downloadRatio ?? args.create.downloadRatio,
            enabled: args.update.enabled ?? args.create.enabled,
        })),
        findUnique: jest.fn(async () => ({
            userId: "user-1",
            playlistSize: 10,
            maxRetryAttempts: 3,
            exclusionMonths: 6,
            downloadRatio: 1.3,
            enabled: true,
        })),
        create: jest.fn(async (args: any) => args.data),
    },
    discoverExclusion: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        findFirst: jest.fn(async () => null),
        delete: jest.fn(async () => undefined),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getTopChartArtists: jest.fn(async () => []),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({})),
}));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {},
}));

const discoverQueue = {
    getJobs: jest.fn(async () => []),
    getJob: jest.fn(async () => null),
    add: jest.fn(async () => ({ id: "job-1" })),
};

const scanQueue = {
    add: jest.fn(async () => undefined),
};

jest.mock("../../workers/queues", () => ({
    discoverQueue,
    scanQueue,
}));

jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: jest.fn(async () => ({ clearedCount: 0 })),
    },
}));

import router from "../discover";
import { prisma as dbPrisma } from "../../utils/db";
import { lastFmService } from "../../services/lastfm";
import { discoveryRecommendationsService } from "../../services/discovery";

const mockUserDiscoverConfigUpsert = dbPrisma.userDiscoverConfig.upsert as jest.Mock;
const mockUserDiscoverConfigFindUnique =
    dbPrisma.userDiscoverConfig.findUnique as jest.Mock;
const mockUserDiscoverConfigCreate =
    dbPrisma.userDiscoverConfig.create as jest.Mock;
const mockDiscoverExclusionFindMany = dbPrisma.discoverExclusion
    .findMany as jest.Mock;
const mockDiscoverExclusionDeleteMany = dbPrisma.discoverExclusion
    .deleteMany as jest.Mock;
const mockDiscoverExclusionFindFirst = dbPrisma.discoverExclusion
    .findFirst as jest.Mock;
const mockDiscoverExclusionDelete = dbPrisma.discoverExclusion.delete as jest.Mock;
const mockGetTopChartArtists = lastFmService.getTopChartArtists as jest.Mock;
const mockClearCurrentPlaylist =
    discoveryRecommendationsService.clearCurrentPlaylist as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "delete" | "patch"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

describe("discover route runtime behavior", () => {
    const configPatchHandler = getRouteHandler("/config", "patch");
    const configGetHandler = getRouteHandler("/config", "get");
    const popularArtistsHandler = getRouteHandler("/popular-artists", "get");
    const clearHandler = getRouteHandler("/clear", "delete");
    const batchStatusHandler = getRouteHandler("/batch-status", "get");
    const generateHandler = getRouteHandler("/generate", "post");
    const generateStatusHandler = getRouteHandler(
        "/generate/status/:jobId",
        "get"
    );
    const likeHandler = getRouteHandler("/like", "post");
    const unlikeHandler = getRouteHandler("/unlike", "delete");
    const exclusionsGetHandler = getRouteHandler("/exclusions", "get");
    const exclusionsDeleteHandler = getRouteHandler("/exclusions", "delete");
    const exclusionsDeleteByIdHandler = getRouteHandler(
        "/exclusions/:id",
        "delete"
    );
    const cleanupLidarrHandler = getRouteHandler("/cleanup-lidarr", "post");
    const fixTaggingHandler = getRouteHandler("/fix-tagging", "post");

    beforeEach(() => {
        jest.clearAllMocks();

        mockUserDiscoverConfigUpsert.mockResolvedValue({
            userId: "user-1",
            playlistSize: 10,
            maxRetryAttempts: 3,
            exclusionMonths: 6,
            downloadRatio: 1.3,
            enabled: true,
        });
        mockUserDiscoverConfigFindUnique.mockResolvedValue({
            userId: "user-1",
            playlistSize: 10,
            maxRetryAttempts: 3,
            exclusionMonths: 6,
            downloadRatio: 1.3,
            enabled: true,
        });
        mockUserDiscoverConfigCreate.mockResolvedValue({
            userId: "user-1",
            playlistSize: 10,
            maxRetryAttempts: 3,
            exclusionMonths: 6,
            downloadRatio: 1.3,
            enabled: true,
        });
        mockGetTopChartArtists.mockResolvedValue([]);
        mockClearCurrentPlaylist.mockResolvedValue({ clearedCount: 0 });
        mockDiscoverExclusionFindMany.mockResolvedValue([]);
        mockDiscoverExclusionDeleteMany.mockResolvedValue({ count: 0 });
        mockDiscoverExclusionFindFirst.mockResolvedValue(null);
        mockDiscoverExclusionDelete.mockResolvedValue(undefined);
    });

    it("validates playlist size bounds for discover config updates", async () => {
        const req = {
            user: { id: "user-1" },
            body: { playlistSize: 7 },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
        });
        expect(mockUserDiscoverConfigUpsert).not.toHaveBeenCalled();
    });

    it("updates config and parses numeric fields into persisted values", async () => {
        mockUserDiscoverConfigUpsert.mockResolvedValueOnce({
            userId: "user-1",
            playlistSize: 20,
            maxRetryAttempts: 4,
            exclusionMonths: 2,
            downloadRatio: 1.9,
            enabled: false,
        });

        const req = {
            user: { id: "user-1" },
            body: {
                playlistSize: "20",
                maxRetryAttempts: "4",
                exclusionMonths: "2",
                downloadRatio: "1.9",
                enabled: false,
            },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(mockUserDiscoverConfigUpsert).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            create: {
                userId: "user-1",
                playlistSize: "20",
                maxRetryAttempts: "4",
                exclusionMonths: "2",
                downloadRatio: "1.9",
                enabled: false,
            },
            update: {
                playlistSize: 20,
                maxRetryAttempts: 4,
                exclusionMonths: 2,
                downloadRatio: 1.9,
                enabled: false,
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playlistSize: 20,
                maxRetryAttempts: 4,
                exclusionMonths: 2,
                downloadRatio: 1.9,
                enabled: false,
            })
        );
    });

    it("returns popular artists from Last.fm on success", async () => {
        mockGetTopChartArtists.mockResolvedValueOnce([
            { name: "Artist One" },
            { name: "Artist Two" },
        ]);

        const req = { query: { limit: "2" } } as any;
        const res = createRes();

        await popularArtistsHandler(req, res);

        expect(mockGetTopChartArtists).toHaveBeenCalledWith(2);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [{ name: "Artist One" }, { name: "Artist Two" }],
        });
    });

    it("falls back to an empty popular artist list when Last.fm fails", async () => {
        mockGetTopChartArtists.mockRejectedValueOnce(new Error("timeout"));

        const req = { query: { limit: "6" } } as any;
        const res = createRes();
        await popularArtistsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ artists: [] });
    });

    it("defaults recommendation batch progress to zero when queue job progress is non-numeric", async () => {
        (discoverQueue.getJobs as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-other",
                data: { userId: "other-user" },
                getState: jest.fn().mockResolvedValue("active"),
                progress: jest.fn().mockReturnValue(77),
            },
            {
                id: "job-user",
                data: { userId: "user-1" },
                getState: jest.fn().mockResolvedValue("active"),
                progress: jest.fn().mockReturnValue("n/a"),
            },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(discoverQueue.getJobs).toHaveBeenCalledWith(
            ["active", "waiting", "delayed"],
            0,
            200
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                active: true,
                status: "generating",
                batchId: "job-user",
                progress: 0,
                completed: 0,
                failed: 0,
                total: 100,
                queueState: "active",
            })
        );
    });

    it("returns inactive batch status when no recommendation job is running", async () => {
        (discoverQueue.getJobs as jest.Mock).mockResolvedValueOnce([]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(discoverQueue.getJobs).toHaveBeenCalledWith(
            ["active", "waiting", "delayed"],
            0,
            200
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            active: false,
            status: null,
            progress: null,
        });
    });

    it("returns a 409 from /generate when a manual discover job is already running", async () => {
        const existingJob = {
            id: "discover:manual:user-1",
            getState: jest.fn().mockResolvedValue("active"),
            remove: jest.fn(),
        };
        (discoverQueue.getJob as jest.Mock).mockResolvedValueOnce(existingJob);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(existingJob.getState).toHaveBeenCalled();
        expect(existingJob.remove).not.toHaveBeenCalled();
        expect(discoverQueue.add).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "Generation already in progress",
            jobId: existingJob.id,
            status: "active",
        });
    });

    it("starts a new recommendation job after removing stale manual jobs", async () => {
        const staleJob = {
            id: "discover:manual:user-1",
            getState: jest.fn().mockResolvedValue("completed"),
            remove: jest.fn(async () => undefined),
        };
        (discoverQueue.getJob as jest.Mock).mockResolvedValueOnce(staleJob);
        (discoverQueue.add as jest.Mock).mockResolvedValueOnce({ id: "job-2" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(staleJob.getState).toHaveBeenCalled();
        expect(staleJob.remove).toHaveBeenCalled();
        expect(discoverQueue.add).toHaveBeenCalledWith(
            "discover-recommendation",
            { userId: "user-1" },
            { jobId: "discover:manual:user-1" }
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Discover Weekly recommendation generation started",
            jobId: "job-2",
        });
    });

    it("returns 404 for missing generation status", async () => {
        (discoverQueue.getJob as jest.Mock).mockResolvedValueOnce(null);

        const req = {
            params: { jobId: "missing-job" },
        } as any;
        const res = createRes();
        await generateStatusHandler(req, res);

        expect(discoverQueue.getJob).toHaveBeenCalledWith("missing-job");
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Job not found" });
    });

    it("returns generation status payload for a known job", async () => {
        (discoverQueue.getJob as jest.Mock).mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("completed"),
            progress: jest.fn().mockReturnValue(75),
            returnvalue: { playlistId: "playlist-1" },
        });

        const req = {
            params: { jobId: "job-1" },
        } as any;
        const res = createRes();
        await generateStatusHandler(req, res);

        expect(discoverQueue.getJob).toHaveBeenCalledWith("job-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            status: "completed",
            progress: 75,
            result: { playlistId: "playlist-1" },
        });
    });

    it("returns 410 for like and unlike in recommendation mode", async () => {
        const req = {
            user: { id: "user-1" },
            body: { albumId: "rg-album-1" },
        } as any;

        const likeRes = createRes();
        await likeHandler(req, likeRes);
        expect(likeRes.statusCode).toBe(410);
        expect(likeRes.body).toEqual({
            error: "Like/unlike is disabled for recommendation-only discovery",
        });

        const unlikeRes = createRes();
        await unlikeHandler(req, unlikeRes);
        expect(unlikeRes.statusCode).toBe(410);
        expect(unlikeRes.body).toEqual({
            error: "Like/unlike is disabled for recommendation-only discovery",
        });
    });

    it("maps exclusion entries with fallback artist/title values", async () => {
        const now = new Date("2026-02-17T11:11:11.000Z");
        const later = new Date("2026-05-17T11:11:11.000Z");
        mockDiscoverExclusionFindMany.mockResolvedValueOnce([
            {
                id: "exc-1",
                albumMbid: "1234567890abcdef",
                artistName: null,
                albumTitle: null,
                lastSuggestedAt: now,
                expiresAt: later,
            },
            {
                id: "exc-2",
                albumMbid: "mbid-2222",
                artistName: "Known Artist",
                albumTitle: "Known Album",
                lastSuggestedAt: now,
                expiresAt: later,
            },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await exclusionsGetHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            exclusions: [
                {
                    id: "exc-1",
                    albumMbid: "1234567890abcdef",
                    artistName: "Unknown Artist",
                    albumTitle: "12345678...",
                    lastSuggestedAt: now,
                    expiresAt: later,
                },
                {
                    id: "exc-2",
                    albumMbid: "mbid-2222",
                    artistName: "Known Artist",
                    albumTitle: "Known Album",
                    lastSuggestedAt: now,
                    expiresAt: later,
                },
            ],
            count: 2,
        });
    });

    it("returns 500 when exclusions lookup fails", async () => {
        mockDiscoverExclusionFindMany.mockRejectedValueOnce(new Error("db failed"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await exclusionsGetHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get exclusions",
            details: "db failed",
        });
    });

    it("clears all exclusions for current user", async () => {
        mockDiscoverExclusionDeleteMany.mockResolvedValueOnce({ count: 3 });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await exclusionsDeleteHandler(req, res);

        expect(mockDiscoverExclusionDeleteMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Cleared 3 exclusions",
            clearedCount: 3,
        });
    });

    it("removes a specific exclusion owned by the current user", async () => {
        mockDiscoverExclusionFindFirst.mockResolvedValueOnce({
            id: "exc-1",
            userId: "user-1",
        });

        const req = { user: { id: "user-1" }, params: { id: "exc-1" } } as any;
        const res = createRes();
        await exclusionsDeleteByIdHandler(req, res);

        expect(mockDiscoverExclusionDelete).toHaveBeenCalledWith({
            where: { id: "exc-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Exclusion removed",
        });
    });

    it("returns 404 when removing an exclusion that does not belong to the user", async () => {
        mockDiscoverExclusionFindFirst.mockResolvedValueOnce(null);

        const req = {
            user: { id: "user-1" },
            params: { id: "exc-missing" },
        } as any;
        const res = createRes();
        await exclusionsDeleteByIdHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Exclusion not found" });
        expect(mockDiscoverExclusionDelete).not.toHaveBeenCalled();
    });

    it("returns 500 when exclusion deletion throws", async () => {
        mockDiscoverExclusionFindFirst.mockResolvedValueOnce({
            id: "exc-2",
            userId: "user-1",
        });
        mockDiscoverExclusionDelete.mockRejectedValueOnce(
            new Error("delete failed")
        );

        const req = { user: { id: "user-1" }, params: { id: "exc-2" } } as any;
        const res = createRes();
        await exclusionsDeleteByIdHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to remove exclusion" });
    });

    it("clears recommendation playlist in recommendation mode", async () => {
        mockClearCurrentPlaylist.mockResolvedValueOnce({ clearedCount: 9 });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(mockClearCurrentPlaylist).toHaveBeenCalledWith("user-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Discovery recommendations cleared",
            likedMoved: 0,
            activeDeleted: 9,
            clearedCount: 9,
        });
    });

    it("returns 500 when recommendation clear fails", async () => {
        mockClearCurrentPlaylist.mockRejectedValueOnce(new Error("clear boom"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to clear discovery playlist",
            details: "clear boom",
        });
    });

    it("returns a 500 error when discovery config lookup fails", async () => {
        mockUserDiscoverConfigFindUnique.mockRejectedValueOnce(
            new Error("lookup fail")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await configGetHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get configuration",
        });
    });

    it("returns a 400 for invalid retry attempts", async () => {
        const req = {
            user: { id: "user-1" },
            body: { maxRetryAttempts: "0" },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid retry attempts. Must be between 1-10.",
        });
        expect(mockUserDiscoverConfigUpsert).not.toHaveBeenCalled();
    });

    it("returns a 400 for invalid exclusion months", async () => {
        const req = {
            user: { id: "user-1" },
            body: { exclusionMonths: "13" },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid exclusion months. Must be between 0-12.",
        });
        expect(mockUserDiscoverConfigUpsert).not.toHaveBeenCalled();
    });

    it("returns a 400 for invalid download ratio", async () => {
        const req = {
            user: { id: "user-1" },
            body: { downloadRatio: "0.5" },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid download ratio. Must be between 1.0-2.0.",
        });
        expect(mockUserDiscoverConfigUpsert).not.toHaveBeenCalled();
    });

    it("returns a 500 error when discover config update fails", async () => {
        mockUserDiscoverConfigUpsert.mockRejectedValueOnce(
            new Error("update fail")
        );

        const req = {
            user: { id: "user-1" },
            body: { playlistSize: "10" },
        } as any;
        const res = createRes();

        await configPatchHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update configuration" });
    });

    it("returns 410 for legacy-only maintenance routes in recommendation mode", async () => {
        const req = { user: { id: "user-1" } } as any;

        const cleanupRes = createRes();
        await cleanupLidarrHandler(req, cleanupRes);
        expect(cleanupRes.statusCode).toBe(410);
        expect(cleanupRes.body).toEqual({
            error: "Lidarr cleanup is only available in legacy discovery mode",
        });

        const fixTaggingRes = createRes();
        await fixTaggingHandler(req, fixTaggingRes);
        expect(fixTaggingRes.statusCode).toBe(410);
        expect(fixTaggingRes.body).toEqual({
            error: "Tagging repair is only available in legacy discovery mode",
        });
    });
});
