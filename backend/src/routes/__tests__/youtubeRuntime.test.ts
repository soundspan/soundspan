jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

jest.mock("../../services/youtubeDownload", () => ({
    youtubeDownloadService: {
        getVideoInfo: jest.fn(),
        getPlaylistInfo: jest.fn(),
        getStreamProxy: jest.fn(),
        startDownload: jest.fn(),
        getDownloadJobStatus: jest.fn(),
        listDownloads: jest.fn(),
        cancelDownload: jest.fn(),
    },
    watchYouTubeDownloadJobUntilTerminal: jest.fn(),
}));

const scanQueue = {
    add: jest.fn(),
};
jest.mock("../../workers/queues", () => ({
    scanQueue,
}));

import router, { rememberBoundedJobId } from "../youtube";
import { requireAdmin } from "../../middleware/auth";
import {
    youtubeDownloadService,
    watchYouTubeDownloadJobUntilTerminal,
} from "../../services/youtubeDownload";

const mockGetVideoInfo = youtubeDownloadService.getVideoInfo as jest.Mock;
const mockGetPlaylistInfo = youtubeDownloadService.getPlaylistInfo as jest.Mock;
const mockGetStreamProxy = youtubeDownloadService.getStreamProxy as jest.Mock;
const mockStartDownload = youtubeDownloadService.startDownload as jest.Mock;
const mockGetDownloadJobStatus =
    youtubeDownloadService.getDownloadJobStatus as jest.Mock;
const mockListDownloads = youtubeDownloadService.listDownloads as jest.Mock;
const mockCancelDownload = youtubeDownloadService.cancelDownload as jest.Mock;
const mockWatchJob = watchYouTubeDownloadJobUntilTerminal as jest.Mock;

/** Flush fire-and-forget promise chains started by the handlers. */
async function flushAsync() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

/** Bull job options every coalesced YouTube-download scan is enqueued with. */
const COALESCED_SCAN_JOB_OPTIONS = expect.objectContaining({
    jobId: "youtube-download-library-scan",
    removeOnComplete: true,
    removeOnFail: true,
});

/**
 * Minimal stand-in for the Bull job returned by scanQueue.add: exposes the
 * getState()/finished() surface the coalescing logic uses, with test hooks
 * to move the job through waiting → active → completed.
 */
function createFakeBullJob() {
    let state = "waiting";
    let resolveFinished!: (value?: unknown) => void;
    const finishedPromise = new Promise((resolve) => {
        resolveFinished = resolve;
    });
    return {
        getState: jest.fn(async () => state),
        finished: jest.fn(() => finishedPromise),
        setActive() {
            state = "active";
        },
        complete() {
            state = "completed";
            resolveFinished(undefined);
        },
    };
}

function findRouteLayer(path: string, method: "get" | "post" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer;
}

function getRouteMiddlewares(path: string, method: "get" | "post" | "delete") {
    return findRouteLayer(path, method).route.stack.map(
        (entry: any) => entry.handle,
    );
}

