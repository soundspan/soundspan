const mockNotifyRequestFulfilled = jest.fn();
const mockNotifyRequestFailed = jest.fn();
const mockNotifyAdminRequestFailed = jest.fn();
const mockRecordMusicRequestAction = jest.fn();
const mockLoggerWarn = jest.fn();
const mockListAdminRecipientIds = jest.fn();

const prisma = {
    album: {
        findMany: jest.fn(),
    },
    downloadJob: {
        findMany: jest.fn(),
    },
    musicRequest: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
    user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../services/notificationService", () => ({
    buildRequestNotificationMetadata: (
        request: {
            id: string;
            rgMbid: string;
            artistName: string;
            albumTitle: string;
        },
        albumId?: string,
    ) => ({
        requestId: request.id,
        rgMbid: request.rgMbid,
        artistName: request.artistName,
        albumTitle: request.albumTitle,
        ...(albumId ? { albumId } : {}),
    }),
    listAdminRecipientIds: (...args: unknown[]) =>
        mockListAdminRecipientIds(...args),
    notificationService: {
        notifyRequestFulfilled: (...args: unknown[]) =>
            mockNotifyRequestFulfilled(...args),
        notifyRequestFailed: (...args: unknown[]) =>
            mockNotifyRequestFailed(...args),
        notifyAdminRequestFailed: (...args: unknown[]) =>
            mockNotifyAdminRequestFailed(...args),
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
            warn: (...args: unknown[]) => mockLoggerWarn(...args),
            error: jest.fn(),
        }),
    },
}));

import {
    MAX_REQUEST_FULFILLMENT_PAGES,
    MAX_REQUEST_FULFILLMENTS_PER_TICK,
    processRequestFulfillmentBatch,
} from "../requestFulfillmentProcessor";

