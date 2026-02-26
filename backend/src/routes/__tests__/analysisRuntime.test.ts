import os from "os";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
            updateMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        systemSettings: {
            update: jest.fn(),
        },
        $queryRaw: jest.fn(),
        $executeRaw: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        lLen: jest.fn(),
        multi: jest.fn(),
        rPush: jest.fn(),
        publish: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn(),
        clearAllFailures: jest.fn(),
        clearFailure: jest.fn(),
        getFailures: jest.fn(),
        resetRetryCount: jest.fn(),
        resolveByEntity: jest.fn(),
    },
}));

import router from "../analysis";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { getSystemSettings } from "../../utils/systemSettings";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";

const mockGroupBy = prisma.track.groupBy as jest.Mock;
const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockTrackUpdateMany = prisma.track.updateMany as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackUpdate = prisma.track.update as jest.Mock;
const mockSystemSettingsUpdate = prisma.systemSettings.update as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockExecuteRaw = prisma.$executeRaw as jest.Mock;

const mockRedisLLen = redisClient.lLen as jest.Mock;
const mockRedisMulti = redisClient.multi as jest.Mock;
const mockRedisRPush = redisClient.rPush as jest.Mock;
const mockRedisPublish = redisClient.publish as jest.Mock;

const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockRecordFailure = enrichmentFailureService.recordFailure as jest.Mock;
const mockClearAllFailures = enrichmentFailureService.clearAllFailures as jest.Mock;
const mockClearFailure = enrichmentFailureService.clearFailure as jest.Mock;
const mockGetFailures = enrichmentFailureService.getFailures as jest.Mock;
const mockResetRetryCount = enrichmentFailureService.resetRetryCount as jest.Mock;
const mockResolveByEntity = enrichmentFailureService.resolveByEntity as jest.Mock;

function getHandler(method: "get" | "post" | "put", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) throw new Error(`${method.toUpperCase()} route not found: ${path}`);
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

function createPipeline() {
    return {
        rPush: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
    };
}