function getHandler(path: string, method: "get" | "post" | "delete") {
    const layer = findRouteLayer(path, method);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const headers: Record<string, string> = {};
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        headersSent: false,
        headers,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: string) {
            headers[key] = value;
            return res;
        }),
        end: jest.fn(),
        on: jest.fn(),
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
    const playlistInfoHandler = getHandler("/playlist-info", "get");
    const streamHandler = getHandler("/stream/:videoId", "get");
    const downloadHandler = getHandler("/download", "post");
    const statusHandler = getHandler("/download/:jobId", "get");
    const downloadsListHandler = getHandler("/downloads", "get");
    const cancelHandler = getHandler("/downloads/:jobId", "delete");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
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
                sidecarError(400, "Could not extract video ID"),
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

    describe("GET /playlist-info", () => {
        it("returns 400 when url is missing", async () => {
            const req = { query: {} } as any;
            const res = createRes();

            await playlistInfoHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(mockGetPlaylistInfo).not.toHaveBeenCalled();
        });

        it("returns the enumerated playlist on success", async () => {
            mockGetPlaylistInfo.mockResolvedValue({
                kind: "playlist",
                playlistId: "PL-abc123",
                channel: null,
                sourceUrl: "https://www.youtube.com/playlist?list=PL-abc123",
                title: "My Set",
                uploader: "DJ",
                totalCount: 2,
                truncated: false,
                count: 2,
                entries: [
                    {
                        videoId: "aaaaaaaaaaa",
                        title: "One",
                        uploader: "DJ",
                        duration: 100,
                    },
                    {
                        videoId: "bbbbbbbbbbb",
                        title: "Two",
                        uploader: "DJ",
                        duration: 200,
                    },
                ],
            });
            const req = {
                query: {
                    url: "https://www.youtube.com/playlist?list=PL-abc123",
                },
            } as any;
            const res = createRes();

            await playlistInfoHandler(req, res);

            expect(mockGetPlaylistInfo).toHaveBeenCalledWith(
                "https://www.youtube.com/playlist?list=PL-abc123",
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                kind: "playlist",
                count: 2,
                truncated: false,
            });
        });

        it("maps a sidecar 422 (single video / mix) to 422 with its detail", async () => {
            mockGetPlaylistInfo.mockRejectedValue(
                sidecarError(
                    422,
                    "This is an auto-generated YouTube mix/radio, which can't be downloaded as a set.",
                ),
            );
            const req = {
                query: {
                    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ",
                },
            } as any;
            const res = createRes();

            await playlistInfoHandler(req, res);

            expect(res.statusCode).toBe(422);
            expect(res.body.error).toMatch(/mix\/radio/);
        });

        it("returns 502 when the sidecar is unreachable", async () => {
            mockGetPlaylistInfo.mockRejectedValue(new Error("ECONNREFUSED"));
            const req = {
                query: {
                    url: "https://www.youtube.com/playlist?list=PL-abc123",
                },
            } as any;
            const res = createRes();

            await playlistInfoHandler(req, res);

            expect(res.statusCode).toBe(502);
            expect(res.body).toEqual({
                error: "Failed to enumerate playlist or channel",
            });
        });
    });

    describe("GET /stream/:videoId", () => {
        it("returns a canonical 451 error for age-restricted content", async () => {
            mockGetStreamProxy.mockRejectedValueOnce(sidecarError(451));
            const req = {
                params: { videoId: "age-gated-video" },
                query: {},
                headers: {},
            } as any;
            const res = createRes();

            await streamHandler(req, res);

            expect(res.statusCode).toBe(451);
            expect(res.body).toEqual({
                error: "This content requires age verification and cannot be streamed.",
            });
        });

        it("destroys the upstream stream when the client disconnects", async () => {
            const data = {
                pipe: jest.fn(),
                on: jest.fn(),
                destroy: jest.fn(),
                destroyed: false,
            };
            mockGetStreamProxy.mockResolvedValueOnce({
                status: 200,
                headers: {},
                data,
            });
            const req = {
                params: { videoId: "video-1" },
                query: {},
                headers: {},
            } as any;
            const res = createRes();

            await streamHandler(req, res);

            const closeHandler = res.on.mock.calls.find(
                ([event]: [string]) => event === "close",
            )?.[1];
            expect(closeHandler).toEqual(expect.any(Function));
            closeHandler();
            expect(data.destroy).toHaveBeenCalledTimes(1);

            data.destroyed = true;
            closeHandler();
            expect(data.destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe("POST /download", () => {
        it("starts a download job, returns 202, and watches it server-side", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-accept",
                status: "queued",
            });
            mockWatchJob.mockReturnValue(new Promise(() => undefined));
            const req = {
                body: {
                    videoId: "dQw4w9WgXcQ",
                    format: "mp3",
                    quality: "HIGH",
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);
            await flushAsync();

            expect(mockStartDownload).toHaveBeenCalledWith(
                "dQw4w9WgXcQ",
                "mp3",
                "HIGH",
                undefined,
                undefined,
            );
            expect(res.statusCode).toBe(202);
            expect(res.body).toMatchObject({ jobId: "job-accept" });
            // The server-side watcher owns the scan trigger; the job is
            // still running so nothing is enqueued yet.
            expect(mockWatchJob).toHaveBeenCalledWith(
                "job-accept",
                expect.any(Function),
                expect.objectContaining({ sleep: expect.any(Function) }),
            );
            expect(scanQueue.add).not.toHaveBeenCalled();
        });

        it("reuses one watcher and one timer when the same job starts twice", async () => {
            jest.useFakeTimers({ timerLimit: 100 });
            mockStartDownload.mockResolvedValue({
                jobId: "job-duplicate",
                status: "queued",
            });
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-duplicate",
                status: "downloading",
            });
            mockWatchJob.mockImplementation(
                async (_jobId, getStatus, options) => {
                    await getStatus("job-duplicate");
                    await options.sleep(5_000);
                    return "failed";
                },
            );
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;

            await downloadHandler(req, createRes());
            await downloadHandler(req, createRes());
            await Promise.resolve();

            expect(mockWatchJob).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(1);

            await jest.advanceTimersByTimeAsync(5_000);
            expect(jest.getTimerCount()).toBe(0);
        });

        it("removes a watcher when the job reaches a terminal state", async () => {
            jest.useFakeTimers({ timerLimit: 100 });
            mockStartDownload.mockResolvedValue({
                jobId: "job-terminal",
                status: "queued",
            });
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-terminal",
                status: "downloading",
            });
            mockWatchJob.mockImplementation(
                async (_jobId, getStatus, options) => {
                    await getStatus("job-terminal");
                    await options.sleep(5_000);
                    return "failed";
                },
            );
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;

            await downloadHandler(req, createRes());
            await Promise.resolve();
            expect(mockWatchJob).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(5_000);
            await downloadHandler(req, createRes());
            await Promise.resolve();

            expect(mockWatchJob).toHaveBeenCalledTimes(2);
            expect(jest.getTimerCount()).toBe(1);

            await jest.advanceTimersByTimeAsync(5_000);
            expect(jest.getTimerCount()).toBe(0);
        });

        it("enqueues the scan when the server-side watcher sees completion", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-watched",
                status: "queued",
            });
            mockWatchJob.mockResolvedValue("completed");
            scanQueue.add.mockResolvedValue(undefined);
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);
            await flushAsync();

            expect(scanQueue.add).toHaveBeenCalledTimes(1);
            expect(scanQueue.add).toHaveBeenCalledWith(
                "scan",
                {
                    userId: "user-1",
                    source: "youtube-download",
                },
                COALESCED_SCAN_JOB_OPTIONS,
            );

            // A later completed status poll must not enqueue a second scan.
            mockGetDownloadJobStatus.mockResolvedValue({
                jobId: "job-watched",
                status: "completed",
                progressPct: 100,
                filePath: "/music/YouTube Downloads/x.mp3",
                error: null,
            });
            const pollRes = createRes();
            await statusHandler(
                {
                    params: { jobId: "job-watched" },
                    user: { id: "user-1" },
                } as any,
                pollRes,
            );
            expect(pollRes.statusCode).toBe(200);
            expect(scanQueue.add).toHaveBeenCalledTimes(1);
        });

        it("enqueues a scan immediately when the file already existed", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-existing",
                status: "completed",
            });
            scanQueue.add.mockResolvedValue(undefined);
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);
            await flushAsync();

            expect(res.statusCode).toBe(202);
            // The on-disk file may never have been imported (failed scan,
            // out-of-band placement), so completion always queues a scan.
            expect(scanQueue.add).toHaveBeenCalledTimes(1);
            expect(scanQueue.add).toHaveBeenCalledWith(
                "scan",
                {
                    userId: "user-1",
                    source: "youtube-download",
                },
                COALESCED_SCAN_JOB_OPTIONS,
            );
            expect(mockWatchJob).not.toHaveBeenCalled();
        });

        it("does not enqueue a scan when the watcher reports failure", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-watch-fail",
                status: "queued",
            });
            mockWatchJob.mockResolvedValue("failed");
            const req = {
                body: { videoId: "dQw4w9WgXcQ" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);
            await flushAsync();

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

        it.each([
            ["too short", "abc"],
            ["too long", "dQw4w9WgXcQdQw4w9WgXcQ"],
            ["invalid characters", "dQw4w9WgXc!"],
        ])(
            "returns 400 for a malformed videoId (%s) without calling the sidecar",
            async (_label, videoId) => {
                const req = {
                    body: { videoId },
                    user: { id: "user-1" },
                } as any;
                const res = createRes();

                await downloadHandler(req, res);

                expect(res.statusCode).toBe(400);
                expect(mockStartDownload).not.toHaveBeenCalled();
            },
        );

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
                "job-progress",
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
            expect(scanQueue.add).toHaveBeenCalledWith(
                "scan",
                {
                    userId: "user-1",
                    source: "youtube-download",
                },
                COALESCED_SCAN_JOB_OPTIONS,
            );
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

        it("passes the bulk-run source label through to the sidecar", async () => {
            mockStartDownload.mockResolvedValue({
                jobId: "job-src",
                status: "queued",
            });
            mockWatchJob.mockReturnValue(new Promise(() => undefined));
            const req = {
                body: {
                    videoId: "dQw4w9WgXcQ",
                    format: "opus",
                    quality: "HIGH",
                    source: "Book Club Radio",
                    sourceKind: "channel",
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await downloadHandler(req, res);
            await flushAsync();

            expect(mockStartDownload).toHaveBeenCalledWith(
                "dQw4w9WgXcQ",
                "opus",
                "HIGH",
                "Book Club Radio",
                "channel",
            );
        });
    });

    describe("GET /downloads", () => {
        it("returns the list of jobs from the sidecar", async () => {
            mockListDownloads.mockResolvedValue([
                {
                    jobId: "j1",
                    videoId: "v1",
                    status: "downloading",
                    progressPct: 40,
                    source: "Book Club Radio",
                    createdAt: 1000,
                },
            ]);
            const res = createRes();

            await downloadsListHandler({} as any, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                jobs: [
                    expect.objectContaining({
                        jobId: "j1",
                        source: "Book Club Radio",
                    }),
                ],
            });
        });

        it("returns 502 when the sidecar is unreachable", async () => {
            mockListDownloads.mockRejectedValue(new Error("ECONNREFUSED"));
            const res = createRes();

            await downloadsListHandler({} as any, res);

            expect(res.statusCode).toBe(502);
        });
    });

    describe("DELETE /downloads/:jobId", () => {
        it("cancels a job and returns the updated status", async () => {
            mockCancelDownload.mockResolvedValue({
                jobId: "j1",
                videoId: "v1",
                status: "cancelled",
            });
            const req = { params: { jobId: "j1" } } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(mockCancelDownload).toHaveBeenCalledWith("j1");
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ status: "cancelled" });
        });

        it("returns 404 when the job is unknown", async () => {
            mockCancelDownload.mockRejectedValue(sidecarError(404));
            const req = { params: { jobId: "missing" } } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Download job not found" });
        });
    });

    describe("admin gating", () => {
        it.each([
            ["POST /download", "/download", "post"],
            ["GET /download/:jobId", "/download/:jobId", "get"],
            ["GET /downloads", "/downloads", "get"],
            ["DELETE /downloads/:jobId", "/downloads/:jobId", "delete"],
        ] as const)("requires admin for %s", (_label, path, method) => {
            expect(getRouteMiddlewares(path, method)).toContain(requireAdmin);
        });

        it.each([
            ["GET /info", "/info", "get"],
            ["GET /playlist-info", "/playlist-info", "get"],
            ["GET /stream/:videoId", "/stream/:videoId", "get"],
        ] as const)(
            "keeps %s available to all authenticated users",
            (_label, path, method) => {
                expect(getRouteMiddlewares(path, method)).not.toContain(
                    requireAdmin,
                );
            },
        );
    });

    describe("library scan coalescing", () => {
        it("coalesces completions while a scan is still queued into one scan job", async () => {
            const bullJob = createFakeBullJob();
            scanQueue.add.mockResolvedValue(bullJob);
            mockGetDownloadJobStatus.mockImplementation(async (id: string) => ({
                jobId: id,
                status: "completed",
                progressPct: 100,
                filePath: `/music/YouTube Downloads/${id}.mp3`,
                error: null,
            }));

            for (const jobId of ["job-co-q1", "job-co-q2", "job-co-q3"]) {
                const res = createRes();
                await statusHandler(
                    { params: { jobId }, user: { id: "user-1" } } as any,
                    res,
                );
                expect(res.statusCode).toBe(200);
            }

            // One queued scan covers every download that completed before it
            // started; the later completions must not add more jobs.
            expect(scanQueue.add).toHaveBeenCalledTimes(1);
            expect(scanQueue.add).toHaveBeenCalledWith(
                "scan",
                { userId: "user-1", source: "youtube-download" },
                COALESCED_SCAN_JOB_OPTIONS,
            );

            // Scan finishes with no completions observed while it ran — no
            // follow-up scan.
            bullJob.complete();
            await flushAsync();
            expect(scanQueue.add).toHaveBeenCalledTimes(1);
        });

        it("queues exactly one follow-up scan for completions observed while a scan is running", async () => {
            const firstScan = createFakeBullJob();
            const secondScan = createFakeBullJob();
            scanQueue.add
                .mockResolvedValueOnce(firstScan)
                .mockResolvedValueOnce(secondScan);
            mockGetDownloadJobStatus.mockImplementation(async (id: string) => ({
                jobId: id,
                status: "completed",
                progressPct: 100,
                filePath: `/music/YouTube Downloads/${id}.mp3`,
                error: null,
            }));

            await statusHandler(
                {
                    params: { jobId: "job-co-r1" },
                    user: { id: "user-1" },
                } as any,
                createRes(),
            );
            expect(scanQueue.add).toHaveBeenCalledTimes(1);

            // The scan starts running; its file enumeration may already have
            // happened, so later completions need a follow-up scan.
            firstScan.setActive();
            await statusHandler(
                {
                    params: { jobId: "job-co-r2" },
                    user: { id: "user-1" },
                } as any,
                createRes(),
            );
            await statusHandler(
                {
                    params: { jobId: "job-co-r3" },
                    user: { id: "user-1" },
                } as any,
                createRes(),
            );
            // Still only the running scan — the follow-up is deferred until
            // it finishes, and the two completions collapse into one.
            expect(scanQueue.add).toHaveBeenCalledTimes(1);

            firstScan.complete();
            await flushAsync();
            expect(scanQueue.add).toHaveBeenCalledTimes(2);

            // Nothing completed while the follow-up ran — it settles quietly.
            secondScan.complete();
            await flushAsync();
            expect(scanQueue.add).toHaveBeenCalledTimes(2);
        });
    });

    describe("rememberBoundedJobId", () => {
        it("evicts the oldest ids once the max size is exceeded", () => {
            const seen = new Set<string>();

            for (let i = 0; i < 5; i++) {
                rememberBoundedJobId(seen, `job-${i}`, 3);
            }

            expect(seen.size).toBe(3);
            expect([...seen]).toEqual(["job-2", "job-3", "job-4"]);
        });

        it("keeps re-added ids without growing past the bound", () => {
            const seen = new Set<string>();
            rememberBoundedJobId(seen, "job-a", 2);
            rememberBoundedJobId(seen, "job-b", 2);
            rememberBoundedJobId(seen, "job-a", 2);

            expect([...seen]).toEqual(["job-a", "job-b"]);
        });
    });
});
