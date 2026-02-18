import { prisma } from "../../utils/db";
import { notificationPolicyService } from "../notificationPolicyService";

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
    },
}));

type JobOverrides = Partial<{
    id: string;
    userId: string;
    status: string;
    metadata: Record<string, unknown>;
    error: string | null;
    createdAt: Date;
}>;

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function createJob(overrides: JobOverrides = {}) {
    return {
        id: overrides.id ?? "job-1",
        userId: overrides.userId ?? "user-1",
        status: overrides.status ?? "processing",
        metadata: overrides.metadata ?? {},
        error: overrides.error ?? null,
        createdAt:
            overrides.createdAt ??
            new Date("2026-02-17T10:00:00.000Z"),
    } as any;
}

describe("notificationPolicyService", () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
    });

    it("returns no notification when the job cannot be found", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(null);

        await expect(
            notificationPolicyService.evaluateNotification("missing", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Job not found",
        });

        expect(mockPrisma.downloadJob.findFirst).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "discovery job",
            metadata: { downloadType: "discovery" },
        },
        {
            name: "spotify import job",
            metadata: { spotifyImportJobId: "import-1" },
        },
    ])(
        "suppresses notifications for $name",
        async ({ metadata }: { metadata: Record<string, unknown> }) => {
            (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
                createJob({ status: "completed", metadata })
            );

            const decision = await notificationPolicyService.evaluateNotification(
                "job-1",
                "complete"
            );

            expect(decision.shouldNotify).toBe(false);
            expect(decision.reason).toContain("batch notification only");
            expect(mockPrisma.downloadJob.findFirst).not.toHaveBeenCalled();
        }
    );

    it("suppresses when a notification was already sent for the same job", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "completed",
                metadata: { notificationSent: true },
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "complete")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Notification already sent for this job",
        });

        expect(mockPrisma.downloadJob.findFirst).not.toHaveBeenCalled();
    });

    it("notifies once for a completed job when no prior notification exists", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "completed",
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            })
        );

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "complete"
        );

        expect(decision).toEqual({
            shouldNotify: true,
            reason: "Download completed successfully",
            notificationType: "download_complete",
        });
        expect(mockPrisma.downloadJob.findFirst).toHaveBeenCalledWith({
            where: {
                id: { not: "job-1" },
                userId: "user-1",
                status: { in: ["completed", "failed", "exhausted"] },
            },
        });
    });

    it("suppresses duplicate completed notifications for the same normalized album key", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "completed",
                metadata: {
                    artistName: "  Radiohead  ",
                    albumTitle: " OK Computer ",
                },
            })
        );
        (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(
            createJob({
                id: "job-2",
                status: "failed",
                metadata: {
                    artistName: "radiohead",
                    albumTitle: "ok computer",
                    notificationSent: true,
                },
            })
        );

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "complete"
        );

        expect(decision.shouldNotify).toBe(false);
        expect(decision.reason).toBe(
            "Another job for same album already sent notification"
        );
    });

    it("rejects non-complete events for completed jobs", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({ status: "completed" })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Invalid event type for completed job",
        });

        expect(mockPrisma.downloadJob.findFirst).not.toHaveBeenCalled();
    });

    it("suppresses processing completion events until status becomes completed", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({ status: "processing" })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "complete")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Job still processing - wait for status update to completed",
        });
    });

    it("suppresses retry events during the active retry window", async () => {
        const now = new Date("2026-02-17T11:00:00.000Z").getTime();
        jest.spyOn(Date, "now").mockReturnValue(now);
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "processing",
                metadata: {
                    startedAt: new Date(
                        "2026-02-17T10:40:00.000Z"
                    ).toISOString(),
                    retryWindowMinutes: 30,
                },
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "retry")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Job in active retry window - suppressing notification",
        });
    });

    it("keeps suppressing failed processing jobs when the retry window expires", async () => {
        const now = new Date("2026-02-17T11:00:00.000Z").getTime();
        jest.spyOn(Date, "now").mockReturnValue(now);
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "processing",
                metadata: {
                    startedAt: new Date(
                        "2026-02-17T09:59:00.000Z"
                    ).toISOString(),
                    retryWindowMinutes: 30,
                },
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Retry window expired but job still processing - extending timeout",
        });
    });

    it("extends processing timeout while still in retry window", async () => {
        const now = new Date("2026-02-17T11:00:00.000Z").getTime();
        jest.spyOn(Date, "now").mockReturnValue(now);
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "processing",
                metadata: {
                    startedAt: new Date(
                        "2026-02-17T10:50:00.000Z"
                    ).toISOString(),
                    retryWindowMinutes: 30,
                },
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "timeout")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Still in retry window - extending timeout",
        });
    });

    it("flags processing timeout events when retry window has elapsed", async () => {
        const now = new Date("2026-02-17T11:00:00.000Z").getTime();
        jest.spyOn(Date, "now").mockReturnValue(now);
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "processing",
                createdAt: new Date("2026-02-17T09:00:00.000Z"),
                metadata: {},
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "timeout")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Timeout expired - caller should mark as failed",
        });
    });

    it("rejects invalid events for failed jobs", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({ status: "failed" })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "retry")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Invalid event type for failed job",
        });
    });

    it("always notifies for critical failures", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "failed",
                error: "permission denied while moving file",
                metadata: {},
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "failed")
        ).resolves.toEqual({
            shouldNotify: true,
            reason: "Critical error requires user intervention",
            notificationType: "download_failed",
        });
    });

    it("suppresses transient failed jobs by policy", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "failed",
                error: "no sources found after lookup",
                metadata: {},
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Transient failure - suppressed (may succeed on retry)",
        });
    });

    it("notifies for exhausted jobs with permanent failures", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "exhausted",
                error: "all releases exhausted across indexers",
                metadata: {},
            })
        );

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "timeout")
        ).resolves.toEqual({
            shouldNotify: true,
            reason: "Permanent failure after retries exhausted",
            notificationType: "download_failed",
        });
    });

    it("suppresses failed notifications when another notified job already exists", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            createJob({
                status: "failed",
                error: "all releases exhausted",
                metadata: {
                    artistName: "Portishead",
                    albumTitle: "Dummy",
                },
            })
        );
        (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(
            createJob({
                id: "job-3",
                status: "completed",
                metadata: {
                    artistName: "portishead",
                    albumTitle: "dummy",
                    notificationSent: true,
                },
            })
        );

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "failed"
        );

        expect(decision).toEqual({
            shouldNotify: false,
            reason: "Another job for same album already sent notification",
        });
    });

    it("suppresses pending jobs and unknown statuses", async () => {
        (mockPrisma.downloadJob.findUnique as jest.Mock)
            .mockResolvedValueOnce(createJob({ status: "pending" }))
            .mockResolvedValueOnce(createJob({ status: "mystery" }));

        await expect(
            notificationPolicyService.evaluateNotification("job-1", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Job not started yet",
        });

        await expect(
            notificationPolicyService.evaluateNotification("job-2", "failed")
        ).resolves.toEqual({
            shouldNotify: false,
            reason: "Unknown status: mystery",
        });
    });

    it("exposes static policy defaults", () => {
        expect(notificationPolicyService.getConfig()).toEqual({
            retryWindowMinutes: 30,
            suppressTransientFailures: true,
        });
    });
});
