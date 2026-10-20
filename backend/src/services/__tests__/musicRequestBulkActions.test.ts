const mockApproveRequest = jest.fn();
const mockNotifyRequestDenied = jest.fn();
const mockRecordMusicRequestAction = jest.fn();
const mockLoggerError = jest.fn();
const mockResolveAlbumDownloadArtistName = jest.fn();

const prisma = {
    musicRequest: {
        count: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../musicRequestService", () => ({
    ONE_DAY_MS: 24 * 60 * 60 * 1000,
    approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
    normalizeOptionalText: (value?: string) => value?.trim() || undefined,
}));
jest.mock("../albumDownloadJobs", () => ({
    resolveAlbumDownloadArtistName: (...args: unknown[]) =>
        mockResolveAlbumDownloadArtistName(...args),
}));
jest.mock("../notificationService", () => ({
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
    notificationService: {
        notifyRequestDenied: (...args: unknown[]) =>
            mockNotifyRequestDenied(...args),
    },
}));
jest.mock("../../metrics", () => ({
    recordMusicRequestAction: (...args: unknown[]) =>
        mockRecordMusicRequestAction(...args),
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            error: (...args: unknown[]) => mockLoggerError(...args),
            warn: jest.fn(),
        }),
    },
}));

import {
    approvePendingRequestsForUser,
    denyStaleRequests,
    MAX_BULK_APPROVALS,
    MAX_BULK_STALE_DENIALS,
} from "../musicRequestBulkActions";

function pendingRow(index: number) {
    return {
        id: `request-${index}`,
        userId: "user-1",
        rgMbid: `mbid-${index}`,
        artistName: "Artist",
        albumTitle: `Album ${index}`,
        status: "pending",
    };
}