describe("analysis routes runtime", () => {
    const getStatus = getHandler("get", "/status");
    const postStart = getHandler("post", "/start");
    const postRetryFailed = getHandler("post", "/retry-failed");
    const postAnalyzeTrack = getHandler("post", "/analyze/:trackId");
    const getTrack = getHandler("get", "/track/:trackId");
    const getFeatures = getHandler("get", "/features");
    const getWorkers = getHandler("get", "/workers");
    const putWorkers = getHandler("put", "/workers");
    const getClapWorkers = getHandler("get", "/clap-workers");
    const putClapWorkers = getHandler("put", "/clap-workers");
    const postVibeFailure = getHandler("post", "/vibe/failure");
    const postVibeStart = getHandler("post", "/vibe/start");
    const postVibeRetry = getHandler("post", "/vibe/retry");
    const postVibeSuccess = getHandler("post", "/vibe/success");

    beforeEach(() => {
        jest.clearAllMocks();

        mockGroupBy.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackUpdateMany.mockResolvedValue({ count: 0 });
        mockTrackFindUnique.mockResolvedValue(null);
        mockTrackUpdate.mockResolvedValue({});
        mockSystemSettingsUpdate.mockResolvedValue({});
        mockQueryRaw.mockResolvedValue([]);
        mockExecuteRaw.mockResolvedValue(0);

        mockRedisLLen.mockResolvedValue(0);
        mockRedisRPush.mockResolvedValue(1);
        mockRedisPublish.mockResolvedValue(1);
        mockRedisMulti.mockImplementation(() => createPipeline());

        mockGetSystemSettings.mockResolvedValue({
            audioAnalyzerWorkers: 2,
            clapWorkers: 2,
        });
        mockRecordFailure.mockResolvedValue({});
        mockClearAllFailures.mockResolvedValue({});
        mockClearFailure.mockResolvedValue({});
        mockGetFailures.mockResolvedValue({ failures: [] });
        mockResetRetryCount.mockResolvedValue({});
        mockResolveByEntity.mockResolvedValue({});

        process.env.INTERNAL_API_SECRET = "test-secret";
        jest.spyOn(os, "cpus").mockReturnValue(new Array(8).fill({}) as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns aggregate analysis status with progress", async () => {
        mockGroupBy.mockResolvedValue([
            { analysisStatus: "completed", _count: 7 },
            { analysisStatus: "failed", _count: 1 },
            { analysisStatus: "processing", _count: 2 },
            { analysisStatus: "pending", _count: 5 },
        ]);
        mockRedisLLen.mockResolvedValue(3);
        mockQueryRaw.mockResolvedValue([{ count: BigInt(4) }]);

        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await getStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                total: 15,
                completed: 7,
                failed: 1,
                processing: 2,
                pending: 5,
                queueLength: 3,
                progress: 47,
                isComplete: false,
                clap: expect.objectContaining({
                    withEmbeddings: 4,
                    embeddingProgress: 27,
                }),
            })
        );
    });

    it("returns 500 when status aggregation fails", async () => {
        mockGroupBy.mockRejectedValue(new Error("db down"));
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await getStatus(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get analysis status" });
    });

    it("returns no-op response when start finds no pending tracks", async () => {
        mockTrackFindMany.mockResolvedValue([]);
        const req = { user: { id: "admin" }, body: {} } as any;
        const res = createRes();

        await postStart(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "No pending tracks to analyze",
            queued: 0,
        });
    });

    it("queues pending tracks for analysis start", async () => {
        const pipeline = createPipeline();
        mockRedisMulti.mockReturnValue(pipeline);
        mockTrackFindMany.mockResolvedValue([
            { id: "t1", filePath: "/f1.mp3", duration: 120 },
            { id: "t2", filePath: "/f2.mp3", duration: 180 },
        ]);

        const req = {
            user: { id: "admin" },
            body: { limit: 2000, priority: "recent" },
        } as any;
        const res = createRes();

        await postStart(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 1000,
                orderBy: { fileModified: "desc" },
            })
        );
        expect(pipeline.rPush).toHaveBeenCalledTimes(2);
        expect(pipeline.exec).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Queued 2 tracks for analysis",
            queued: 2,
        });
    });

    it("resets failed tracks to pending", async () => {
        mockTrackUpdateMany.mockResolvedValue({ count: 6 });
        const req = { user: { id: "admin" } } as any;
        const res = createRes();

        await postRetryFailed(req, res);

        expect(res.body).toEqual({
            message: "Reset 6 failed tracks to pending",
            reset: 6,
        });
    });

    it("handles analyze/:trackId not found and queue flow", async () => {
        const notFoundReq = { params: { trackId: "missing" } } as any;
        const notFoundRes = createRes();
        mockTrackFindUnique.mockResolvedValueOnce(null);
        await postAnalyzeTrack(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);

        mockTrackFindUnique.mockResolvedValueOnce({
            id: "t100",
            filePath: "/music/t100.mp3",
            duration: 222,
            analysisStatus: "pending",
        });
        const req = { params: { trackId: "t100" } } as any;
        const res = createRes();
        await postAnalyzeTrack(req, res);

        expect(mockRedisRPush).toHaveBeenCalledWith(
            "audio:analysis:queue",
            JSON.stringify({
                trackId: "t100",
                filePath: "/music/t100.mp3",
                duration: 222,
            })
        );
        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: "t100" },
            data: { analysisStatus: "pending" },
        });
        expect(res.body).toEqual({
            message: "Track queued for analysis",
            trackId: "t100",
        });
    });

    it("returns track analysis payload or 404", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);
        const missingReq = { params: { trackId: "x" } } as any;
        const missingRes = createRes();
        await getTrack(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        mockTrackFindUnique.mockResolvedValueOnce({
            id: "t2",
            title: "Track Two",
            analysisStatus: "completed",
        });
        const req = { params: { trackId: "t2" } } as any;
        const res = createRes();
        await getTrack(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({ id: "t2", title: "Track Two" })
        );
    });

    it("returns empty features when no analyzed tracks exist", async () => {
        mockTrackFindMany.mockResolvedValue([]);
        const req = {} as any;
        const res = createRes();

        await getFeatures(req, res);

        expect(res.body).toEqual({
            count: 0,
            averages: null,
            distributions: null,
        });
    });

    it("calculates feature averages and distributions", async () => {
        mockTrackFindMany.mockResolvedValue([
            { bpm: 80, energy: 0.2, danceability: 0.3, valence: 0.4, keyScale: "minor" },
            { bpm: 100, energy: 0.5, danceability: 0.6, valence: 0.7, keyScale: "major" },
            { bpm: 140, energy: 0.9, danceability: 0.8, valence: 0.6, keyScale: "major" },
        ]);

        const req = {} as any;
        const res = createRes();
        await getFeatures(req, res);

        expect(res.body).toEqual(
            expect.objectContaining({
                count: 3,
                averages: {
                    bpm: 107,
                    energy: 0.53,
                    danceability: 0.57,
                    valence: 0.57,
                },
                distributions: expect.objectContaining({
                    key: { major: 2, minor: 1 },
                    bpm: { slow: 1, moderate: 1, upbeat: 1, fast: 0 },
                }),
            })
        );
    });

    it("gets and updates worker settings", async () => {
        mockGetSystemSettings.mockResolvedValue({ audioAnalyzerWorkers: 4 });

        const getReq = {} as any;
        const getRes = createRes();
        await getWorkers(getReq, getRes);
        expect(getRes.statusCode).toBe(200);
        expect(getRes.body).toEqual(
            expect.objectContaining({
                workers: 4,
                cpuCores: 8,
                recommended: 4,
            })
        );

        const badReq = { body: { workers: 0 } } as any;
        const badRes = createRes();
        await putWorkers(badReq, badRes);
        expect(badRes.statusCode).toBe(400);

        const okReq = { body: { workers: 3 } } as any;
        const okRes = createRes();
        await putWorkers(okReq, okRes);
        expect(mockSystemSettingsUpdate).toHaveBeenCalledWith({
            where: { id: "default" },
            data: { audioAnalyzerWorkers: 3 },
        });
        expect(mockRedisPublish).toHaveBeenCalledWith(
            "audio:analysis:control",
            JSON.stringify({ command: "set_workers", count: 3 })
        );
        expect(okRes.statusCode).toBe(200);
    });

    it("gets and updates CLAP worker settings", async () => {
        mockGetSystemSettings.mockResolvedValue({ clapWorkers: 5 });
        const getReq = {} as any;
        const getRes = createRes();
        await getClapWorkers(getReq, getRes);
        expect(getRes.body).toEqual(
            expect.objectContaining({
                workers: 5,
                cpuCores: 8,
                recommended: 4,
            })
        );

        const badReq = { body: { workers: 9 } } as any;
        const badRes = createRes();
        await putClapWorkers(badReq, badRes);
        expect(badRes.statusCode).toBe(400);

        const okReq = { body: { workers: 2 } } as any;
        const okRes = createRes();
        await putClapWorkers(okReq, okRes);
        expect(mockSystemSettingsUpdate).toHaveBeenCalledWith({
            where: { id: "default" },
            data: { clapWorkers: 2 },
        });
        expect(mockRedisPublish).toHaveBeenCalledWith(
            "audio:clap:control",
            JSON.stringify({ command: "set_workers", count: 2 })
        );
        expect(okRes.statusCode).toBe(200);
    });

    it("validates and records vibe failure endpoint", async () => {
        const forbiddenReq = {
            headers: { "x-internal-secret": "wrong" },
            body: {},
        } as any;
        const forbiddenRes = createRes();
        await postVibeFailure(forbiddenReq, forbiddenRes);
        expect(forbiddenRes.statusCode).toBe(403);

        const missingReq = {
            headers: { "x-internal-secret": "test-secret" },
            body: {},
        } as any;
        const missingRes = createRes();
        await postVibeFailure(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const req = {
            headers: { "x-internal-secret": "test-secret" },
            body: { trackId: "t1", trackName: "Track", errorMessage: "bad" },
        } as any;
        const res = createRes();
        await postVibeFailure(req, res);
        expect(mockRecordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "vibe",
                entityId: "t1",
                entityName: "Track",
                errorMessage: "bad",
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("queues vibe embedding jobs in force mode and clears failures", async () => {
        const pipeline = createPipeline();
        mockRedisMulti.mockReturnValue(pipeline);
        mockQueryRaw.mockResolvedValue([
            { id: "t1", filePath: "/x.mp3", duration: 111, title: "T1" },
            { id: "t2", filePath: "/y.mp3", duration: 222, title: "T2" },
        ]);

        const req = { body: { limit: 50, force: true } } as any;
        const res = createRes();

        await postVibeStart(req, res);

        expect(mockExecuteRaw).toHaveBeenCalled();
        expect(mockTrackUpdateMany).toHaveBeenCalledWith({
            data: expect.objectContaining({
                vibeAnalysisStatus: "pending",
                vibeAnalysisRetryCount: 0,
                vibeAnalysisError: null,
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: expect.any(Date),
            }),
        });
        expect(mockClearAllFailures).toHaveBeenCalledWith("vibe");
        expect(pipeline.rPush).toHaveBeenCalledTimes(2);
        expect(mockClearFailure).toHaveBeenCalledWith("vibe", "t1");
        expect(mockClearFailure).toHaveBeenCalledWith("vibe", "t2");
        expect(res.body).toEqual({
            message: "Queued 2 tracks for vibe embedding",
            queued: 2,
        });
    });

    it("returns no-op vibe start when all tracks already have embeddings", async () => {
        mockQueryRaw.mockResolvedValue([]);
        const req = { body: {} } as any;
        const res = createRes();
        await postVibeStart(req, res);
        expect(res.body).toEqual({
            message: "All tracks have vibe embeddings",
            queued: 0,
        });
    });

    it("retries vibe failures or no-ops when none exist", async () => {
        mockGetFailures.mockResolvedValueOnce({ failures: [] });
        const noFailuresReq = {} as any;
        const noFailuresRes = createRes();
        await postVibeRetry(noFailuresReq, noFailuresRes);
        expect(noFailuresRes.body).toEqual({
            message: "No vibe failures to retry",
            queued: 0,
        });

        const pipeline = createPipeline();
        mockRedisMulti.mockReturnValue(pipeline);
        mockGetFailures.mockResolvedValueOnce({
            failures: [{ id: "f1", entityId: "t9" }],
        });
        mockTrackFindMany.mockResolvedValueOnce([
            { id: "t9", filePath: "/t9.mp3", duration: 123, title: "T9" },
        ]);

        const req = {} as any;
        const res = createRes();
        await postVibeRetry(req, res);

        expect(mockTrackUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ["t9"] } },
            data: expect.objectContaining({
                vibeAnalysisStatus: "pending",
                vibeAnalysisError: null,
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: expect.any(Date),
            }),
        });
        expect(pipeline.rPush).toHaveBeenCalledTimes(1);
        expect(mockResetRetryCount).toHaveBeenCalledWith(["f1"]);
        expect(res.body).toEqual({
            message: "Queued 1 failed tracks for vibe embedding retry",
            queued: 1,
        });
    });

    it("validates and resolves vibe success endpoint", async () => {
        const forbiddenReq = {
            headers: { "x-internal-secret": "bad" },
            body: {},
        } as any;
        const forbiddenRes = createRes();
        await postVibeSuccess(forbiddenReq, forbiddenRes);
        expect(forbiddenRes.statusCode).toBe(403);

        const missingReq = {
            headers: { "x-internal-secret": "test-secret" },
            body: {},
        } as any;
        const missingRes = createRes();
        await postVibeSuccess(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const req = {
            headers: { "x-internal-secret": "test-secret" },
            body: { trackId: "track-77" },
        } as any;
        const res = createRes();
        await postVibeSuccess(req, res);
        expect(mockResolveByEntity).toHaveBeenCalledWith("vibe", "track-77");
        expect(res.body).toEqual({ message: "Stale failures resolved" });
    });

    it("returns 500 when start fails", async () => {
        mockTrackFindMany.mockRejectedValue(new Error("start failed"));
        const req = { user: { id: "admin" }, body: {} } as any;
        const res = createRes();

        await postStart(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start analysis" });
    });

    it("returns 500 when retrying failed tracks fails", async () => {
        mockTrackUpdateMany.mockRejectedValue(new Error("retry failed"));
        const req = { user: { id: "admin" } } as any;
        const res = createRes();

        await postRetryFailed(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to retry analysis" });
    });

    it("returns 500 when analyze/:trackId catch branch is hit", async () => {
        mockTrackFindUnique.mockRejectedValue(new Error("analyze failed"));
        const req = { params: { trackId: "t100" } } as any;
        const res = createRes();

        await postAnalyzeTrack(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to queue track for analysis" });
    });

    it("returns 500 when get track analysis catch branch is hit", async () => {
        mockTrackFindUnique.mockRejectedValue(new Error("track lookup failed"));
        const req = { params: { trackId: "x" } } as any;
        const res = createRes();

        await getTrack(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get track analysis" });
    });

    it("returns 500 when features catch branch is hit", async () => {
        mockTrackFindMany.mockRejectedValue(new Error("feature query failed"));
        const req = {} as any;
        const res = createRes();

        await getFeatures(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get feature statistics" });
    });

    it("returns 500 when getting worker configuration fails", async () => {
        mockGetSystemSettings.mockRejectedValue(new Error("workers read failed"));
        const getReq = {} as any;
        const getRes = createRes();

        await getWorkers(getReq, getRes);

        expect(getRes.statusCode).toBe(500);
        expect(getRes.body).toEqual({ error: "Failed to get worker configuration" });
    });

    it("returns 500 when updating worker configuration fails", async () => {
        mockSystemSettingsUpdate.mockRejectedValue(new Error("workers update failed"));
        const req = { body: { workers: 3 } } as any;
        const res = createRes();

        await putWorkers(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update worker configuration" });
    });

    it("returns 500 when getting CLAP worker configuration fails", async () => {
        mockGetSystemSettings.mockRejectedValue(new Error("clap workers read failed"));
        const getReq = {} as any;
        const getRes = createRes();

        await getClapWorkers(getReq, getRes);

        expect(getRes.statusCode).toBe(500);
        expect(getRes.body).toEqual({ error: "Failed to get CLAP worker configuration" });
    });

    it("returns 500 when updating CLAP worker configuration fails", async () => {
        mockSystemSettingsUpdate.mockRejectedValue(new Error("clap workers update failed"));
        const req = { body: { workers: 2 } } as any;
        const res = createRes();

        await putClapWorkers(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update CLAP worker configuration" });
    });

    it("returns 500 when recording vibe failure catch branch is hit", async () => {
        mockRecordFailure.mockRejectedValue(new Error("vibe failure failed"));
        const req = {
            headers: { "x-internal-secret": "test-secret" },
            body: { trackId: "t1", trackName: "Track", errorMessage: "bad" },
        } as any;
        const res = createRes();

        await postVibeFailure(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to record failure" });
    });

    it("returns 500 when starting vibe embedding catch branch is hit", async () => {
        mockQueryRaw.mockRejectedValue(new Error("vibe start failed"));
        const req = { body: {} } as any;
        const res = createRes();

        await postVibeStart(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start vibe embedding" });
    });

    it("returns 500 when retry vibe failures catch branch is hit", async () => {
        mockGetFailures.mockRejectedValue(new Error("vibe retry failed"));
        const req = {} as any;
        const res = createRes();

        await postVibeRetry(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to retry vibe failures" });
    });

    it("returns 500 when resolving vibe success catch branch is hit", async () => {
        mockResolveByEntity.mockRejectedValue(new Error("vibe success failed"));
        const req = {
            headers: { "x-internal-secret": "test-secret" },
            body: { trackId: "track-77" },
        } as any;
        const res = createRes();

        await postVibeSuccess(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to resolve failures" });
    });
});