function requestWithJob(
    status: "completed" | "failed" | "exhausted" | "cancelled",
) {
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
        prisma.downloadJob.findMany.mockReset();
        prisma.musicRequest.findMany.mockReset();
        prisma.musicRequest.findMany.mockResolvedValue([]);
        prisma.musicRequest.updateMany.mockResolvedValue({ count: 1 });
        prisma.album.findMany.mockResolvedValue([]);
        prisma.downloadJob.findMany.mockImplementation(async ({ where }: any) =>
            (where.id.in as string[]).map((id) => ({
                id,
                status: id.replace("job-", ""),
            })),
        );
        prisma.user.findUnique.mockResolvedValue({ username: "listener" });
        prisma.user.findMany.mockResolvedValue([
            { id: "admin-1" },
            { id: "user-1" },
        ]);
        mockListAdminRecipientIds.mockImplementation(async () => {
            const admins = await prisma.user.findMany({
                where: { role: "admin" },
                select: { id: true },
                take: 200,
            });
            return admins.map(({ id }: { id: string }) => id);
        });
        mockNotifyRequestFulfilled.mockResolvedValue(undefined);
        mockNotifyRequestFailed.mockResolvedValue(undefined);
        mockNotifyAdminRequestFailed.mockResolvedValue(undefined);
    });

    it("marks completed downloads fulfilled and notifies the requester", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("completed"),
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "album-1",
                rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
            },
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 1,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: {
                id: "request-completed",
                status: "approved",
                downloadJobId: "job-completed",
            },
            data: { status: "fulfilled" },
        });
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({
                requestId: "request-completed",
                albumId: "album-1",
            }),
        );
        expect(mockListAdminRecipientIds).not.toHaveBeenCalled();
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
                where: {
                    id: `request-${jobStatus}`,
                    status: "approved",
                    downloadJobId: `job-${jobStatus}`,
                },
                data: { status: "failed" },
            });
            expect(mockNotifyRequestFailed).toHaveBeenCalledWith(
                "user-1",
                expect.objectContaining({ requestId: `request-${jobStatus}` }),
                "download_failed",
            );
            expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("failed");
        },
    );

    it.each(["cancelled", "deleted"] as const)(
        "marks a %s download as stopped",
        async (jobStatus) => {
            const request = {
                ...requestWithJob("cancelled"),
                id: `request-${jobStatus}`,
                downloadJobId: `job-${jobStatus}`,
            };
            prisma.musicRequest.findMany.mockResolvedValueOnce([request]);
            if (jobStatus === "deleted") {
                prisma.downloadJob.findMany.mockResolvedValueOnce([]);
            }

            await processRequestFulfillmentBatch();

            expect(mockNotifyRequestFailed).toHaveBeenCalledWith(
                "user-1",
                expect.objectContaining({ requestId: `request-${jobStatus}` }),
                "download_stopped",
            );
        },
    );

    it("fulfills a failed terminal candidate when the album is in the library", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "album-1",
                rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
            },
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 1,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: {
                id: "request-failed",
                status: "approved",
                downloadJobId: "job-failed",
            },
            data: { status: "fulfilled" },
        });
        expect(mockNotifyRequestFailed).not.toHaveBeenCalled();
        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.album.findMany).toHaveBeenCalledWith({
            where: {
                rgMbid: { in: ["4f9d25d1-32c2-4093-83a5-34fcbaaf6f25"] },
                location: "LIBRARY",
            },
            select: { id: true, rgMbid: true },
        });
    });

    it("alerts admins about failures and excludes an admin requester", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);

        await processRequestFulfillmentBatch();

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: { role: "admin" },
            select: { id: true },
            take: 200,
        });
        expect(mockNotifyAdminRequestFailed).toHaveBeenCalledTimes(1);
        expect(mockNotifyAdminRequestFailed).toHaveBeenCalledWith(
            "admin-1",
            "listener",
            expect.objectContaining({ requestId: "request-failed" }),
            "download_failed",
        );
    });

    it("loads administrator recipients once for several failures in one tick", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            { ...requestWithJob("failed"), id: "request-failed-1" },
            { ...requestWithJob("failed"), id: "request-failed-2" },
            { ...requestWithJob("failed"), id: "request-failed-3" },
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 3,
            fulfilled: 0,
            failed: 3,
        });

        expect(mockListAdminRecipientIds).toHaveBeenCalledTimes(1);
        expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
        expect(mockNotifyAdminRequestFailed).toHaveBeenCalledTimes(3);
    });

    it("notifies all requesters and retries a rejected administrator lookup", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            { ...requestWithJob("failed"), id: "request-failed-1" },
            { ...requestWithJob("failed"), id: "request-failed-2" },
            { ...requestWithJob("failed"), id: "request-failed-3" },
        ]);
        mockListAdminRecipientIds
            .mockRejectedValueOnce(new Error("database unavailable"))
            .mockResolvedValue(["admin-1"]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 3,
            fulfilled: 0,
            failed: 3,
        });

        expect(mockNotifyRequestFailed).toHaveBeenCalledTimes(3);
        expect(mockListAdminRecipientIds).toHaveBeenCalledTimes(2);
        expect(mockNotifyAdminRequestFailed).toHaveBeenCalledTimes(2);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Administrator recipient lookup failed",
            expect.objectContaining({ userId: "user-1" }),
        );
    });

    it("notifies administrators with a fallback when username lookup fails", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);
        prisma.user.findUnique.mockRejectedValueOnce(
            new Error("database unavailable"),
        );

        await processRequestFulfillmentBatch();

        expect(mockNotifyRequestFailed).toHaveBeenCalledTimes(1);
        expect(mockNotifyAdminRequestFailed).toHaveBeenCalledWith(
            "admin-1",
            "A user",
            expect.objectContaining({ requestId: "request-failed" }),
            "download_failed",
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Requester username lookup failed",
            expect.objectContaining({ userId: "user-1" }),
        );
    });

    it("swallows requester and administrator notification failures", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);
        mockNotifyRequestFailed.mockRejectedValueOnce(new Error("offline"));
        mockNotifyAdminRequestFailed.mockRejectedValueOnce(
            new Error("offline"),
        );

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 1,
        });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "One or more request failure notifications failed",
            { requestId: "request-failed" },
        );
    });

    it("observes requester notification rejection while recipient lookup is pending", async () => {
        const notificationError = new Error("offline");
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);
        mockNotifyRequestFailed.mockImplementationOnce(
            () =>
                new Promise<void>((_resolve, reject) => {
                    process.nextTick(() => reject(notificationError));
                }),
        );
        prisma.user.findUnique.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    setImmediate(() => resolve({ username: "listener" }));
                }),
        );

        // Jest's own unhandled-rejection detection fails this test if the requester notification promise is left without a handler while recipient lookups are pending.
        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 1,
        });

        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "One or more request failure notifications failed",
            { requestId: "request-failed" },
        );
    });

    it("does not notify twice when another tick already claimed the transition", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("completed"),
        ]);
        prisma.musicRequest.updateMany.mockResolvedValueOnce({ count: 0 });

        await processRequestFulfillmentBatch();

        expect(mockNotifyRequestFulfilled).not.toHaveBeenCalled();
        expect(mockRecordMusicRequestAction).not.toHaveBeenCalled();
    });

    it("does not transition or notify a request re-linked to a new job", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            requestWithJob("failed"),
        ]);
        prisma.musicRequest.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: {
                id: "request-failed",
                status: "approved",
                downloadJobId: "job-failed",
            },
            data: { status: "failed" },
        });
        expect(mockNotifyRequestFailed).not.toHaveBeenCalled();
        expect(mockNotifyAdminRequestFailed).not.toHaveBeenCalled();
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
        prisma.downloadJob.findMany.mockImplementation(async () => [
            { id: "job-active", status: "processing" },
        ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1,
            fulfilled: 0,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).not.toHaveBeenCalled();
        expect(mockNotifyRequestFailed).not.toHaveBeenCalled();
    });

    it("scans past 200 active jobs to reconcile a terminal request on the next page", async () => {
        const firstPage = Array.from({ length: 200 }, (_, index) => ({
            ...requestWithJob("failed"),
            id: `request-active-${index.toString().padStart(3, "0")}`,
            downloadJobId: `job-active-${index}`,
        }));
        const terminal = {
            ...requestWithJob("completed"),
            id: "request-terminal",
        };
        prisma.musicRequest.findMany
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([terminal]);
        prisma.downloadJob.findMany
            .mockResolvedValueOnce(
                firstPage.map((request) => ({
                    id: request.downloadJobId,
                    status: "processing",
                })),
            )
            .mockResolvedValueOnce([
                { id: terminal.downloadJobId, status: "completed" },
            ]);

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 201,
            fulfilled: 1,
            failed: 0,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: {
                id: "request-terminal",
                status: "approved",
                downloadJobId: "job-completed",
            },
            data: { status: "fulfilled" },
        });
        expect(prisma.musicRequest.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                cursor: { id: "request-active-199" },
                skip: 1,
            }),
        );
    });

    it("stops scanning after five request pages", async () => {
        const page = Array.from({ length: 200 }, (_, index) => ({
            ...requestWithJob("failed"),
            id: `request-active-${index.toString().padStart(3, "0")}`,
            downloadJobId: `job-active-${index}`,
        }));
        prisma.musicRequest.findMany.mockResolvedValue(page);
        prisma.downloadJob.findMany.mockResolvedValue(
            page.map((request) => ({
                id: request.downloadJobId,
                status: "processing",
            })),
        );

        await expect(processRequestFulfillmentBatch()).resolves.toEqual({
            selected: 1000,
            fulfilled: 0,
            failed: 0,
        });

        expect(MAX_REQUEST_FULFILLMENT_PAGES).toBe(5);
        expect(prisma.musicRequest.findMany).toHaveBeenCalledTimes(5);
        expect(prisma.downloadJob.findMany).toHaveBeenCalledTimes(5);
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
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: 200,
        });
        expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
        expect(prisma.album.findMany).not.toHaveBeenCalled();
    });
});
