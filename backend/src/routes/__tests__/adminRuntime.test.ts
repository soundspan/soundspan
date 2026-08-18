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

jest.mock("../../workers/queues", () => ({
    schedulerQueue: {
        add: jest.fn(),
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

    it("skips the purge job when no removed local tracks match", async () => {
        mockRemovedTrackCount.mockResolvedValueOnce(0);
        const res = createRes();

        await purgeRemovedTracksHandler({} as any, res);

        expect(mockSchedulerAdd).not.toHaveBeenCalled();
        expect(res.body).toEqual({ enqueued: false, matched: 0 });
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
});
