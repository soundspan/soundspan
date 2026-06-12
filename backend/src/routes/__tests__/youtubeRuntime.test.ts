jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/youtubeDownload", () => ({
    youtubeDownloadService: {
        getVideoInfo: jest.fn(),
        getStreamProxy: jest.fn(),
        startDownload: jest.fn(),
        getDownloadJobStatus: jest.fn(),
    },
}));

const scanQueue = {
    add: jest.fn(),
};
jest.mock("../../workers/queues", () => ({
    scanQueue,
}));

import router from "../youtube";
import { youtubeDownloadService } from "../../services/youtubeDownload";

const mockGetVideoInfo = youtubeDownloadService.getVideoInfo as jest.Mock;
const mockStartDownload = youtubeDownloadService.startDownload as jest.Mock;
const mockGetDownloadJobStatus =
    youtubeDownloadService.getDownloadJobStatus as jest.Mock;

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

function sidecarError(status: number, detail?: string) {
    const err: any = new Error(`sidecar ${status}`);
    err.response = { status, data: detail ? { detail } : {} };
    return err;
}

describe("youtube routes runtime", () => {
    const infoHandler = getHandler("/info", "get");
    const downloadHandler = getHandler("/download", "post");
    const statusHandler = getHandler("/download/:jobId", "get");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("GET /info", () => {
        it("returns 400 when url is missing", async () => {
            const req = { query: {} } as any;
            const res = createRes();

            await infoHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(mockGetVideoInfo).not.toHaveBeenCalled();
        });

        it("returns 400 when the sidecar rejects the url", async () => {
            mockGetVideoInfo.mockRejectedValue(
                sidecarError(400, "Could not extract video ID")
            );
            const req = { query: { url: "https://example.com/nope" } } as any;
            const res = createRes();

            await infoHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({
                error: "Could not extract video ID",
            });
        });

        it("returns 404 when the video is not found", async () => {
            mockGetVideoInfo.mockRejectedValue(sidecarError(404));
            const req = {
                query: { url: "https://youtu.be/dQw4w9WgXcQ" },
            } as any;
            const res = createRes();

            await infoHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Video not found" });
        });

        it("returns 502 when the sidecar is unreachable", async () => {
            mockGetVideoInfo.mockRejectedValue(new Error("ECONNREFUSED"));
            const req = {
                query: { url: "https://youtu.be/dQw4w9WgXcQ" },
            } as any;
            const res = createRes();

            await infoHandler(req, res);

            expect(res.statusCode).toBe(502);
            expect(res.body).toEqual({ error: "Failed to fetch video info" });
        });

        it("returns video metadata on success", async () => {
            mockGetVideoInfo.mockResolvedValue({
                videoId: "dQw4w9WgXcQ",
                title: "Test Video",
                uploader: "Test Channel",
                duration: 212,
                thumbnail: "https://img.example/t.jpg",
                uploadDate: "20091025",
                audioFormat: "webm",
            });
            const req = {
                query: { url: "https://youtu.be/dQw4w9WgXcQ" },
            } as any;
            const res = createRes();

            await infoHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                videoId: "dQw4w9WgXcQ",
                audioFormat: "webm",
            });
        });
    });

    describe("POST /download", () => {
        it("starts a download job and returns 202 with the jobId", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-accept",
                status: "queued",
            });
            const req = {
                body: { videoId: "dQw4w9WgXcQ", format: "mp3", quality: "HIGH" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);

            expect(mockStartDownload).toHaveBeenCalledWith(
                "dQw4w9WgXcQ",
                "mp3",
                "HIGH"
            );
            expect(res.statusCode).toBe(202);
            expect(res.body).toMatchObject({ jobId: "job-accept" });
            // Scan is enqueued by the status poller, not at submit time
            expect(scanQueue.add).not.toHaveBeenCalled();
        });

        it("returns 400 for an invalid body", async () => {
            const req = {
                body: { videoId: "", format: "wav" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(mockStartDownload).not.toHaveBeenCalled();
        });

        it("returns 502 when the sidecar is unreachable", async () => {
            mockStartDownload.mockRejectedValue(new Error("ECONNREFUSED"));
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);

            expect(res.statusCode).toBe(502);
        });
    });

    describe("GET /download/:jobId", () => {
        it("proxies in-progress job status", async () => {
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-progress",
                status: "downloading",
                progressPct: 42.5,
                filePath: null,
                error: null,
            });
            const req = {
                params: { jobId: "job-progress" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await statusHandler(req, res);

            expect(mockGetDownloadJobStatus).toHaveBeenCalledWith(
                "job-progress"
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                jobId: "job-progress",
                status: "downloading",
                progressPct: 42.5,
            });
            expect(scanQueue.add).not.toHaveBeenCalled();
        });

        it("returns 404 for an unknown job", async () => {
            mockGetDownloadJobStatus.mockRejectedValue(sidecarError(404));
            const req = {
                params: { jobId: "job-missing" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await statusHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Download job not found" });
        });

        it("enqueues the library scan exactly once across repeated completed polls", async () => {
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-complete",
                status: "completed",
                progressPct: 100,
                filePath: "/music/YouTube Downloads/Set [dQw4w9WgXcQ].mp3",
                error: null,
            });
            scanQueue.add.mockResolvedValue(undefined);

            for (let poll = 0; poll < 3; poll++) {
                const req = {
                    params: { jobId: "job-complete" },
                    user: { id: "user-1" },
                } as any;
                const res = createRes();

                await statusHandler(req, res);

                expect(res.statusCode).toBe(200);
                expect(res.body).toMatchObject({ status: "completed" });
            }

            expect(scanQueue.add).toHaveBeenCalledTimes(1);
            expect(scanQueue.add).toHaveBeenCalledWith("scan", {
                userId: "user-1",
                source: "youtube-download",
            });
        });

        it("returns failed job status without enqueueing a scan", async () => {
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-failed",
                status: "failed",
                progressPct: 12,
                filePath: null,
                error: "Video unavailable",
            });
            const req = {
                params: { jobId: "job-failed" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await statusHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                status: "failed",
                error: "Video unavailable",
            });
            expect(scanQueue.add).not.toHaveBeenCalled();
        });
    });
});
