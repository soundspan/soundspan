import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        mockLogger.child.mockReturnValue(mockLogger);
        return mockLogger;
    })(),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        libraryHealthRecord: {
            findMany: jest.fn(),
            count: jest.fn(),
            delete: jest.fn(),
        },
        track: {
            count: jest.fn(),
        },
    },
}));

const mockRedisEval = jest.fn();
jest.mock("../../utils/redis", () => ({
    redisClient: { eval: mockRedisEval },
}));

jest.mock("../../workers/queues", () => ({
    schedulerQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
        getJobs: jest.fn(),
        getFailed: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: { workers: { trackRemovalRetentionDays: 90 } },
}));

import router from "../admin";
import { prisma } from "../../utils/db";
import { schedulerQueue } from "../../workers/queues";

const mockFindMany = prisma.libraryHealthRecord.findMany as jest.Mock;
const mockCount = prisma.libraryHealthRecord.count as jest.Mock;
const mockDelete = prisma.libraryHealthRecord.delete as jest.Mock;
const mockRemovedTrackCount = prisma.track.count as jest.Mock;
const mockSchedulerAdd = schedulerQueue.add as jest.Mock;
const mockSchedulerGetJob = schedulerQueue.getJob as jest.Mock;
const mockSchedulerGetJobs = (schedulerQueue as any).getJobs as jest.Mock;
const mockSchedulerGetFailed = (schedulerQueue as any).getFailed as jest.Mock;

