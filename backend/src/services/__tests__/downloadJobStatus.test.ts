const findUnique = jest.fn();
const update = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: { downloadJob: { findUnique, update } },
}));

import {
    ACTIVE_DOWNLOAD_JOB_STATUSES,
    completeDownloadJob,
    failDownloadJob,
    patchDownloadJobMetadata,
    patchDownloadJobMetadataFrom,
    TERMINAL_DOWNLOAD_JOB_STATUSES,
} from "../downloadJobStatus";

describe("download job status helpers", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        findUnique.mockResolvedValue({ metadata: {} });
        update.mockResolvedValue({});
    });

    it("merges an object patch over guarded current metadata", async () => {
        findUnique.mockResolvedValue({
            metadata: { retained: "value", replaced: "old" },
        });

        await patchDownloadJobMetadata("job-metadata", {
            replaced: "new",
            added: true,
        });

        expect(findUnique).toHaveBeenCalledWith({
            where: { id: "job-metadata" },
            select: { metadata: true },
        });
        expect(update).toHaveBeenCalledWith({
            where: { id: "job-metadata" },
            data: {
                metadata: {
                    retained: "value",
                    replaced: "new",
                    added: true,
                },
            },
        });
    });

    it("allows a function patch to drop metadata keys", async () => {
        findUnique.mockResolvedValue({
            metadata: { retained: "value", removed: true },
        });

        await patchDownloadJobMetadata("job-function", (current) => {
            const { removed: _removed, ...retained } = current;
            return { ...retained, derived: current.removed === true };
        });

        expect(update).toHaveBeenCalledWith({
            where: { id: "job-function" },
            data: {
                metadata: { retained: "value", derived: true },
            },
        });
    });

    it("persists extra fields in the same metadata update call", async () => {
        const completedAt = new Date("2026-08-25T12:00:00Z");

        await patchDownloadJobMetadata(
            "job-extra-data",
            { statusText: "Complete" },
            { status: "completed", completedAt, error: null },
        );

        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({
            where: { id: "job-extra-data" },
            data: {
                status: "completed",
                completedAt,
                error: null,
                metadata: { statusText: "Complete" },
            },
        });
    });

    it("merges over provided metadata without selecting and writes extra data once", async () => {
        const completedAt = new Date("2026-08-25T13:00:00Z");

        await patchDownloadJobMetadataFrom(
            { retained: "value", replaced: "old" },
            "job-from-snapshot",
            { replaced: "new", added: true },
            { status: "completed", completedAt },
        );

        expect(findUnique).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({
            where: { id: "job-from-snapshot" },
            data: {
                status: "completed",
                completedAt,
                metadata: {
                    retained: "value",
                    replaced: "new",
                    added: true,
                },
            },
        });
    });

    it.each([null, ["garbage"]])(
        "coerces non-object current metadata to an empty object: %p",
        async (metadata) => {
            findUnique.mockResolvedValue({ metadata });

            await patchDownloadJobMetadata("job-invalid", { valid: true });

            expect(update).toHaveBeenCalledWith({
                where: { id: "job-invalid" },
                data: { metadata: { valid: true } },
            });
        },
    );

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
