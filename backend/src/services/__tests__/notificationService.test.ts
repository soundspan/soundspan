import { prisma } from "../../utils/db";
import { notificationService } from "../notificationService";

jest.mock("../../utils/db", () => ({
    prisma: {
        notification: {
            create: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            updateMany: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
    },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

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
            })
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

        await notificationService.getForUser("u1", false);
        await notificationService.getUnreadCount("u1");
        await notificationService.markAsRead("n1", "u1");
        await notificationService.markAllAsRead("u1");
        await notificationService.clear("n1", "u1");
        await notificationService.clearAll("u1");

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
        await notificationService.notifyDownloadComplete("u1", "Album", "a1", "ar1");
        await notificationService.notifyDownloadFailed("u1", "Album", "oops");
        await notificationService.notifyPlaylistReady("u1", "Mix", "p1", 12);
        await notificationService.notifyImportComplete("u1", "Mix", "p1", 8, 10);
        await notificationService.notifySystem("u1", "Title", "Body");

        expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
            where: {
                cleared: true,
                createdAt: { lt: expect.any(Date) },
            },
        });
        expect(mockPrisma.notification.create).toHaveBeenCalledTimes(5);
    });
});
