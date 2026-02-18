describe("podcast download runtime behavior", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    function setupPodcastDownloadMocks() {
        const Prisma = {
            PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                code = "P0000";
            },
            PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
            PrismaClientUnknownRequestError:
                class PrismaClientUnknownRequestError extends Error {},
        };
        const prisma = {
            $connect: jest.fn(async () => undefined),
            podcastEpisode: {
                findUnique: jest.fn(async () => ({ fileSize: 1_048_576 })),
                update: jest.fn(async () => undefined),
            },
            podcastDownload: {
                findFirst: jest.fn(async () => ({ id: "dl-1", fileSizeMb: 1 })),
                deleteMany: jest.fn(async () => ({ count: 1 })),
                updateMany: jest.fn(async () => ({ count: 1 })),
                findMany: jest.fn(async () => []),
                delete: jest.fn(async () => undefined),
                upsert: jest.fn(async () => undefined),
            },
        };

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        const fsPromises = {
            access: jest.fn(async () => undefined),
            stat: jest.fn(async () => ({ size: 1_048_576 })),
            unlink: jest.fn(async () => undefined),
            mkdir: jest.fn(async () => undefined),
            rename: jest.fn(async () => undefined),
            constants: { F_OK: 0 },
        };
        const fsModule = {
            createWriteStream: jest.fn(() => {
                const listeners = new Map<string, Array<(...args: any[]) => void>>();
                return {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        const current = listeners.get(event) ?? [];
                        listeners.set(event, [...current, cb]);
                    }),
                    end: jest.fn((cb?: () => void) => cb?.()),
                    destroy: jest.fn(),
                    __emit: (event: string, ...args: any[]) => {
                        for (const listener of listeners.get(event) ?? []) {
                            listener(...args);
                        }
                    },
                };
            }),
        };

        const axiosGet = jest.fn(async () => ({
            headers: { "content-length": "0" },
            data: {
                on: jest.fn(),
                destroy: jest.fn(),
                pipe: jest.fn(),
            },
        }));

        jest.doMock("../../utils/db", () => ({ prisma, Prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../config", () => ({
            config: {
                music: {
                    transcodeCachePath: "/music/.soundspan/transcodes",
                },
            },
        }));
        jest.doMock("fs/promises", () => fsPromises);
        jest.doMock("fs", () => fsModule);
        jest.doMock("axios", () => ({
            __esModule: true,
            default: { get: axiosGet },
            get: axiosGet,
        }));

        return {
            Prisma,
            prisma,
            logger,
            fsPromises,
            fsModule,
            axiosGet,
        };
    }

    function mockImmediateTimers() {
        return jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((handler: (...args: any[]) => void) => {
                if (typeof handler === "function") {
                    handler();
                }
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);
    }

    it("validates a cached podcast file and updates access metadata", async () => {
        const mocks = setupPodcastDownloadMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cachedPath = await podcastDownload.getCachedFilePath("episode-1");

        expect(cachedPath).toBe("/music/.soundspan/podcast-audio/episode-1.mp3");
        expect(mocks.fsPromises.access).toHaveBeenCalled();
        expect(mocks.prisma.podcastEpisode.findUnique).toHaveBeenCalled();
        expect(mocks.prisma.podcastDownload.findFirst).toHaveBeenCalled();
        expect(mocks.prisma.podcastDownload.updateMany).toHaveBeenCalled();
    });

    it("cleans expired cache records and computes cache stats", async () => {
        const mocks = setupPodcastDownloadMocks();
        (mocks.prisma.podcastDownload.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "d1",
                    localPath: "/music/.soundspan/podcast-audio/old-1.mp3",
                    fileSizeMb: 12.5,
                    lastAccessedAt: new Date("2025-01-01T00:00:00.000Z"),
                },
                {
                    id: "d2",
                    localPath: "/music/.soundspan/podcast-audio/old-2.mp3",
                    fileSizeMb: 7.5,
                    lastAccessedAt: new Date("2025-01-02T00:00:00.000Z"),
                },
            ])
            .mockResolvedValueOnce([
                {
                    fileSizeMb: 4.2,
                    downloadedAt: new Date("2025-02-01T00:00:00.000Z"),
                },
                {
                    fileSizeMb: 5.8,
                    downloadedAt: new Date("2025-02-02T00:00:00.000Z"),
                },
            ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");

        const cleanup = await podcastDownload.cleanupExpiredCache();
        expect(cleanup).toEqual({ deleted: 2, freedMb: 20 });
        expect(mocks.fsPromises.unlink).toHaveBeenCalledTimes(2);
        expect(mocks.prisma.podcastDownload.delete).toHaveBeenCalledTimes(2);

        const stats = await podcastDownload.getCacheStats();
        expect(stats.totalFiles).toBe(2);
        expect(stats.totalSizeMb).toBe(10);
        expect(stats.oldestFile).toEqual(new Date("2025-02-01T00:00:00.000Z"));
    });

    it("starts a single in-flight background download per episode", async () => {
        const mocks = setupPodcastDownloadMocks();
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.axiosGet as jest.Mock).mockImplementation(
            () => new Promise(() => undefined)
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");

        expect(podcastDownload.isDownloading("episode-2")).toBe(false);
        expect(podcastDownload.getDownloadProgress("episode-2")).toBeNull();

        podcastDownload.downloadInBackground(
            "episode-2",
            "https://example.com/episode-2.mp3",
            "user-1"
        );
        podcastDownload.downloadInBackground(
            "episode-2",
            "https://example.com/episode-2.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        const inFlight = podcastDownload.isDownloading("episode-2");
        expect(typeof inFlight).toBe("boolean");
        if (inFlight) {
            expect(podcastDownload.getDownloadProgress("episode-2")).toEqual({
                progress: 0,
                downloading: true,
            });
        }
        expect(mocks.axiosGet).toHaveBeenCalledTimes(1);
    });

    it("clamps runtime progress to 100% while still downloading", async () => {
        const mocks = setupPodcastDownloadMocks();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();

        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        mocks.prisma.podcastEpisode.findUnique = jest.fn(async () => ({ fileSize: 3 }));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-clamp",
            "https://example.com/episode-clamp.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(streamControls).toHaveLength(1);
        streamControls[0].data?.(Buffer.alloc(6));

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(podcastDownload.getDownloadProgress("episode-clamp")).toEqual({
            progress: 100,
            downloading: true,
        });

        streamControls[0].end?.();
        for (let i = 0; i < 4; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(podcastDownload.getDownloadProgress("episode-clamp")).toBeNull();
    });

    it("shows in-progress state while total bytes are unknown", async () => {
        const mocks = setupPodcastDownloadMocks();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();

        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "0" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue(
            { fileSize: 0 }
        );
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-unknown-bytes",
            "https://example.com/episode-unknown-bytes.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(podcastDownload.getDownloadProgress("episode-unknown-bytes")).toEqual({
            progress: 0,
            downloading: true,
        });

        streamControls[0].end?.();
        for (let i = 0; i < 4; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(podcastDownload.getDownloadProgress("episode-unknown-bytes")).toBeNull();
    });

    it("retries transient Prisma failures while validating cache metadata", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock)
            .mockRejectedValueOnce(new Error("Response from the Engine was empty"))
            .mockResolvedValueOnce({ fileSize: 1_048_576 });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cachedPath = await podcastDownload.getCachedFilePath("episode-retry");

        expect(cachedPath).toBe(
            "/music/.soundspan/podcast-audio/episode-retry.mp3"
        );
        expect(mocks.prisma.$connect).toHaveBeenCalledTimes(1);
        expect(mocks.logger.warn).toHaveBeenCalled();
        expect(mocks.prisma.podcastEpisode.findUnique).toHaveBeenCalledTimes(2);
        setTimeoutSpy.mockRestore();
    });

    it("retries rust panic and unknown Prisma errors before succeeding", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const rustPanic = new (mocks.Prisma as any).PrismaClientRustPanicError(
            "panic"
        );
        const unknownTransient = new (mocks.Prisma as any).PrismaClientUnknownRequestError(
            "Engine has already exited"
        );
        (mocks.prisma.podcastDownload.findMany as jest.Mock)
            .mockRejectedValueOnce(rustPanic)
            .mockRejectedValueOnce(unknownTransient)
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        await expect(podcastDownload.getCacheStats()).resolves.toEqual({
            totalFiles: 0,
            totalSizeMb: 0,
            oldestFile: null,
        });

        expect(mocks.prisma.$connect).toHaveBeenCalledTimes(2);
        setTimeoutSpy.mockRestore();
    });

    it("does not retry non-retryable known Prisma errors", async () => {
        const mocks = setupPodcastDownloadMocks();
        const nonRetryable = new (mocks.Prisma as any).PrismaClientKnownRequestError(
            "constraint violation"
        );
        nonRetryable.code = "P2002";
        (mocks.prisma.podcastDownload.findMany as jest.Mock).mockRejectedValueOnce(
            nonRetryable
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");

        await expect(podcastDownload.getCacheStats()).rejects.toBe(nonRetryable);
        expect(mocks.prisma.$connect).not.toHaveBeenCalled();
    });

    it("completes a background download and upserts podcast cache metadata", async () => {
        const mocks = setupPodcastDownloadMocks();
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValueOnce(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 3,
        });

        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const listeners = new Map<string, Array<(...args: any[]) => void>>();
            const dataStream = {
                on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                    const existing = listeners.get(event) ?? [];
                    listeners.set(event, [...existing, cb]);
                }),
                pipe: jest.fn(() => {
                    const dataHandlers = listeners.get("data") ?? [];
                    for (const handler of dataHandlers) {
                        handler(Buffer.from("abc"));
                    }
                    const endHandlers = listeners.get("end") ?? [];
                    for (const handler of endHandlers) {
                        handler();
                    }
                }),
                destroy: jest.fn(),
            };

            return {
                headers: { "content-length": "3" },
                data: dataStream,
            };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");

        podcastDownload.downloadInBackground(
            "episode-complete",
            "https://example.com/episode-complete.mp3",
            "user-1"
        );

        for (let i = 0; i < 5; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId_episodeId: { userId: "user-1", episodeId: "episode-complete" } },
            })
        );
        expect(mocks.fsPromises.rename).toHaveBeenCalledWith(
            "/music/.soundspan/podcast-audio/episode-complete.tmp",
            "/music/.soundspan/podcast-audio/episode-complete.mp3"
        );
        expect(podcastDownload.isDownloading("episode-complete")).toBe(false);
    });

    it("deletes cache and db record when canonical episode size mismatches local cache", async () => {
        const mocks = setupPodcastDownloadMocks();
        (mocks.fsPromises.stat as jest.Mock).mockResolvedValue({ size: 512 * 1024 });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 2 * 1024 * 1024,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cachedPath = await podcastDownload.getCachedFilePath("episode-size-mismatch");

        expect(cachedPath).toBeNull();
        expect(mocks.fsPromises.unlink).toHaveBeenCalledWith(
            "/music/.soundspan/podcast-audio/episode-size-mismatch.mp3"
        );
        expect(mocks.prisma.podcastDownload.deleteMany).toHaveBeenCalledWith({
            where: { episodeId: "episode-size-mismatch" },
        });
    });

    it("deletes stale cache when DB record is missing", async () => {
        const mocks = setupPodcastDownloadMocks();
        (mocks.fsPromises.stat as jest.Mock).mockResolvedValue({ size: 1_000_000 });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 0,
        });
        (mocks.prisma.podcastDownload.findFirst as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cachedPath = await podcastDownload.getCachedFilePath("episode-missing-db");

        expect(cachedPath).toBeNull();
        expect(mocks.fsPromises.unlink).toHaveBeenCalledWith(
            "/music/.soundspan/podcast-audio/episode-missing-db.mp3"
        );
        expect(mocks.prisma.podcastDownload.deleteMany).not.toHaveBeenCalled();
    });

    it("deletes cache and db record when db-recorded file size mismatches", async () => {
        const mocks = setupPodcastDownloadMocks();
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 0,
        });
        (mocks.fsPromises.stat as jest.Mock).mockResolvedValue({ size: 1_000_000 });
        (mocks.prisma.podcastDownload.findFirst as jest.Mock).mockResolvedValue({
            id: "dl-1",
            fileSizeMb: 2,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cachedPath = await podcastDownload.getCachedFilePath(
            "episode-db-mismatch"
        );

        expect(cachedPath).toBeNull();
        expect(mocks.prisma.podcastDownload.deleteMany).toHaveBeenCalledWith({
            where: { episodeId: "episode-db-mismatch" },
        });
    });

    it("updates missing canonical file size from content-length during download", async () => {
        const mocks = setupPodcastDownloadMocks();
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValueOnce(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 0,
        });

        (mocks.axiosGet as jest.Mock).mockResolvedValue({
            headers: { "content-length": "3" },
            data: {
                on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                    if (event === "data") cb(Buffer.from("abc"));
                    if (event === "end") cb();
                }),
                pipe: jest.fn(),
                destroy: jest.fn(),
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-file-size-init",
            "https://example.com/episode-file-size-init.mp3",
            "user-1"
        );
        for (let i = 0; i < 5; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(mocks.prisma.podcastEpisode.update).toHaveBeenCalledWith({
            where: { id: "episode-file-size-init" },
            data: { fileSize: 3 },
        });
    });

    it("corrects canonical file size when content-length variance is high", async () => {
        const mocks = setupPodcastDownloadMocks();
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValueOnce(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 30,
        });
        (mocks.axiosGet as jest.Mock).mockResolvedValue({
            headers: { "content-length": "3" },
            data: {
                on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                    if (event === "data") cb(Buffer.from("abc"));
                    if (event === "end") cb();
                }),
                pipe: jest.fn(),
                destroy: jest.fn(),
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-file-size-correct",
            "https://example.com/episode-file-size-correct.mp3",
            "user-1"
        );
        for (let i = 0; i < 5; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(mocks.prisma.podcastEpisode.update).toHaveBeenCalledWith({
            where: { id: "episode-file-size-correct" },
            data: { fileSize: 3 },
        });
    });

    it("falls back to database file size when content-length is missing", async () => {
        const mocks = setupPodcastDownloadMocks();
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValueOnce(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });
        (mocks.prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            fileSize: 3,
        });
        (mocks.axiosGet as jest.Mock).mockResolvedValue({
            headers: { "content-length": "0" },
            data: {
                on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                    if (event === "data") cb(Buffer.from("abc"));
                    if (event === "end") cb();
                }),
                pipe: jest.fn(),
                destroy: jest.fn(),
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-file-size-fallback",
            "https://example.com/episode-file-size-fallback.mp3",
            "user-1"
        );
        for (let i = 0; i < 5; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(mocks.prisma.podcastEpisode.findUnique).toHaveBeenCalledWith({
            where: { id: "episode-file-size-fallback" },
            select: { fileSize: true },
        });
        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalled();
    });

    it("retries failed downloads and succeeds on a later attempt", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });

        (mocks.axiosGet as jest.Mock)
            .mockRejectedValueOnce(new Error("network flake"))
            .mockResolvedValueOnce({
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        if (event === "data") cb(Buffer.from("abc"));
                        if (event === "end") cb();
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-retry-download",
            "https://example.com/episode-retry-download.mp3",
            "user-1"
        );

        for (let i = 0; i < 6; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries a download when the stream emits an error", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];

        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-stream-error",
            "https://example.com/episode-stream-error.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[0].error?.(new Error("stream error"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        streamControls[1].data?.(Buffer.from("abc"));
        streamControls[1].end?.();

        for (let i = 0; i < 4; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(streamControls).toHaveLength(2);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalledTimes(1);
        expect(writeStream.destroy).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries a download when the stream is aborted", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];

        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: 3 };
            }
            return { size: 1_048_576 };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-stream-aborted",
            "https://example.com/episode-stream-aborted.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[0].aborted?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        streamControls[1].data?.(Buffer.from("abc"));
        streamControls[1].end?.();
        for (let i = 0; i < 4; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(streamControls).toHaveLength(2);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalledTimes(1);
        expect(writeStream.destroy).toHaveBeenCalledTimes(1);
        setTimeoutSpy.mockRestore();
    });

    it("retries an incomplete download before succeeding", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];
        const tempSizes = [2, 3];

        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));
        (mocks.fsPromises.stat as jest.Mock).mockImplementation(async (targetPath: string) => {
            if (targetPath.endsWith(".tmp")) {
                return { size: tempSizes.shift() ?? 3 };
            }
            return { size: 1_048_576 };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-incomplete-retry",
            "https://example.com/episode-incomplete-retry.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[0].data?.(Buffer.from("ab"));
        streamControls[0].end?.();

        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[1].data?.(Buffer.from("abc"));
        streamControls[1].end?.();

        for (let i = 0; i < 4; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(streamControls).toHaveLength(2);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
        expect(mocks.fsPromises.unlink).toHaveBeenCalledWith(
            "/music/.soundspan/podcast-audio/episode-incomplete-retry.tmp"
        );
        expect(mocks.prisma.podcastDownload.upsert).toHaveBeenCalledTimes(1);
        expect(writeStream.destroy).toHaveBeenCalledTimes(0);
        setTimeoutSpy.mockRestore();
    });

    it("gives up after download retry exhaustion", async () => {
        const mocks = setupPodcastDownloadMocks();
        const setTimeoutSpy = mockImmediateTimers();
        const streamControls: Array<Record<string, (...args: any[]) => void>> = [];

        (mocks.axiosGet as jest.Mock).mockImplementation(async () => {
            const control: Record<string, (...args: any[]) => void> = {};
            streamControls.push(control);
            return {
                headers: { "content-length": "3" },
                data: {
                    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
                        control[event] = cb;
                    }),
                    pipe: jest.fn(),
                    destroy: jest.fn(),
                },
            };
        });

        const writeStream = (mocks.fsModule.createWriteStream as jest.Mock)();
        (mocks.fsModule.createWriteStream as jest.Mock).mockReturnValue(writeStream);
        mocks.fsPromises.access.mockRejectedValue(new Error("not found"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        podcastDownload.downloadInBackground(
            "episode-retry-exhausted",
            "https://example.com/episode-retry-exhausted.mp3",
            "user-1"
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[0].error?.(new Error("stream error"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        await new Promise<void>((resolve) => setImmediate(resolve));
        streamControls[1].error?.(new Error("stream error"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        streamControls[2].error?.(new Error("stream error"));

        for (let i = 0; i < 6; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(streamControls).toHaveLength(3);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(3);
        expect(mocks.prisma.podcastDownload.upsert).not.toHaveBeenCalled();
        expect(podcastDownload.getDownloadProgress("episode-retry-exhausted")).toBeNull();
        expect(podcastDownload.isDownloading("episode-retry-exhausted")).toBe(false);
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "[PODCAST-DL] Background download failed for episode-retry-exhausted:"
            ),
            "stream error"
        );
        setTimeoutSpy.mockRestore();
    });

    it("logs cleanup errors and continues processing remaining expired entries", async () => {
        const mocks = setupPodcastDownloadMocks();
        (mocks.prisma.podcastDownload.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "d-fail",
                localPath: "/music/.soundspan/podcast-audio/fail.mp3",
                fileSizeMb: 3,
                lastAccessedAt: new Date("2024-01-01T00:00:00.000Z"),
            },
        ]);
        (mocks.prisma.podcastDownload.delete as jest.Mock).mockRejectedValueOnce(
            new Error("db delete failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const podcastDownload = require("../podcastDownload");
        const cleanup = await podcastDownload.cleanupExpiredCache();

        expect(cleanup).toEqual({ deleted: 0, freedMb: 0 });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[PODCAST-DL] Failed to delete /music/.soundspan/podcast-audio/fail.mp3:",
            "db delete failed"
        );
    });
});
