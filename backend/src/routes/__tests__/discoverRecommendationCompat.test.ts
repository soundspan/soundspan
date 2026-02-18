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

jest.mock("../../utils/db", () => ({
    prisma: {},
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getTopChartArtists: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {},
}));

jest.mock("../../workers/queues", () => ({
    discoverQueue: {
        getJobs: jest.fn(),
        add: jest.fn(),
        getJob: jest.fn(),
    },
    scanQueue: {
        add: jest.fn(),
    },
}));

jest.mock("../../services/discovery", () => ({
    discoveryRecommendationsService: {
        getCurrentPlaylist: jest.fn(),
        clearCurrentPlaylist: jest.fn(),
    },
}));

import router from "../discover";
import { discoverQueue } from "../../workers/queues";
import { discoveryRecommendationsService } from "../../services/discovery";

const mockDiscoverQueueGetJobs = discoverQueue.getJobs as jest.Mock;
const mockDiscoverQueueAdd = discoverQueue.add as jest.Mock;
const mockDiscoverQueueGetJob = discoverQueue.getJob as jest.Mock;
const mockGetCurrentPlaylist =
    discoveryRecommendationsService.getCurrentPlaylist as jest.Mock;
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

describe("discover recommendation-mode compatibility", () => {
    const batchStatusHandler = getRouteHandler("/batch-status", "get");
    const generateHandler = getRouteHandler("/generate", "post");
    const currentHandler = getRouteHandler("/current", "get");
    const clearHandler = getRouteHandler("/clear", "delete");
    const likeHandler = getRouteHandler("/like", "post");
    const unlikeHandler = getRouteHandler("/unlike", "delete");
    const cleanupLidarrHandler = getRouteHandler("/cleanup-lidarr", "post");
    const fixTaggingHandler = getRouteHandler("/fix-tagging", "post");
    const generateStatusHandler = getRouteHandler("/generate/status/:jobId", "get");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("reports inactive batch status when no discover job exists", async () => {
        mockDiscoverQueueGetJobs.mockResolvedValue([]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await batchStatusHandler(req, res);

        expect(mockDiscoverQueueGetJobs).toHaveBeenCalledWith(
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

    it("maps active discover queue job to generating batch status", async () => {
        const activeJob = {
            id: "job-1",
            data: { userId: "user-1" },
            getState: jest.fn().mockResolvedValue("active"),
            progress: jest.fn().mockReturnValue(42.4),
        };
        mockDiscoverQueueGetJobs.mockResolvedValue([activeJob]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                active: true,
                status: "generating",
                batchId: "job-1",
                progress: 42,
                completed: 42,
                failed: 0,
                total: 100,
                queueState: "active",
            })
        );
    });

    it("returns 500 when batch-status queue inspection fails", async () => {
        mockDiscoverQueueGetJobs.mockRejectedValueOnce(new Error("queue down"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get batch status" });
    });

    it("clamps non-integer queue progress into 0-100 bounds", async () => {
        const activeJob = {
            id: "job-overflow",
            data: { userId: "user-1" },
            getState: jest.fn().mockResolvedValue("active"),
            progress: jest.fn().mockReturnValue(133.7),
        };
        mockDiscoverQueueGetJobs.mockResolvedValue([activeJob]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.progress).toBe(100);
        expect(res.body.completed).toBe(100);
    });

    it("returns 500 when queue job state check throws during batch-status", async () => {
        const activeJob = {
            id: "job-state-fail",
            data: { userId: "user-1" },
            getState: jest.fn().mockRejectedValue(new Error("state failed")),
            progress: jest.fn().mockReturnValue(10),
        };
        mockDiscoverQueueGetJobs.mockResolvedValue([activeJob]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await batchStatusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get batch status" });
    });

    it("returns conflict when recommendation generation is already queued", async () => {
        const waitingJob = {
            id: "job-existing",
            data: { userId: "user-1" },
            getState: jest.fn().mockResolvedValue("waiting"),
        };
        mockDiscoverQueueGetJob.mockResolvedValue(waitingJob);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await generateHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "Generation already in progress",
            jobId: "job-existing",
            status: "waiting",
        });
        expect(mockDiscoverQueueAdd).not.toHaveBeenCalled();
    });

    it("queues recommendation generation job when no active job exists", async () => {
        mockDiscoverQueueGetJob.mockResolvedValue(null);
        mockDiscoverQueueAdd.mockResolvedValue({ id: "job-2" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await generateHandler(req, res);

        expect(mockDiscoverQueueAdd).toHaveBeenCalledWith(
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

    it("removes stale completed manual jobs before queuing a new recommendation run", async () => {
        const staleJob = {
            id: "job-stale",
            data: { userId: "user-1" },
            getState: jest.fn().mockResolvedValue("completed"),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        mockDiscoverQueueGetJob.mockResolvedValueOnce(staleJob);
        mockDiscoverQueueAdd.mockResolvedValueOnce({ id: "job-fresh" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(staleJob.remove).toHaveBeenCalledTimes(1);
        expect(mockDiscoverQueueAdd).toHaveBeenCalledWith(
            "discover-recommendation",
            { userId: "user-1" },
            { jobId: "discover:manual:user-1" }
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Discover Weekly recommendation generation started",
            jobId: "job-fresh",
        });
    });

    it("continues queuing when stale-manual-job remove fails", async () => {
        const staleJob = {
            id: "job-stale-fail",
            data: { userId: "user-1" },
            getState: jest.fn().mockResolvedValue("failed"),
            remove: jest.fn().mockRejectedValue(new Error("remove failed")),
        };
        mockDiscoverQueueGetJob.mockResolvedValueOnce(staleJob);
        mockDiscoverQueueAdd.mockResolvedValueOnce({ id: "job-after-remove-fail" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(staleJob.remove).toHaveBeenCalledTimes(1);
        expect(mockDiscoverQueueAdd).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Discover Weekly recommendation generation started",
            jobId: "job-after-remove-fail",
        });
    });

    it("returns 500 when queue add fails while generating recommendations", async () => {
        mockDiscoverQueueGetJob.mockResolvedValueOnce(null);
        mockDiscoverQueueAdd.mockRejectedValueOnce(new Error("enqueue failed"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await generateHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start generation" });
    });

    it("returns 404 for unknown generation status job ids", async () => {
        mockDiscoverQueueGetJob.mockResolvedValueOnce(null);

        const req = { params: { jobId: "missing-job" } } as any;
        const res = createRes();

        await generateStatusHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Job not found" });
    });

    it("maps generation status payload for known queue jobs", async () => {
        const job = {
            getState: jest.fn().mockResolvedValue("completed"),
            progress: jest.fn().mockReturnValue(100),
            returnvalue: { generated: 25 },
        };
        mockDiscoverQueueGetJob.mockResolvedValueOnce(job);

        const req = { params: { jobId: "job-77" } } as any;
        const res = createRes();

        await generateStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            status: "completed",
            progress: 100,
            result: { generated: 25 },
        });
    });

    it("returns 500 when generation status lookup throws", async () => {
        mockDiscoverQueueGetJob.mockRejectedValueOnce(new Error("lookup failed"));

        const req = { params: { jobId: "job-err" } } as any;
        const res = createRes();
        await generateStatusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get job status" });
    });

    it("returns recommendation playlist from recommendation service", async () => {
        const playlist = {
            weekStart: "2026-02-09T00:00:00.000Z",
            weekEnd: "2026-02-15T23:59:59.999Z",
            tracks: [
                {
                    id: "track-1",
                    title: "Song",
                    artist: "Artist",
                    album: "Album",
                    sourceType: "local",
                },
            ],
            unavailable: [],
            totalCount: 1,
            unavailableCount: 0,
        };
        mockGetCurrentPlaylist.mockResolvedValue(playlist);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await currentHandler(req, res);

        expect(mockGetCurrentPlaylist).toHaveBeenCalledWith("user-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(playlist);
    });

    it("returns 500 when recommendation playlist retrieval fails", async () => {
        mockGetCurrentPlaylist.mockRejectedValueOnce(new Error("boom"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await currentHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get Discover Weekly playlist",
        });
    });

    it("clears recommendation playlist without legacy side effects", async () => {
        mockClearCurrentPlaylist.mockResolvedValue({ clearedCount: 3 });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await clearHandler(req, res);

        expect(mockClearCurrentPlaylist).toHaveBeenCalledWith("user-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Discovery recommendations cleared",
            likedMoved: 0,
            activeDeleted: 3,
            clearedCount: 3,
        });
    });

    it("returns 500 when recommendation clear fails", async () => {
        mockClearCurrentPlaylist.mockRejectedValueOnce(new Error("clear failed"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to clear discovery playlist",
            details: "clear failed",
        });
    });

    it("returns 410 for legacy-only mutation endpoints", async () => {
        const req = { user: { id: "user-1" }, body: {} } as any;

        const likeRes = createRes();
        await likeHandler(req, likeRes);
        expect(likeRes.statusCode).toBe(410);

        const unlikeRes = createRes();
        await unlikeHandler(req, unlikeRes);
        expect(unlikeRes.statusCode).toBe(410);

        const cleanupRes = createRes();
        await cleanupLidarrHandler(req, cleanupRes);
        expect(cleanupRes.statusCode).toBe(410);

        const fixTaggingRes = createRes();
        await fixTaggingHandler(req, fixTaggingRes);
        expect(fixTaggingRes.statusCode).toBe(410);
    });
});
