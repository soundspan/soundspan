import { prisma } from "../../../utils/db";
import { notificationPolicyService } from "../../notificationPolicyService";
import { notificationService } from "../../notificationService";
import { DownloadJobEvents } from "../downloadJobEvents";
import { registerDownloadJobNotificationSubscriber } from "../downloadJobNotificationSubscriber";

jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: { findUnique: jest.fn(), update: jest.fn() },
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({ error: jest.fn() })),
    },
}));
jest.mock("../../notificationPolicyService", () => ({
    notificationPolicyService: { evaluateNotification: jest.fn() },
}));
jest.mock("../../notificationService", () => ({
    notificationService: {
        notifyDownloadComplete: jest.fn(),
        notifyDownloadFailed: jest.fn(),
    },
}));

describe("download-job notification subscriber", () => {
    const mockPolicy = notificationPolicyService as any;
    const mockNotifications = notificationService as any;
    const mockPrisma = prisma as any;
    let events: DownloadJobEvents;

    beforeEach(() => {
        jest.clearAllMocks();
        events = new DownloadJobEvents();
        registerDownloadJobNotificationSubscriber(events);
        mockPrisma.downloadJob.findUnique.mockResolvedValue({ metadata: {} });
        mockPrisma.downloadJob.update.mockResolvedValue({});
    });

    it("sends and records a policy-approved completion", async () => {
        mockPolicy.evaluateNotification.mockResolvedValue({
            shouldNotify: true,
            reason: "allowed",
        });

        await events.emit("download.completed", {
            jobId: "job-1",
            userId: "user-1",
            subject: "Artist - Album",
            artistId: "artist-1",
        });

        expect(mockPolicy.evaluateNotification).toHaveBeenCalledWith(
            "job-1",
            "complete",
        );
        expect(mockNotifications.notifyDownloadComplete).toHaveBeenCalledWith(
            "user-1",
            "Artist - Album",
            undefined,
            "artist-1",
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: {
                    metadata: expect.objectContaining({
                        notificationSent: true,
                    }),
                },
            }),
        );
    });

    it("suppresses an exhausted-job notification when policy denies it", async () => {
        mockPolicy.evaluateNotification.mockResolvedValue({
            shouldNotify: false,
            reason: "batch notification only",
        });

        await events.emit("download.exhausted", {
            jobId: "job-2",
            userId: "user-1",
            subject: "Artist - Album",
            reason: "no releases",
        });

        expect(mockPolicy.evaluateNotification).toHaveBeenCalledWith(
            "job-2",
            "failed",
        );
        expect(mockNotifications.notifyDownloadFailed).not.toHaveBeenCalled();
        expect(mockPrisma.downloadJob.update).not.toHaveBeenCalled();
    });

    it("returns the timeout-extension decision to the sweeper", async () => {
        mockPolicy.evaluateNotification.mockResolvedValue({
            shouldNotify: false,
            reason: "Still in retry window - extending timeout",
        });

        await expect(
            events.emit("download.timedOut", {
                jobId: "job-3",
                subject: "Artist - Album",
            }),
        ).resolves.toEqual([{ timeoutExtended: true }]);
    });
});
