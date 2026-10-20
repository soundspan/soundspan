import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    buildRequestNotificationMetadata,
    listAdminRecipientIds,
    MAX_ADMIN_NOTIFICATIONS,
    notificationService,
} from "../notificationService";

jest.mock("../../utils/db", () => ({
    prisma: {
        notification: {
            create: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            updateMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        user: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
    },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockLogger = logger as jest.Mocked<typeof logger>;

describe("notificationService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates notifications", async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "n1",
        });

        await expect(
            notificationService.create({
                userId: "u1",
                type: "system",
                title: "hello",
                message: "world",
            }),
        ).resolves.toEqual({ id: "n1" });

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
            data: {
                userId: "u1",
                type: "system",
                title: "hello",
                message: "world",
                metadata: undefined,
            },
        });
    });

    it("reads notification lists/counts and updates read/clear flags", async () => {
        (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.count as jest.Mock).mockResolvedValue(3);
        (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({
            count: 1,
        });

        await notificationService.getForUser("u1", true);
        await notificationService.getForUser("u1", false);
        await notificationService.getUnreadCount("u1");
        await notificationService.markAsRead("n1", "u1");
        await notificationService.markAllAsRead("u1");
        await notificationService.clear("n1", "u1");
        await notificationService.clearAll("u1");

        expect(mockPrisma.notification.findMany).toHaveBeenNthCalledWith(1, {
            where: { userId: "u1", cleared: false },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
            where: { userId: "u1", cleared: false, read: false },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        expect(mockPrisma.notification.count).toHaveBeenCalledWith({
            where: { userId: "u1", cleared: false, read: false },
        });
        expect(mockPrisma.notification.updateMany).toHaveBeenCalledTimes(4);
    });

    it("deletes old cleared notifications and exposes convenience helpers", async () => {
        (mockPrisma.notification.deleteMany as jest.Mock).mockResolvedValue({
            count: 2,
        });
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "n2",
        });

        await expect(notificationService.deleteOldCleared(7)).resolves.toEqual({
            count: 2,
        });
        await notificationService.notifyDownloadComplete(
            "u1",
            "Album",
            "a1",
            "ar1",
        );
        await notificationService.notifyDownloadFailed("u1", "Album", "oops");
        await notificationService.notifyPlaylistReady("u1", "Mix", "p1", 12);
        await notificationService.notifyImportComplete(
            "u1",
            "Mix",
            "p1",
            8,
            10,
        );
        await notificationService.notifySystem("u1", "Title", "Body");

        expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
            where: {
                cleared: true,
                createdAt: { lt: expect.any(Date) },
            },
        });
        expect(mockLogger.debug).toHaveBeenCalledWith(
            "[NOTIFICATION] Cleaned up 2 old notifications",
        );
        expect(mockPrisma.notification.create).toHaveBeenCalledTimes(5);
    });

    it("skips cleanup logging when no cleared notifications were deleted", async () => {
        (mockPrisma.notification.deleteMany as jest.Mock).mockResolvedValue({
            count: 0,
        });

        await expect(notificationService.deleteOldCleared()).resolves.toEqual({
            count: 0,
        });

        expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
            where: {
                cleared: true,
                createdAt: { lt: expect.any(Date) },
            },
        });
        expect(mockLogger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Cleaned up"),
        );
    });

    it("formats failed-download notifications without an error suffix when no error is provided", async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "n3",
        });

        await notificationService.notifyDownloadFailed("u1", "Album");

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
            data: {
                userId: "u1",
                type: "download_failed",
                title: "Download Failed",
                message: "Failed to download Album",
                metadata: {
                    subject: "Album",
                    error: undefined,
                },
            },
        });
    });

    it("does not interpolate failure details into user-visible download notifications", async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "n4",
        });

        await notificationService.notifyDownloadFailed(
            "u1",
            "Album",
            "raw upstream failure",
        );

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                message: "Failed to download Album",
            }),
        });
    });

    it("creates request lifecycle notifications with stable metadata", async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "request-notification",
        });
        const details = {
            requestId: "request-1",
            rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
        };

        await notificationService.notifyRequestSubmitted(
            "admin-1",
            "listener",
            details,
        );
        await notificationService.notifyRequestApproved("user-1", details);
        await notificationService.notifyRequestDenied(
            "user-1",
            details,
            "Not available",
        );
        await notificationService.notifyRequestFulfilled("user-1", details);
        await notificationService.notifyRequestFailed(
            "user-1",
            details,
            "download_failed",
        );
        await notificationService.notifyAdminRequestFailed(
            "admin-1",
            "listener",
            details,
            "download_stopped",
        );

        expect(mockPrisma.notification.create).toHaveBeenNthCalledWith(1, {
            data: {
                userId: "admin-1",
                type: "request_submitted",
                title: "listener requested Massive Attack — Mezzanine",
                message: "Review the pending album request.",
                metadata: details,
            },
        });
        expect(mockPrisma.notification.create).toHaveBeenNthCalledWith(3, {
            data: expect.objectContaining({
                userId: "user-1",
                type: "request_denied",
                message: "Your request was declined: Not available",
                metadata: details,
            }),
        });
        expect(mockPrisma.notification.create).toHaveBeenNthCalledWith(5, {
            data: expect.objectContaining({
                type: "request_failed",
                title: "Music Request Failed",
                message:
                    "Massive Attack — Mezzanine could not be downloaded. An admin can retry the download or decline the request.",
                metadata: details,
            }),
        });
        expect(mockPrisma.notification.create).toHaveBeenNthCalledWith(6, {
            data: {
                userId: "admin-1",
                type: "request_failed",
                title: "Request failed: Massive Attack — Mezzanine",
                message:
                    "listener's request was stopped before it finished. Retry or decline it on the Requests page.",
                metadata: details,
            },
        });
    });

    it("builds stable request metadata with an optional album link", () => {
        const request = {
            id: "request-1",
            rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
        };

        expect(buildRequestNotificationMetadata(request)).toEqual({
            requestId: "request-1",
            rgMbid: request.rgMbid,
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
        });
        expect(buildRequestNotificationMetadata(request, "album-1")).toEqual({
            requestId: "request-1",
            rgMbid: request.rgMbid,
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
            albumId: "album-1",
        });
    });

    it("lists a bounded set of administrator notification recipients", async () => {
        (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
            { id: "admin-1" },
            { id: "admin-2" },
        ]);

        await expect(listAdminRecipientIds()).resolves.toEqual([
            "admin-1",
            "admin-2",
        ]);

        expect(MAX_ADMIN_NOTIFICATIONS).toBe(200);
        expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
            where: { role: "admin" },
            select: { id: true },
            take: 200,
        });
    });

    it("explains when a request download was stopped", async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue({
            id: "stopped-notification",
        });
        const details = {
            requestId: "request-1",
            rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
        };

        await notificationService.notifyRequestFailed(
            "user-1",
            details,
            "download_stopped",
        );

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                type: "request_failed",
                title: "Music Request Failed",
                message:
                    "The download of Massive Attack — Mezzanine was stopped before it finished. An admin can retry it or decline the request.",
                metadata: details,
            },
        });
    });
});
