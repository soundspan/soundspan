const mockNotifyRequestFulfilled = jest.fn();
const mockNotifyRequestFailed = jest.fn();
const mockRecordMusicRequestAction = jest.fn();

const prisma = {
    downloadJob: {
        findMany: jest.fn(),
    },
    musicRequest: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../services/notificationService", () => ({
    notificationService: {
        notifyRequestFulfilled: (...args: unknown[]) =>
            mockNotifyRequestFulfilled(...args),
        notifyRequestFailed: (...args: unknown[]) =>
            mockNotifyRequestFailed(...args),
    },
}));
jest.mock("../../../metrics", () => ({
    recordMusicRequestAction: (...args: unknown[]) =>
        mockRecordMusicRequestAction(...args),
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

import {
    MAX_REQUEST_FULFILLMENTS_PER_TICK,
    processRequestFulfillmentBatch,
} from "../requestFulfillmentProcessor";

function requestWithJob(status: "completed" | "failed" | "exhausted") {
    return {
        id: `request-${status}`,
        userId: "user-1",
        rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
        artistName: "Massive Attack",
        albumTitle: "Mezzanine",
        status: "approved",
        downloadJobId: `job-${status}`,
        downloadJob: { status },
    };
}

describe("request fulfillment processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.musicRequest.updateMany.mockResolvedValue({ count: 1 });
        prisma.downloadJob.findMany.mockImplementation(
            async ({ where, select }: any) =>
                (where.id.in as string[]).map((id) =>
                    select.status
                        ? { id, status: id.replace("job-", "") }
                        : { id },
                ),
        );
        mockNotifyRequestFulfilled.mockResolvedValue(undefined);
        mockNotifyRequestFailed.mockResolvedValue(undefined);
    });

    it("marks completed downloads fulfilled and notifies the requester", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("completed"),
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 1,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-completed", status: "approved" },
            data: { status: "fulfilled" },
        });
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-completed" }),
        );
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("fulfilled");
    });

    it.each(["failed", "exhausted"] as const)(
        "marks %s downloads failed and reports failure honestly",
        async (jobStatus) => {
            prisma.musicRequest.findMany.mockResolvedValueOnce([
                requestWithJob(jobStatus),
            ]);

            await processRequestFulfillmentBatch();

            expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
                where: { id: `request-${jobStatus}`, status: "approved" },
                data: { status: "failed" },
            });
            expect(mockNotifyRequestFailed).toHaveBeenCalledWith(
                "user-1",
                expect.objectContaining({ requestId: `request-${jobStatus}` }),
            );
            expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("failed");
        },
    );

    it("does not notify twice when another tick already claimed the transition", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("completed"),
        ]);
        prisma.musicRequest.updateMany.mockResolvedValueOnce({ count: 0 });

        await processRequestFulfillmentBatch();

        expect(mockNotifyRequestFulfilled).not.toHaveBeenCalled();
        expect(mockRecordMusicRequestAction).not.toHaveBeenCalled();
    });

    it("fulfills every request linked to one completed job", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            {
                ...requestWithJob("completed"),
                id: "request-1",
                userId: "user-1",
            },
            {
                ...requestWithJob("completed"),
                id: "request-2",
                userId: "user-2",
            },
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 2,
            fulfilled: 2,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledTimes(2);
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-1" }),
        );
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-2",
            expect.objectContaining({ requestId: "request-2" }),
        );
    });

    it("fails a request with a deleted job once across repeated ticks", async () => {
        const request = {
            ...requestWithJob("failed"),
            id: "request-deleted",
            downloadJobId: "job-deleted",
        };
        prisma.musicRequest.findMany.mockResolvedValue([request]);
        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.musicRequest.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 1,
        });
        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 0,
        });

        expect(mockNotifyRequestFailed).toHaveBeenCalledTimes(1);
        expect(mockRecordMusicRequestAction).toHaveBeenCalledTimes(1);
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("failed");
    });

    it("leaves a request linked to an active job untouched", async () => {
        const request = {
            ...requestWithJob("failed"),
            id: "request-active",
            downloadJobId: "job-active",
        };
        prisma.musicRequest.findMany.mockResolvedValueOnce([request]);
        prisma.downloadJob.findMany.mockImplementation(
            async ({ where }: any) =>
                where.status ? [] : [{ id: "job-active" }],
        );

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).not.toHaveBeenCalled();
        expect(mockNotifyRequestFailed).not.toHaveBeenCalled();
    });

    it("caps each query at the documented batch bound", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([]);

        await processRequestFulfillmentBatch();

        expect(MAX_REQUEST_FULFILLMENTS_PER_TICK).toBe(200);
        expect(prisma.musicRequest.findMany).toHaveBeenCalledWith({
            where: {
                status: "approved",
                downloadJobId: { not: null },
            },
            select: {
                id: true,
                userId: true,
                rgMbid: true,
                artistName: true,
                albumTitle: true,
                downloadJobId: true,
            },
            orderBy: { updatedAt: "asc" },
            take: 200,
        });
        expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
    });
});
