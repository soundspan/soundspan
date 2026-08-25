const update = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: { downloadJob: { update } },
}));

import {
    ACTIVE_DOWNLOAD_JOB_STATUSES,
    completeDownloadJob,
    failDownloadJob,
    TERMINAL_DOWNLOAD_JOB_STATUSES,
} from "../downloadJobStatus";

describe("download job status helpers", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        update.mockResolvedValue({});
    });

    it("persists a failed terminal status with the supplied completion time", async () => {
        const completedAt = new Date("2026-08-24T12:00:00Z");

        await failDownloadJob("job-1", "Download failed", { completedAt });

        expect(update).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                status: "failed",
                error: "Download failed",
                completedAt,
            },
        });
    });

    it("persists a completed status and caller-owned extra fields", async () => {
        const completedAt = new Date("2026-08-24T12:00:00Z");

        await completeDownloadJob("job-2", {
            completedAt,
            data: { error: null },
        });

        expect(update).toHaveBeenCalledWith({
            where: { id: "job-2" },
            data: { status: "completed", completedAt, error: null },
        });
    });

    it("exports the shared active and terminal memberships", () => {
        expect(ACTIVE_DOWNLOAD_JOB_STATUSES).toEqual(["pending", "processing"]);
        expect(TERMINAL_DOWNLOAD_JOB_STATUSES).toEqual([
            "completed",
            "failed",
            "exhausted",
        ]);
    });
});
