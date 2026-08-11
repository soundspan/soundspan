const mockRunJob = jest.fn();
const mockRecoverActiveJobs = jest.fn();
const mockFinalizeQueueFailure = jest.fn();

jest.mock("../../../services/genericImportJobRunner", () => ({
    genericImportJobRunner: {
        runJob: mockRunJob,
        recoverActiveJobs: mockRecoverActiveJobs,
        finalizeQueueFailure: mockFinalizeQueueFailure,
    },
}));

import {
    finalizeGenericImportQueueFailure,
    processGenericImport,
} from "../genericImportProcessor";

describe("generic import queue processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRunJob.mockResolvedValue(undefined);
        mockRecoverActiveJobs.mockResolvedValue(0);
        mockFinalizeQueueFailure.mockResolvedValue(undefined);
    });

    it("executes a queued import and exposes whether Bull has retries left", async () => {
        const job = {
            id: "bull-job-1",
            name: "generic-import-run",
            data: { jobId: "persisted-job-1" },
            attemptsMade: 0,
            opts: { attempts: 3 },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processGenericImport(job);

        expect(mockRunJob).toHaveBeenCalledWith("persisted-job-1", {
            retryFailures: true,
            finalAttempt: false,
        });
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 100);
    });

    it("marks the last configured Bull attempt as final", async () => {
        const job = {
            id: "bull-job-final",
            name: "generic-import-run",
            data: { jobId: "persisted-job-final" },
            attemptsMade: 2,
            opts: { attempts: 3 },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processGenericImport(job);

        expect(mockRunJob).toHaveBeenCalledWith("persisted-job-final", {
            retryFailures: true,
            finalAttempt: true,
        });
    });

    it("rejects poison import payloads without invoking business logic", async () => {
        const job = {
            id: "bull-job-poison",
            name: "generic-import-run",
            data: { jobId: "", unexpected: "value" },
            attemptsMade: 0,
            opts: { attempts: 3 },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processGenericImport(job)).rejects.toThrow(
            "Invalid generic import queue payload",
        );
        expect(mockRunJob).not.toHaveBeenCalled();
    });

    it("runs the bounded persisted-job recovery sweep", async () => {
        mockRecoverActiveJobs.mockResolvedValueOnce(12);
        const job = {
            id: "recovery-job",
            name: "generic-import-recover",
            data: { trigger: "repeat" },
            attemptsMade: 0,
            opts: { attempts: 1 },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await processGenericImport(job);

        expect(mockRecoverActiveJobs).toHaveBeenCalledTimes(1);
        expect(mockRunJob).not.toHaveBeenCalled();
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 100);
    });

    it("rejects unknown queue job names", async () => {
        const job = {
            id: "unknown-job",
            name: "unexpected-import-operation",
            data: {},
            attemptsMade: 0,
            opts: { attempts: 1 },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processGenericImport(job)).rejects.toThrow(
            'Unsupported generic import queue job "unexpected-import-operation"',
        );
        expect(mockRunJob).not.toHaveBeenCalled();
        expect(mockRecoverActiveJobs).not.toHaveBeenCalled();
    });

    it("finalizes the persisted job only after Bull exhausts queue recovery", async () => {
        const error = new Error("job stalled more than allowable limit");
        const failedJob = {
            name: "generic-import-run",
            data: { jobId: "persisted-stalled-job" },
            getState: jest.fn().mockResolvedValue("failed"),
        } as any;
        const delayedJob = {
            name: "generic-import-run",
            data: { jobId: "persisted-retrying-job" },
            getState: jest.fn().mockResolvedValue("delayed"),
        } as any;

        await finalizeGenericImportQueueFailure(delayedJob, error);
        await finalizeGenericImportQueueFailure(failedJob, error);

        expect(mockFinalizeQueueFailure).toHaveBeenCalledTimes(1);
        expect(mockFinalizeQueueFailure).toHaveBeenCalledWith(
            "persisted-stalled-job",
            error,
        );
    });
});