function getHandler(path: string, method: "get" | "post" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
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

describe("admin library health routes", () => {
    const getLibraryHealthHandler = getHandler("/library-health", "get");
    const dismissLibraryHealthHandler = getHandler(
        "/library-health/:recordId",
        "delete",
    );
    const purgeRemovedTracksHandler = getHandler(
        "/library-health/purge-removed",
        "post",
    );

    beforeEach(() => {
        jest.clearAllMocks();
        mockCount.mockResolvedValue(1);
        mockFindMany.mockResolvedValue([
            {
                id: "record-1",
                trackId: "track-1",
                status: "MISSING_FROM_DISK",
                filePath: "/music/example.mp3",
                detail: null,
                detectedAt: new Date("2026-03-10T00:00:00.000Z"),
                updatedAt: new Date("2026-03-10T01:00:00.000Z"),
                track: {
                    id: "track-1",
                    title: "Example Track",
                    removedAt: new Date("2026-03-10T00:30:00.000Z"),
                    album: {
                        title: "Example Album",
                        artist: { name: "Example Artist" },
                    },
                },
            },
        ]);
        mockDelete.mockResolvedValue({ id: "record-1" });
        mockRemovedTrackCount.mockResolvedValue(3);
        mockSchedulerAdd.mockResolvedValue({ id: "purge-now" });
        mockSchedulerGetJob.mockResolvedValue(undefined);
        mockSchedulerGetJobs.mockResolvedValue([]);
        mockSchedulerGetFailed.mockResolvedValue([]);
        mockRedisEval.mockResolvedValue("-1");
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("returns library health records for admins", async () => {
        const req = { user: { id: "admin-1" } } as any;
        const res = createRes();

        await getLibraryHealthHandler(req, res);

        expect(mockFindMany).toHaveBeenCalledWith({
            include: {
                track: {
                    select: {
                        id: true,
                        title: true,
                        removedAt: true,
                        album: {
                            select: {
                                title: true,
                                artist: {
                                    select: {
                                        name: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            records: [
                expect.objectContaining({
                    id: "record-1",
                    trackId: "track-1",
                    track: expect.objectContaining({
                        title: "Example Track",
                    }),
                }),
            ],
            total: 1,
            removedPendingPurgeCount: 1,
            trackRemovalRetentionDays: 90,
        });
    });

    it("dismisses a library health record", async () => {
        const req = { params: { recordId: "record-1" } } as any;
        const res = createRes();

        await dismissLibraryHealthHandler(req, res);

        expect(mockDelete).toHaveBeenCalledWith({
            where: { id: "record-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("returns the number of removed local tracks matched for purge", async () => {
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockRemovedTrackCount).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                removedAt: { not: null },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ enqueued: true, matched: 3 });
    });

    it("enqueues a terminal purge job when no removed local tracks match", async () => {
        mockRemovedTrackCount.mockResolvedValueOnce(0);
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockSchedulerAdd).toHaveBeenCalledWith(
            "track-removal-purge",
            expect.objectContaining({ cutoffAt: expect.any(String) }),
            expect.objectContaining({
                jobId: "scheduler:track-removal-purge:purge-now",
            }),
        );
        expect(res.body).toEqual({
            enqueued: false,
            matched: 0,
            terminalEnqueued: true,
        });
    });

    it("uses a singleton job id for the purge-now sweep", async () => {
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockSchedulerAdd).toHaveBeenCalledWith(
            "track-removal-purge",
            expect.any(Object),
            expect.objectContaining({
                jobId: "scheduler:track-removal-purge:purge-now",
            }),
        );
    });

    it("pins the purge-now cutoff to the current instant", async () => {
        const now = new Date("2026-08-18T15:30:00.000Z");
        jest.useFakeTimers().setSystemTime(now);
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockSchedulerAdd).toHaveBeenCalledWith(
            "track-removal-purge",
            { cutoffAt: now.toISOString() },
            expect.any(Object),
        );
    });

    it("leaves purge-now run id ownership to the processor", async () => {
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockSchedulerAdd.mock.calls[0]?.[1]).not.toHaveProperty(
            "sweepRunId",
        );
    });

    it.each(["failed", "waiting"])(
        "replaces a %s purge-now job with a freshly pinned sweep",
        async (state) => {
            const now = new Date("2026-08-18T15:30:00.000Z");
            jest.useFakeTimers().setSystemTime(now);
            const remove = jest.fn().mockResolvedValue(undefined);
            const getState = jest.fn().mockResolvedValue(state);
            mockSchedulerGetJob.mockResolvedValueOnce({ getState, remove });
            const res = createRes();

            await purgeRemovedTracksHandler({} as any, res);

            expect(mockSchedulerGetJob).toHaveBeenCalledWith(
                "scheduler:track-removal-purge:purge-now",
            );
            expect(getState).toHaveBeenCalledTimes(1);
            expect(remove).toHaveBeenCalledTimes(1);
            expect(mockSchedulerAdd).toHaveBeenCalledWith(
                "track-removal-purge",
                { cutoffAt: now.toISOString() },
                expect.objectContaining({
                    jobId: "scheduler:track-removal-purge:purge-now",
                }),
            );
            expect(res.body).toEqual({ enqueued: true, matched: 3 });
        },
    );

    it("leaves an active purge-now job in place", async () => {
        const remove = jest.fn();
        mockSchedulerGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("active"),
            remove,
        });
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(remove).not.toHaveBeenCalled();
        expect(mockSchedulerAdd).not.toHaveBeenCalled();
        expect(res.body).toEqual({ enqueued: true, matched: 3 });
    });

    it("falls back to add when replacing a purge-now job races its state", async () => {
        const remove = jest
            .fn()
            .mockRejectedValue(new Error("job is already active"));
        mockSchedulerGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("waiting"),
            remove,
        });
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(remove).toHaveBeenCalledTimes(1);
        expect(mockSchedulerAdd).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual({ enqueued: true, matched: 3 });
    });

    it("returns a safe error when the purge-now job cannot be enqueued", async () => {
        mockSchedulerAdd.mockRejectedValueOnce(
            new Error("redis details must stay internal"),
        );
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to enqueue removed track purge",
        });
    });

    describe("purge status", () => {
        const purgeStatusHandler = getHandler(
            "/library-health/purge-status",
            "get",
        );

        it("reports an idle purge with no failures", async () => {
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body).toEqual({
                remaining: 3,
                purging: false,
                lastFailure: null,
            });
        });

        it("reports the stable purge marker before inspecting the queue", async () => {
            mockRedisEval.mockResolvedValueOnce("17");
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body).toEqual({
                remaining: 17,
                purging: true,
                lastFailure: null,
            });
            expect(mockRemovedTrackCount).not.toHaveBeenCalled();
            expect(mockSchedulerGetJob).not.toHaveBeenCalled();
            expect(mockSchedulerGetJobs).not.toHaveBeenCalled();
        });

        it("reports a waiting purge-now singleton as in flight", async () => {
            mockSchedulerGetJob.mockResolvedValue({
                getState: jest.fn().mockResolvedValue("waiting"),
            });
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(mockSchedulerGetJobs).not.toHaveBeenCalled();
            expect(res.body).toEqual({
                remaining: 3,
                purging: true,
                lastFailure: null,
            });
        });

        it("ignores a delayed scheduled purge", async () => {
            mockSchedulerGetJobs.mockImplementation(async (states: string[]) =>
                states.includes("delayed")
                    ? [
                          {
                              id: "repeat:daily-purge",
                              name: "track-removal-purge",
                              data: { mode: "repeat" },
                          },
                      ]
                    : [],
            );
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body).toEqual({
                remaining: 3,
                purging: false,
                lastFailure: null,
            });
        });

        it("reports a waiting continuation page as in flight", async () => {
            mockSchedulerGetJobs.mockImplementation(async (states: string[]) =>
                states.includes("waiting")
                    ? [
                          {
                              id: "scheduler:track-removal-purge:2026-08-18T12:00:00.000Z:track-100",
                              name: "track-removal-purge",
                              data: {
                                  startAfterId: "track-100",
                                  cutoffAt: "2026-08-18T12:00:00.000Z",
                                  deletedSoFar: 100,
                                  sweepRunId: "purge-root",
                                  initialTotal: 117,
                                  processedSoFar: 100,
                                  remaining: 17,
                                  pageNumber: 1,
                              },
                          },
                      ]
                    : [],
            );
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body).toEqual({
                remaining: 3,
                purging: true,
                lastFailure: null,
            });
        });

        it("reports an active scheduled purge as in flight", async () => {
            mockSchedulerGetJobs.mockResolvedValue([
                { name: "track-removal-purge" },
            ]);
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(mockSchedulerGetJobs).toHaveBeenCalledWith(
                ["active"],
                0,
                500,
            );
            expect(res.body).toEqual({
                remaining: 3,
                purging: true,
                lastFailure: null,
            });
        });

        it("reports a recent purge failure with a bounded first-line reason", async () => {
            mockSchedulerGetFailed.mockResolvedValue([
                { name: "other-job", failedReason: "irrelevant" },
                {
                    name: "track-removal-purge",
                    finishedOn: Date.now() - 60_000,
                    failedReason:
                        "\nInvalid `prisma.track.deleteMany()` invocation:\n" +
                        `Database error 23514 ${"x".repeat(400)}`,
                },
            ]);
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body.remaining).toBe(3);
            expect(res.body.purging).toBe(false);
            expect(res.body.lastFailure).toMatch(
                /^Invalid `prisma\.track\.deleteMany\(\)` invocation:$/,
            );
        });

        it("ignores purge failures older than the reporting window", async () => {
            mockSchedulerGetFailed.mockResolvedValue([
                {
                    name: "track-removal-purge",
                    finishedOn: Date.now() - 7 * 60 * 60 * 1000,
                    failedReason: "ancient failure",
                },
            ]);
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.body.lastFailure).toBeNull();
        });

        it("returns a safe error when the status read fails", async () => {
            mockRemovedTrackCount.mockRejectedValueOnce(
                new Error("db details must stay internal"),
            );
            const res = createRes();

            await purgeStatusHandler({} as any, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({
                error: "Failed to read purge status",
            });
        });
    });
});
