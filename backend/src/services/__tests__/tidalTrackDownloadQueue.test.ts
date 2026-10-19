jest.mock("../coalescedLibraryScan", () => ({
    requestCoalescedLibraryScan: jest.fn(),
}));

jest.mock("../tidal", () => ({
    tidalService: {
        downloadTrack: jest.fn(),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({
            info: jest.fn(),
            warn: jest.fn(),
        })),
    },
}));

import {
    createTidalTrackDownloadQueue,
    TidalTrackDownloadQueueFullError,
} from "../tidalTrackDownloadQueue";

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function downloadResult(tidalTrackId: number) {
    return { relative_path: `Artist/Album/${tidalTrackId}.flac` };
}

function createLog() {
    return {
        info: jest.fn(),
        warn: jest.fn(),
    };
}

describe("tidalTrackDownloadQueue", () => {
    it.each([0, 1.5, 1024])(
        "rejects invalid maxPending value %s",
        (maxPending) => {
            expect(() =>
                createTidalTrackDownloadQueue({
                    downloadTrack: jest.fn(),
                    requestScan: jest.fn(),
                    maxPending,
                    log: createLog(),
                }),
            ).toThrow(RangeError);
        },
    );

    it("downloads in FIFO order with one active download", async () => {
        const downloads = new Map([
            [1, deferred<ReturnType<typeof downloadResult>>()],
            [2, deferred<ReturnType<typeof downloadResult>>()],
            [3, deferred<ReturnType<typeof downloadResult>>()],
        ]);
        const started = new Map([
            [1, deferred<void>()],
            [2, deferred<void>()],
            [3, deferred<void>()],
        ]);
        let activeDownloads = 0;
        let maximumActiveDownloads = 0;
        const downloadOrder: number[] = [];
        const log = createLog();
        const downloadTrack = jest.fn(async (tidalTrackId: number) => {
            downloadOrder.push(tidalTrackId);
            activeDownloads += 1;
            maximumActiveDownloads = Math.max(
                maximumActiveDownloads,
                activeDownloads,
            );
            started.get(tidalTrackId)!.resolve();
            try {
                return await downloads.get(tidalTrackId)!.promise;
            } finally {
                activeDownloads -= 1;
            }
        });
        const requestScan = jest.fn(async () => undefined);
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 3,
            log,
        });

        expect(queue.enqueue({ tidalTrackId: 1, userId: "user-1" })).toBe(
            "queued",
        );
        expect(queue.enqueue({ tidalTrackId: 2, userId: "user-2" })).toBe(
            "queued",
        );
        expect(queue.enqueue({ tidalTrackId: 3, userId: "user-3" })).toBe(
            "queued",
        );

        await started.get(1)!.promise;
        expect(downloadOrder).toEqual([1]);
        downloads.get(1)!.resolve(downloadResult(1));
        await started.get(2)!.promise;
        expect(downloadOrder).toEqual([1, 2]);
        downloads.get(2)!.resolve(downloadResult(2));
        await started.get(3)!.promise;
        expect(downloadOrder).toEqual([1, 2, 3]);
        downloads.get(3)!.resolve(downloadResult(3));
        await queue.onIdle();

        expect(maximumActiveDownloads).toBe(1);
        expect(requestScan.mock.calls).toEqual([
            ["user-1", "tidal-download"],
            ["user-2", "tidal-download"],
            ["user-3", "tidal-download"],
        ]);
        expect(log.info.mock.calls).toEqual([
            [
                "TIDAL track download finished",
                {
                    tidalTrackId: 1,
                    relative_path: "Artist/Album/1.flac",
                },
            ],
            [
                "TIDAL track download finished",
                {
                    tidalTrackId: 2,
                    relative_path: "Artist/Album/2.flac",
                },
            ],
            [
                "TIDAL track download finished",
                {
                    tidalTrackId: 3,
                    relative_path: "Artist/Album/3.flac",
                },
            ],
        ]);
    });

    it("deduplicates running and pending track ids", async () => {
        const firstDownload = deferred<ReturnType<typeof downloadResult>>();
        const downloadTrack = jest.fn((tidalTrackId: number) =>
            tidalTrackId === 10
                ? firstDownload.promise
                : Promise.resolve(downloadResult(tidalTrackId)),
        );
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan: jest.fn(async () => undefined),
            maxPending: 2,
            log: createLog(),
        });

        expect(queue.enqueue({ tidalTrackId: 10, userId: "user-1" })).toBe(
            "queued",
        );
        expect(queue.enqueue({ tidalTrackId: 10, userId: "user-1" })).toBe(
            "already-queued",
        );
        expect(queue.enqueue({ tidalTrackId: 11, userId: "user-1" })).toBe(
            "queued",
        );
        expect(queue.enqueue({ tidalTrackId: 11, userId: "user-2" })).toBe(
            "already-queued",
        );

        firstDownload.resolve(downloadResult(10));
        await queue.onIdle();

        expect(downloadTrack).toHaveBeenCalledTimes(2);
        expect(downloadTrack.mock.calls.map(([trackId]) => trackId)).toEqual([
            10, 11,
        ]);
    });

    it("rejects new work with a typed error when the pending queue is full", async () => {
        const runningDownload = deferred<ReturnType<typeof downloadResult>>();
        const queue = createTidalTrackDownloadQueue({
            downloadTrack: jest.fn((tidalTrackId: number) =>
                tidalTrackId === 20
                    ? runningDownload.promise
                    : Promise.resolve(downloadResult(tidalTrackId)),
            ),
            requestScan: jest.fn(async () => undefined),
            maxPending: 1,
            log: createLog(),
        });

        queue.enqueue({ tidalTrackId: 20, userId: "user-1" });
        queue.enqueue({ tidalTrackId: 21, userId: "user-1" });

        expect(() =>
            queue.enqueue({ tidalTrackId: 22, userId: "user-1" }),
        ).toThrow(TidalTrackDownloadQueueFullError);
        expect(queue.enqueue({ tidalTrackId: 21, userId: "user-2" })).toBe(
            "already-queued",
        );

        runningDownload.resolve(downloadResult(20));
        await queue.onIdle();
    });

    it("swallows scan failures, logs them, and continues the queue", async () => {
        const log = createLog();
        const requestScan = jest
            .fn<Promise<void>, [string, "tidal-download"]>()
            .mockRejectedValueOnce(new Error("Redis unavailable"))
            .mockResolvedValueOnce(undefined);
        const downloadTrack = jest.fn(async (tidalTrackId: number) =>
            downloadResult(tidalTrackId),
        );
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 2,
            log,
        });

        queue.enqueue({ tidalTrackId: 30, userId: "user-1" });
        queue.enqueue({ tidalTrackId: 31, userId: "user-2" });
        await queue.onIdle();

        expect(downloadTrack.mock.calls.map(([trackId]) => trackId)).toEqual([
            30, 31,
        ]);
        expect(requestScan.mock.calls).toEqual([
            ["user-1", "tidal-download"],
            ["user-2", "tidal-download"],
        ]);
        expect(log.warn).toHaveBeenCalledWith(
            "Failed to request library scan after TIDAL track download",
            {
                tidalTrackId: 30,
                errorMessage: "Redis unavailable",
            },
        );
    });

    it("logs a safe download failure and continues with the next item", async () => {
        const log = createLog();
        const sensitiveError = Object.assign(new Error("Bad gateway"), {
            response: { status: 502 },
            config: {
                headers: { Authorization: "Bearer top-secret-token" },
            },
        });
        const downloadTrack = jest
            .fn<Promise<{ relative_path: string }>, [number]>()
            .mockRejectedValueOnce(sensitiveError)
            .mockResolvedValueOnce(downloadResult(41));
        const requestScan = jest.fn(async () => undefined);
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 2,
            log,
        });

        queue.enqueue({ tidalTrackId: 40, userId: "user-1" });
        queue.enqueue({ tidalTrackId: 41, userId: "user-2" });
        await queue.onIdle();

        expect(downloadTrack).toHaveBeenCalledTimes(2);
        expect(requestScan).toHaveBeenCalledTimes(1);
        expect(requestScan).toHaveBeenCalledWith("user-2", "tidal-download");
        expect(log.warn).toHaveBeenCalledWith("TIDAL track download failed", {
            tidalTrackId: 40,
            httpStatus: 502,
            errorMessage: "Bad gateway",
        });
        const loggedPayload = JSON.stringify(log.warn.mock.calls);
        expect(loggedPayload).not.toContain("top-secret-token");
        expect(loggedPayload).not.toContain("Authorization");
        expect(loggedPayload).not.toContain("config");
    });

    it("allows a failed track to be queued again after becoming idle", async () => {
        const downloadTrack = jest
            .fn<Promise<{ relative_path: string }>, [number]>()
            .mockRejectedValueOnce(new Error("sidecar unavailable"))
            .mockResolvedValueOnce(downloadResult(50));
        const requestScan = jest.fn(async () => undefined);
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 1,
            log: createLog(),
        });

        expect(queue.enqueue({ tidalTrackId: 50, userId: "user-1" })).toBe(
            "queued",
        );
        await queue.onIdle();

        expect(queue.enqueue({ tidalTrackId: 50, userId: "user-1" })).toBe(
            "queued",
        );
        await queue.onIdle();

        expect(downloadTrack).toHaveBeenCalledTimes(2);
        expect(requestScan).toHaveBeenCalledTimes(1);
        expect(requestScan).toHaveBeenCalledWith("user-1", "tidal-download");
    });

    it("allows a successful track to be queued again after becoming idle", async () => {
        const downloadTrack = jest.fn(async (tidalTrackId: number) =>
            downloadResult(tidalTrackId),
        );
        const requestScan = jest.fn(async () => undefined);
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 1,
            log: createLog(),
        });

        expect(queue.enqueue({ tidalTrackId: 51, userId: "user-1" })).toBe(
            "queued",
        );
        await queue.onIdle();

        expect(queue.enqueue({ tidalTrackId: 51, userId: "user-2" })).toBe(
            "queued",
        );
        await queue.onIdle();

        expect(downloadTrack).toHaveBeenCalledTimes(2);
        expect(requestScan.mock.calls).toEqual([
            ["user-1", "tidal-download"],
            ["user-2", "tidal-download"],
        ]);
    });

    it("starts and completes a new drain for brand-new work after becoming idle", async () => {
        const downloadTrack = jest.fn(async (tidalTrackId: number) =>
            downloadResult(tidalTrackId),
        );
        const requestScan = jest.fn(async () => undefined);
        const queue = createTidalTrackDownloadQueue({
            downloadTrack,
            requestScan,
            maxPending: 1,
            log: createLog(),
        });

        queue.enqueue({ tidalTrackId: 60, userId: "user-1" });
        await queue.onIdle();

        expect(queue.enqueue({ tidalTrackId: 61, userId: "user-2" })).toBe(
            "queued",
        );
        expect(downloadTrack).toHaveBeenCalledWith(61);
        await queue.onIdle();

        expect(downloadTrack.mock.calls.map(([trackId]) => trackId)).toEqual([
            60, 61,
        ]);
        expect(requestScan.mock.calls).toEqual([
            ["user-1", "tidal-download"],
            ["user-2", "tidal-download"],
        ]);
    });
});