describe("music request bulk actions", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.musicRequest.findMany.mockResolvedValue([]);
        prisma.musicRequest.count.mockResolvedValue(0);
        prisma.musicRequest.updateMany.mockResolvedValue({ count: 1 });
        mockApproveRequest.mockResolvedValue({
            kind: "updated",
            request: { status: "approved" },
            dispatch: null,
        });
        mockNotifyRequestDenied.mockResolvedValue(undefined);
        mockResolveAlbumDownloadArtistName.mockImplementation(
            async (artistName: string) => `Canonical ${artistName}`,
        );
    });

    it("approves at most 25 pending requests oldest first and reports remaining", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce(
            Array.from({ length: 25 }, (_, index) => pendingRow(index)),
        );
        prisma.musicRequest.count.mockResolvedValueOnce(7);

        await expect(
            approvePendingRequestsForUser("admin-1", "user-1"),
        ).resolves.toMatchObject({
            approved: 25,
            fulfilled: 0,
            skipped: 0,
            failed: 0,
            remaining: 7,
        });

        expect(MAX_BULK_APPROVALS).toBe(25);
        expect(prisma.musicRequest.findMany).toHaveBeenCalledWith({
            where: { userId: "user-1", status: "pending" },
            select: { id: true, artistName: true },
            orderBy: { createdAt: "asc" },
            take: 25,
        });
        expect(mockApproveRequest).toHaveBeenCalledTimes(25);
    });

    it("resolves duplicate artist names once and passes them to approval", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            { ...pendingRow(1), artistName: "Shared Artist" },
            { ...pendingRow(2), artistName: "Shared Artist" },
            { ...pendingRow(3), artistName: "Other Artist" },
        ]);

        await approvePendingRequestsForUser("admin-1", "user-1");

        expect(mockResolveAlbumDownloadArtistName).toHaveBeenCalledTimes(2);
        expect(mockResolveAlbumDownloadArtistName).toHaveBeenCalledWith(
            "Shared Artist",
        );
        expect(mockResolveAlbumDownloadArtistName).toHaveBeenCalledWith(
            "Other Artist",
        );
        expect(mockApproveRequest).toHaveBeenNthCalledWith(
            1,
            "admin-1",
            "request-1",
            { verifiedArtistName: "Canonical Shared Artist" },
        );
        expect(mockApproveRequest).toHaveBeenNthCalledWith(
            2,
            "admin-1",
            "request-2",
            { verifiedArtistName: "Canonical Shared Artist" },
        );
        expect(mockApproveRequest).toHaveBeenNthCalledWith(
            3,
            "admin-1",
            "request-3",
            { verifiedArtistName: "Canonical Other Artist" },
        );
    });

    it("isolates per-row approval failures and returns dispatch work", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            pendingRow(1),
            pendingRow(2),
            pendingRow(3),
            pendingRow(4),
        ]);
        const dispatch = {
            jobId: "job-1",
            type: "album",
            mbid: "mbid-1",
            subject: "Artist - Album 1",
        };
        mockApproveRequest
            .mockResolvedValueOnce({
                kind: "updated",
                request: { status: "approved" },
                dispatch,
            })
            .mockResolvedValueOnce({
                kind: "updated",
                request: { status: "fulfilled" },
                dispatch: null,
            })
            .mockResolvedValueOnce({
                kind: "conflict",
                reason: "not_reviewable",
            })
            .mockRejectedValueOnce(new Error("lookup failed"));

        await expect(
            approvePendingRequestsForUser("admin-1", "user-1"),
        ).resolves.toEqual({
            approved: 1,
            fulfilled: 1,
            skipped: 1,
            failed: 1,
            remaining: 0,
            dispatches: [dispatch],
        });
    });

    it("denies at most 200 stale requests without setting a cooldown", async () => {
        jest.useFakeTimers({
            now: new Date("2026-10-19T12:00:00.000Z"),
        });
        prisma.musicRequest.findMany.mockResolvedValueOnce(
            Array.from({ length: 200 }, (_, index) => pendingRow(index)),
        );
        prisma.musicRequest.count.mockResolvedValueOnce(3);

        try {
            await expect(
                denyStaleRequests("admin-1", 30, " Too old "),
            ).resolves.toEqual({ denied: 200, remaining: 3 });

            expect(MAX_BULK_STALE_DENIALS).toBe(200);
            expect(prisma.musicRequest.findMany).toHaveBeenCalledWith({
                where: {
                    status: "pending",
                    createdAt: { lt: new Date("2026-09-19T12:00:00.000Z") },
                },
                select: {
                    id: true,
                    userId: true,
                    rgMbid: true,
                    artistName: true,
                    albumTitle: true,
                },
                orderBy: { createdAt: "asc" },
                take: 200,
            });
            expect(prisma.musicRequest.updateMany).toHaveBeenCalledTimes(200);
            expect(prisma.musicRequest.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "request-0", status: "pending" },
                data: {
                    status: "denied",
                    deniedReason: "Too old",
                    reviewedById: "admin-1",
                    reviewedAt: new Date("2026-10-19T12:00:00.000Z"),
                    cooldownUntil: null,
                },
            });
            expect(mockNotifyRequestDenied).toHaveBeenCalledTimes(200);
        } finally {
            jest.useRealTimers();
        }
    });

    it("logs and skips a stale row when its database update fails", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            pendingRow(1),
            pendingRow(2),
        ]);
        prisma.musicRequest.updateMany
            .mockRejectedValueOnce(new Error("database unavailable"))
            .mockResolvedValueOnce({ count: 1 });
        prisma.musicRequest.count.mockResolvedValueOnce(1);

        await expect(
            denyStaleRequests("admin-1", 30, "Too old"),
        ).resolves.toEqual({ denied: 1, remaining: 1 });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledTimes(2);
        expect(mockNotifyRequestDenied).toHaveBeenCalledTimes(1);
        expect(mockNotifyRequestDenied).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-2" }),
            "Too old",
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Bulk stale request denial failed",
            expect.objectContaining({ requestId: "request-1" }),
        );
    });
});
