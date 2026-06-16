jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// config transitively constructs the Prisma client; the watcher under test
// only needs the sidecar base URL for the singleton's axios instance.
jest.mock("../../config", () => ({
    config: {
        ytmusicStreamer: { url: "http://127.0.0.1:8586" },
    },
}));

import {
    watchYouTubeDownloadJobUntilTerminal,
    type YtDownloadJobStatus,
} from "../youtubeDownload";

function jobStatus(
    overrides: Partial<YtDownloadJobStatus>
): YtDownloadJobStatus {
    return {
        jobId: "job-1",
        videoId: "dQw4w9WgXcQ",
        status: "downloading",
        progressPct: 0,
        filePath: null,
        title: "",
        error: null,
        alreadyExisted: false,
        source: null,
        createdAt: null,
        ...overrides,
    };
}

function sidecarError(status: number) {
    const err: any = new Error(`sidecar ${status}`);
    err.response = { status };
    return err;
}

const immediateSleep = async () => undefined;

describe("watchYouTubeDownloadJobUntilTerminal", () => {
    it("polls until the job completes and resolves 'completed'", async () => {
        const getStatus = jest
            .fn()
            .mockResolvedValueOnce(jobStatus({ status: "downloading" }))
            .mockResolvedValueOnce(jobStatus({ status: "processing" }))
            .mockResolvedValueOnce(jobStatus({ status: "completed" }));

        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            "job-1",
            getStatus,
            { intervalMs: 1, sleep: immediateSleep }
        );

        expect(outcome).toBe("completed");
        expect(getStatus).toHaveBeenCalledTimes(3);
        expect(getStatus).toHaveBeenCalledWith("job-1");
    });

    it("resolves 'failed' when the job fails", async () => {
        const getStatus = jest
            .fn()
            .mockResolvedValueOnce(jobStatus({ status: "queued" }))
            .mockResolvedValueOnce(
                jobStatus({ status: "failed", error: "Video unavailable" })
            );

        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            "job-1",
            getStatus,
            { intervalMs: 1, sleep: immediateSleep }
        );

        expect(outcome).toBe("failed");
    });

    it("resolves 'gone' when the sidecar no longer knows the job", async () => {
        const getStatus = jest.fn().mockRejectedValue(sidecarError(404));

        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            "job-1",
            getStatus,
            { intervalMs: 1, sleep: immediateSleep }
        );

        expect(outcome).toBe("gone");
        expect(getStatus).toHaveBeenCalledTimes(1);
    });

    it("tolerates transient errors and keeps polling", async () => {
        const getStatus = jest
            .fn()
            .mockRejectedValueOnce(new Error("ECONNREFUSED"))
            .mockResolvedValueOnce(jobStatus({ status: "completed" }));

        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            "job-1",
            getStatus,
            { intervalMs: 1, sleep: immediateSleep }
        );

        expect(outcome).toBe("completed");
        expect(getStatus).toHaveBeenCalledTimes(2);
    });

    it("resolves 'timeout' when the deadline elapses", async () => {
        const getStatus = jest
            .fn()
            .mockResolvedValue(jobStatus({ status: "downloading" }));

        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            "job-1",
            getStatus,
            { intervalMs: 10, timeoutMs: 25, sleep: immediateSleep }
        );

        expect(outcome).toBe("timeout");
        expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
});
