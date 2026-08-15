import * as crypto from "crypto";
import { Readable } from "node:stream";

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockFsExistsSync = jest.fn();
const mockFsMkdirSync = jest.fn();
const mockFsCreateReadStream = jest.fn();
const mockFsCreateWriteStream = jest.fn();
const mockFsStat = jest.fn();
const mockPipeline = jest.fn();
const mockFsUnlink = jest.fn();
const mockFsRename = jest.fn();
const mockFsUnlinkCallback = jest.fn(
    (_path: string, callback: (error: NodeJS.ErrnoException | null) => void) =>
        callback(null),
);

const mockPrisma = {
    transcodedFile: {
        findFirst: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
    },
};

const mockParseFile = jest.fn();
const mockParseRangeHeader = jest.fn();
const mockInspectFfmpegVersion = jest.fn(
    (_binaryPath: string) => "ffmpeg version 7.0",
);
const mockResolveFfmpegBinaryPath = jest.fn(
    (_configuredPath?: string) => "/usr/bin/ffmpeg",
);

// Mutable config mock so individual tests can exercise the ALLOWED_ORIGINS
// allowlist semantics ([] = empty → deny cross-origin in production).
const mockConfig = {
    nodeEnv: "production",
    allowedOrigins: [] as boolean | string[],
    transcodeConcurrency: 3,
    transcodeTimeoutMs: 5 * 60 * 1000,
    segmentedStreaming: {
        ffmpegPathOverride: undefined as string | undefined,
    },
};

type FfmpegMode = "success" | "error" | "pending" | "throw";

type CommandStartWaiter = {
    count: number;
    resolve: () => void;
};

const ffmpegControl: {
    mode: FfmpegMode;
    errorMessage: string;
    outputPath?: string;
    lastCommand?: any;
    commands: any[];
    startWaiters: CommandStartWaiter[];
} = {
    mode: "success",
    errorMessage: "",
    commands: [],
    startWaiters: [],
};

function waitForFfmpegCommandCount(count: number): Promise<void> {
    if (ffmpegControl.commands.length >= count) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        ffmpegControl.startWaiters.push({ count, resolve });
    });
}

function notifyFfmpegCommandStarted(): void {
    const readyWaiters = ffmpegControl.startWaiters.filter(
        ({ count }) => ffmpegControl.commands.length >= count,
    );
    ffmpegControl.startWaiters = ffmpegControl.startWaiters.filter(
        ({ count }) => ffmpegControl.commands.length < count,
    );
    readyWaiters.forEach(({ resolve }) => resolve());
}

const mockSetFfmpegPath = jest.fn();
const mockFfmpeg = jest.fn((sourcePath: string) => {
    if (ffmpegControl.mode === "throw") {
        throw new Error("ffmpeg constructor failure");
    }

    const handlers: Record<string, (...args: any[]) => any> = {};

    const command: any = {
        audioBitrate: jest.fn().mockReturnThis(),
        audioCodec: jest.fn().mockReturnThis(),
        format: jest.fn().mockReturnThis(),
        kill: jest.fn().mockReturnThis(),
        on: jest.fn((event: string, handler: (...args: any[]) => any) => {
            handlers[event] = handler;
            return command;
        }),
        save: jest.fn((outputPath: string) => {
            ffmpegControl.outputPath = outputPath;

            if (ffmpegControl.mode === "error") {
                handlers.error?.(new Error(ffmpegControl.errorMessage));
            } else if (ffmpegControl.mode === "success") {
                handlers.end?.();
            }

            return command;
        }),
        __handlers: handlers,
        __sourcePath: sourcePath,
    };

    ffmpegControl.lastCommand = command;
    ffmpegControl.commands.push(command);
    notifyFfmpegCommandStarted();
    return command;
});

jest.mock("fs", () => ({
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    createReadStream: mockFsCreateReadStream,
    createWriteStream: mockFsCreateWriteStream,
    unlink: mockFsUnlinkCallback,
    promises: {
        stat: mockFsStat,
        unlink: mockFsUnlink,
        rename: mockFsRename,
    },
}));

jest.mock("node:stream/promises", () => ({
    pipeline: mockPipeline,
}));

jest.mock("p-queue", () => {
    return class MockPQueue {
        private readonly concurrency: number;
        private pending = 0;
        private readonly waiting: Array<{
            task: () => Promise<unknown> | unknown;
            resolve: (value: unknown) => void;
            reject: (reason?: unknown) => void;
        }> = [];

        constructor(options?: { concurrency?: number }) {
            this.concurrency = options?.concurrency ?? Number.POSITIVE_INFINITY;
        }

        add<T>(task: () => Promise<T> | T): Promise<T> {
            return new Promise<T>((resolve, reject) => {
                this.waiting.push({
                    task,
                    resolve: resolve as (value: unknown) => void,
                    reject,
                });
                this.startAvailableTasks();
            });
        }

        private startAvailableTasks(): void {
            while (this.pending < this.concurrency && this.waiting.length > 0) {
                const queued = this.waiting.shift();
                if (!queued) return;

                this.pending += 1;
                Promise.resolve()
                    .then(queued.task)
                    .then(queued.resolve, queued.reject)
                    .finally(() => {
                        this.pending -= 1;
                        this.startAvailableTasks();
                    });
            }
        }
    };
});

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock(
    "music-metadata",
    () => ({
        parseFile: mockParseFile,
    }),
    { virtual: true },
);

jest.mock("../../utils/rangeParser", () => ({
    parseRangeHeader: mockParseRangeHeader,
}));

jest.mock("../../config", () => ({
    config: mockConfig,
}));

jest.mock("../../utils/configValidator", () => ({
    inspectFfmpegVersion: mockInspectFfmpegVersion,
    resolveFfmpegBinaryPath: mockResolveFfmpegBinaryPath,
}));

jest.mock("fluent-ffmpeg", () => ({
    __esModule: true,
    default: Object.assign(mockFfmpeg, {
        setFfmpegPath: mockSetFfmpegPath,
    }),
}));

import { AudioStreamingService, QUALITY_SETTINGS } from "../audioStreaming";
import { AppError, ErrorCategory, ErrorCode } from "../../utils/errors";

const configuredFfmpegPath = mockSetFfmpegPath.mock.calls[0]?.[0];
const inspectedFfmpegPath = mockInspectFfmpegVersion.mock.calls[0]?.[0];

type MockReadStream = {
    on: jest.Mock;
    pipe: jest.Mock;
    destroy: jest.Mock;
    emit: (event: string, ...args: any[]) => void;
};

type MockResponse = {
    headersSent: boolean;
    status: jest.Mock;
    set: jest.Mock;
    end: jest.Mock;
    on: jest.Mock;
    emit: (event: string, ...args: any[]) => void;
    statusCode?: number;
};

function createMockReadStream(): MockReadStream {
    const handlers: Record<string, (...args: any[]) => void> = {};

    const stream: MockReadStream = {
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
            handlers[event] = handler;
            return stream;
        }),
        pipe: jest.fn(() => stream),
        destroy: jest.fn(),
        emit: (event: string, ...args: any[]) => {
            handlers[event]?.(...args);
        },
    };

    return stream;
}

function createMockResponse(headersSent = false): MockResponse {
    const handlers: Record<string, (...args: any[]) => void> = {};

    const response: MockResponse = {
        headersSent,
        status: jest.fn((code: number) => {
            response.statusCode = code;
            return response;
        }),
        set: jest.fn(() => response),
        end: jest.fn(() => response),
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
            handlers[event] = handler;
            return response;
        }),
        emit: (event: string, ...args: any[]) => {
            handlers[event]?.(...args);
        },
    };

    return response;
}

describe("AudioStreamingService", () => {
    const createdServices: AudioStreamingService[] = [];
    let setIntervalSpy: jest.SpyInstance;
    let clearIntervalSpy: jest.SpyInstance;

    function createService(maxGb = 2): AudioStreamingService {
        const service = new AudioStreamingService("/music", "/cache", maxGb);
        createdServices.push(service);
        return service;
    }

    it("selects the validated system ffmpeg binary", () => {
        expect(inspectedFfmpegPath).toBe("/usr/bin/ffmpeg");
        expect(configuredFfmpegPath).toBe("/usr/bin/ffmpeg");
    });

    beforeEach(() => {
        jest.clearAllMocks();

        ffmpegControl.mode = "success";
        ffmpegControl.errorMessage = "";
        ffmpegControl.outputPath = undefined;
        ffmpegControl.lastCommand = undefined;
        ffmpegControl.commands = [];
        ffmpegControl.startWaiters = [];

        setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockReturnValue(12345 as unknown as NodeJS.Timeout);
        clearIntervalSpy = jest
            .spyOn(global, "clearInterval")
            .mockImplementation(() => undefined);

        mockFsExistsSync.mockReturnValue(true);
        mockFsMkdirSync.mockReturnValue(undefined);
        mockFsCreateReadStream.mockReturnValue(createMockReadStream());
        mockFsCreateWriteStream.mockReturnValue({});
        mockFsStat.mockResolvedValue({ size: 1024 });
        mockFsUnlink.mockResolvedValue(undefined);
        mockFsRename.mockResolvedValue(undefined);
        mockFsUnlinkCallback.mockImplementation(
            (
                _path: string,
                callback: (error: NodeJS.ErrnoException | null) => void,
            ) => callback(null),
        );

        mockPrisma.transcodedFile.findFirst.mockResolvedValue(null);
        mockPrisma.transcodedFile.delete.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.update.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.create.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.upsert.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.findMany.mockResolvedValue([]);

        mockParseFile.mockResolvedValue({ format: { bitrate: 500000 } });
        mockParseRangeHeader.mockReturnValue({ ok: true, start: 0, end: 99 });

        mockConfig.nodeEnv = "production";
        mockConfig.allowedOrigins = [];
    });

    afterEach(() => {
        for (const service of createdServices) {
            service.destroy();
        }
        createdServices.length = 0;

        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
    });

    describe("getStreamFilePath", () => {
        it("returns source path and mime type when original quality is requested", async () => {
            const service = createService();

            const result = await service.getStreamFilePath(
                "track-1",
                "original",
                new Date("2025-01-01T00:00:00.000Z"),
                "/music/source.flac",
            );

            expect(result).toEqual({
                filePath: "/music/source.flac",
                mimeType: "audio/flac",
            });
            expect(mockPrisma.transcodedFile.findFirst).not.toHaveBeenCalled();
            expect(mockParseFile).not.toHaveBeenCalled();
        });

        it("uses cached transcode when cache is valid", async () => {
            const service = createService();
            const transcodeSpy = jest.spyOn(service as any, "transcodeToCache");

            mockPrisma.transcodedFile.findFirst.mockResolvedValueOnce({
                id: "cache-1",
                trackId: "track-1",
                quality: "high",
                cachePath: "cached-file.mp3",
                sourceModified: new Date("2025-01-01T00:00:00.000Z"),
                lastAccessed: new Date("2025-01-02T00:00:00.000Z"),
            });
            mockFsExistsSync.mockImplementation((filePath: string) => {
                if (filePath === "/cache/cached-file.mp3") {
                    return true;
                }
                return true;
            });

            const result = await service.getStreamFilePath(
                "track-1",
                "high",
                new Date("2024-01-01T00:00:00.000Z"),
                "/music/source.flac",
            );

            expect(result).toEqual({
                filePath: "/cache/cached-file.mp3",
                mimeType: "audio/mpeg",
            });
            expect(mockPrisma.transcodedFile.update).toHaveBeenCalledWith({
                where: { id: "cache-1" },
                data: { lastAccessed: expect.any(Date) },
            });
            expect(mockParseFile).not.toHaveBeenCalled();
            expect(transcodeSpy).not.toHaveBeenCalled();
        });

        it("invalidates stale cache entry before transcoding", async () => {
            const service = createService();
            const transcodeSpy = jest
                .spyOn(service as any, "transcodeToCache")
                .mockResolvedValue("/cache/new-file.mp3");

            mockPrisma.transcodedFile.findFirst.mockResolvedValueOnce({
                id: "cache-stale",
                trackId: "track-2",
                quality: "high",
                cachePath: "stale-file.mp3",
                sourceModified: new Date("2024-01-01T00:00:00.000Z"),
                lastAccessed: new Date("2024-01-02T00:00:00.000Z"),
            });
            mockParseFile.mockResolvedValueOnce({
                format: { bitrate: 512000 },
            });

            const sourceModified = new Date("2025-01-01T00:00:00.000Z");
            const result = await service.getStreamFilePath(
                "track-2",
                "high",
                sourceModified,
                "/music/source.flac",
            );

            expect(mockPrisma.transcodedFile.delete).toHaveBeenCalledWith({
                where: { id: "cache-stale" },
            });
            expect(mockFsUnlink).toHaveBeenCalledWith("/cache/stale-file.mp3");
            expect(transcodeSpy).toHaveBeenCalledWith(
                "track-2",
                "high",
                "/music/source.flac",
                sourceModified,
            );
            expect(result).toEqual({
                filePath: "/cache/new-file.mp3",
                mimeType: "audio/mpeg",
            });
        });

        it("serves original file when source bitrate is below target to avoid upsampling", async () => {
            const service = createService();
            const transcodeSpy = jest.spyOn(service as any, "transcodeToCache");

            mockParseFile.mockResolvedValueOnce({
                format: { bitrate: 192000 },
            });

            const result = await service.getStreamFilePath(
                "track-3",
                "high",
                new Date("2025-01-01T00:00:00.000Z"),
                "/music/source.m4a",
            );

            expect(result).toEqual({
                filePath: "/music/source.m4a",
                mimeType: "audio/mp4",
            });
            expect(transcodeSpy).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.findMany).not.toHaveBeenCalled();
        });

        it("falls back to transcoding when metadata parsing fails", async () => {
            const service = createService();
            const transcodeSpy = jest
                .spyOn(service as any, "transcodeToCache")
                .mockResolvedValue("/cache/fallback.mp3");
            const evictSpy = jest
                .spyOn(service, "evictCache")
                .mockResolvedValue();

            mockParseFile.mockRejectedValueOnce(
                new Error("metadata unavailable"),
            );
            const oneGb = 1024 * 1024 * 1024;
            mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
                { cacheSize: Math.floor(oneGb * 1.95) },
            ]);

            const result = await service.getStreamFilePath(
                "track-4",
                "high",
                new Date("2025-01-01T00:00:00.000Z"),
                "/music/source.flac",
            );

            expect(mockLogger.warn).toHaveBeenCalledWith(
                "[STREAM] Failed to read source metadata, will transcode anyway:",
                expect.any(Error),
            );
            expect(evictSpy).toHaveBeenCalledWith(1.6);
            expect(transcodeSpy).toHaveBeenCalledWith(
                "track-4",
                "high",
                "/music/source.flac",
                new Date("2025-01-01T00:00:00.000Z"),
            );
            expect(result).toEqual({
                filePath: "/cache/fallback.mp3",
                mimeType: "audio/mpeg",
            });
        });
    });

    describe("federated stream cache", () => {
        it("populates a miss through a temporary file and persists accounting", async () => {
            const service = createService();
            const loadStream = jest.fn().mockResolvedValue({
                stream: Readable.from(["peer-audio"]),
                mimeType: "audio/flac",
                status: 200,
                contentLength: null,
            });

            const result = await service.cacheFederatedStream(
                "fed-track-1",
                "original",
                new Date("2026-08-15T12:00:00.000Z"),
                "audio/flac",
                loadStream,
            );
            if ("stream" in result) {
                throw new Error("Expected a completed federated cache fill");
            }

            expect(loadStream).toHaveBeenCalledTimes(1);
            expect(mockPipeline).toHaveBeenCalledWith(
                expect.any(Readable),
                expect.any(Object),
                expect.any(Object),
            );
            expect(mockFsRename).toHaveBeenCalledWith(
                expect.stringContaining(".tmp-"),
                result.filePath,
            );
            expect(mockPrisma.transcodedFile.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        trackId_quality: {
                            trackId: "fed-track-1",
                            quality: "original",
                        },
                    },
                    create: expect.objectContaining({
                        trackId: "fed-track-1",
                        quality: "original",
                        cacheSize: 1024,
                    }),
                }),
            );
            expect(result.mimeType).toBe("audio/flac");
        });

        it("returns an existing federated cache entry without loading the peer", async () => {
            const service = createService();
            mockPrisma.transcodedFile.findFirst.mockResolvedValueOnce({
                id: "fed-cache-1",
                cachePath: "federated.cache",
            });
            const loadStream = jest.fn();

            await expect(
                service.getCachedFederatedStreamFilePath(
                    "fed-track-1",
                    "original",
                    "audio/flac",
                ),
            ).resolves.toEqual({
                filePath: "/cache/federated.cache",
                mimeType: "audio/flac",
            });
            expect(loadStream).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.update).toHaveBeenCalledWith({
                where: { id: "fed-cache-1" },
                data: { lastAccessed: expect.any(Date) },
            });
        });

        it("coalesces concurrent first requests for one track and quality", async () => {
            const service = createService();
            let release!: () => void;
            const blocked = new Promise<void>((resolve) => {
                release = resolve;
            });
            const loadStream = jest.fn(async () => {
                await blocked;
                return {
                    stream: Readable.from(["peer-audio"]),
                    mimeType: "audio/mpeg",
                    status: 200,
                    contentLength: null,
                };
            });

            const first = service.cacheFederatedStream(
                "fed-track-2",
                "medium",
                new Date("2026-08-15T12:00:00.000Z"),
                "audio/mpeg",
                loadStream,
            );
            const second = service.cacheFederatedStream(
                "fed-track-2",
                "medium",
                new Date("2026-08-15T12:00:00.000Z"),
                "audio/mpeg",
                loadStream,
            );
            await Promise.resolve();
            release();

            await expect(Promise.all([first, second])).resolves.toHaveLength(2);
            expect(loadStream).toHaveBeenCalledTimes(1);
            expect(mockPrisma.transcodedFile.upsert).toHaveBeenCalledTimes(1);
        });

        it("returns an oversized known-length response for direct passthrough", async () => {
            const fiveBytesInGb = 5 / (1024 * 1024 * 1024);
            const service = createService(fiveBytesInGb);
            const source = {
                stream: Readable.from(["123456"]),
                mimeType: "audio/flac",
                status: 200,
                contentLength: 6,
            };

            await expect(
                service.cacheFederatedStream(
                    "fed-track-too-large",
                    "original",
                    new Date("2026-08-15T12:00:00.000Z"),
                    "audio/flac",
                    async () => source,
                ),
            ).resolves.toBe(source);
            expect(mockPipeline).not.toHaveBeenCalled();
            expect(mockFsCreateWriteStream).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.upsert).not.toHaveBeenCalled();
        });

        it("gives coalesced oversized callers independent passthrough streams", async () => {
            const fiveBytesInGb = 5 / (1024 * 1024 * 1024);
            const service = createService(fiveBytesInGb);
            const firstSource = {
                stream: Readable.from(["first"]),
                mimeType: "audio/flac",
                status: 200,
                contentLength: 6,
            };
            const secondSource = {
                stream: Readable.from(["second"]),
                mimeType: "audio/flac",
                status: 200,
                contentLength: 6,
            };
            const loadStream = jest
                .fn()
                .mockResolvedValueOnce(firstSource)
                .mockResolvedValueOnce(secondSource);

            const first = service.cacheFederatedStream(
                "fed-track-concurrent-oversized",
                "original",
                new Date("2026-08-15T12:00:00.000Z"),
                "audio/flac",
                loadStream,
            );
            const second = service.cacheFederatedStream(
                "fed-track-concurrent-oversized",
                "original",
                new Date("2026-08-15T12:00:00.000Z"),
                "audio/flac",
                loadStream,
            );

            await expect(Promise.all([first, second])).resolves.toEqual([
                firstSource,
                secondSource,
            ]);
            expect(loadStream).toHaveBeenCalledTimes(2);
            expect(mockPrisma.transcodedFile.upsert).not.toHaveBeenCalled();
        });

        it.each([206, 416])(
            "never caches a non-complete %s response",
            async (status) => {
                const service = createService();
                const source = {
                    stream: Readable.from(["partial"]),
                    mimeType: "audio/flac",
                    status,
                    contentLength: 7,
                };

                await expect(
                    service.cacheFederatedStream(
                        `fed-track-${status}`,
                        "original",
                        new Date("2026-08-15T12:00:00.000Z"),
                        "audio/flac",
                        async () => source,
                    ),
                ).resolves.toBe(source);
                expect(mockPipeline).not.toHaveBeenCalled();
                expect(mockPrisma.transcodedFile.upsert).not.toHaveBeenCalled();
            },
        );

        it("aborts an unknown-length fill at remaining capacity and removes both paths", async () => {
            const fiveBytesInGb = 5 / (1024 * 1024 * 1024);
            const service = createService(fiveBytesInGb);
            mockPipeline.mockImplementationOnce(
                async (source: Readable, byteGuard: any) => {
                    for await (const chunk of source) {
                        await new Promise<void>((resolve, reject) => {
                            byteGuard._transform(
                                Buffer.isBuffer(chunk)
                                    ? chunk
                                    : Buffer.from(chunk),
                                "buffer",
                                (error: Error | null) =>
                                    error ? reject(error) : resolve(),
                            );
                        });
                    }
                },
            );

            await expect(
                service.cacheFederatedStream(
                    "fed-track-overflow",
                    "original",
                    new Date("2026-08-15T12:00:00.000Z"),
                    "audio/flac",
                    async () => ({
                        stream: Readable.from(["123456"]),
                        mimeType: "audio/flac",
                        status: 200,
                        contentLength: null,
                    }),
                ),
            ).rejects.toThrow("Federated cache fill exceeded");

            const unlinkedPaths = mockFsUnlink.mock.calls.map(([value]) =>
                String(value),
            );
            expect(unlinkedPaths).toEqual([
                expect.stringContaining(".tmp-"),
                expect.stringMatching(/\.audio$/),
            ]);
            expect(mockFsRename).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.upsert).not.toHaveBeenCalled();
        });

        it("cleans both cache paths atomically when the file pipeline rejects", async () => {
            const service = createService();
            const writeFailure = new Error("cache write failed");
            mockPipeline.mockRejectedValueOnce(writeFailure);

            await expect(
                service.cacheFederatedStream(
                    "fed-track-write-failure",
                    "original",
                    new Date("2026-08-15T12:00:00.000Z"),
                    "audio/flac",
                    async () => ({
                        stream: Readable.from(["peer-audio"]),
                        mimeType: "audio/flac",
                        status: 200,
                        contentLength: null,
                    }),
                ),
            ).rejects.toBe(writeFailure);

            expect(
                mockFsUnlink.mock.calls.map(([value]) => String(value)),
            ).toEqual([
                expect.stringContaining(".tmp-"),
                expect.stringMatching(/\.audio$/),
            ]);
            expect(mockFsRename).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.upsert).not.toHaveBeenCalled();
        });
    });

    describe("transcodeToCache", () => {
        it("transcodes and persists cache record on success", async () => {
            const service = createService();
            const sourceModified = new Date("2025-01-10T00:00:00.000Z");

            mockFsStat.mockResolvedValueOnce({ size: 4 * 1024 * 1024 });

            const result = await (service as any).transcodeToCache(
                "track-success",
                "high",
                "/music/source.flac",
                sourceModified,
            );

            const expectedHash = crypto
                .createHash("md5")
                .update("track-success-high")
                .digest("hex");
            const expectedFileName = `${expectedHash}.mp3`;
            const expectedPath = `/cache/${expectedFileName}`;

            expect(result).toBe(expectedPath);
            expect(mockFfmpeg).toHaveBeenCalledWith("/music/source.flac");
            expect(ffmpegControl.lastCommand.audioBitrate).toHaveBeenCalledWith(
                QUALITY_SETTINGS.high.bitrate,
            );
            expect(ffmpegControl.lastCommand.audioCodec).toHaveBeenCalledWith(
                "libmp3lame",
            );
            expect(ffmpegControl.lastCommand.format).toHaveBeenCalledWith(
                "mp3",
            );
            expect(ffmpegControl.lastCommand.save).toHaveBeenCalledWith(
                expectedPath,
            );
            expect(mockPrisma.transcodedFile.upsert).toHaveBeenCalledWith({
                where: {
                    trackId_quality: {
                        trackId: "track-success",
                        quality: "high",
                    },
                },
                create: {
                    trackId: "track-success",
                    quality: "high",
                    cachePath: expectedFileName,
                    cacheSize: 4 * 1024 * 1024,
                    sourceModified,
                    lastAccessed: expect.any(Date),
                },
                update: {
                    cacheSize: 4 * 1024 * 1024,
                    sourceModified,
                    lastAccessed: expect.any(Date),
                },
            });
        });

        it("throws fatal ffmpeg-not-found error when ffmpeg reports missing binary", async () => {
            const service = createService();
            ffmpegControl.mode = "error";
            ffmpegControl.errorMessage = "ffmpeg executable not found";

            await expect(
                (service as any).transcodeToCache(
                    "track-fatal",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.FFMPEG_NOT_FOUND,
                category: ErrorCategory.FATAL,
            });
        });

        it("throws recoverable transcode error for non-ffmpeg failures", async () => {
            const service = createService();
            ffmpegControl.mode = "error";
            ffmpegControl.errorMessage = "decoder crashed";

            await expect(
                (service as any).transcodeToCache(
                    "track-recoverable",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.TRANSCODE_FAILED,
                category: ErrorCategory.RECOVERABLE,
            });
        });

        it("throws recoverable DB error when cache record persistence fails", async () => {
            const service = createService();
            mockFsStat.mockResolvedValueOnce({ size: 100 });
            mockPrisma.transcodedFile.upsert.mockRejectedValueOnce(
                new Error("db write failed"),
            );

            await expect(
                (service as any).transcodeToCache(
                    "track-db",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.DB_QUERY_ERROR,
                category: ErrorCategory.RECOVERABLE,
            });
        });

        it("throws fatal ffmpeg-not-found error when ffmpeg initialization throws", async () => {
            const service = createService();
            ffmpegControl.mode = "throw";

            await expect(
                (service as any).transcodeToCache(
                    "track-throw",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.FFMPEG_NOT_FOUND,
                category: ErrorCategory.FATAL,
            });
        });

        it("throws invalid-config error when quality has no transcoding settings", async () => {
            const service = createService();

            await expect(
                (service as any).transcodeToCache(
                    "track-invalid",
                    "original",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.INVALID_CONFIG,
                category: ErrorCategory.FATAL,
            });
        });

        it("rejects with AppError instances", async () => {
            const service = createService();
            ffmpegControl.mode = "error";
            ffmpegControl.errorMessage = "ffmpeg executable not found";

            await expect(
                (service as any).transcodeToCache(
                    "track-instance",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toBeInstanceOf(AppError);
        });

        it("deduplicates concurrent transcodes for the same track+quality", async () => {
            const service = createService();
            const sourceModified = new Date("2025-01-10T00:00:00.000Z");

            mockFsStat.mockResolvedValue({ size: 2 * 1024 * 1024 });

            const p1 = (service as any).transcodeToCache(
                "track-dedup",
                "high",
                "/music/source.flac",
                sourceModified,
            );
            const p2 = (service as any).transcodeToCache(
                "track-dedup",
                "high",
                "/music/source.flac",
                sourceModified,
            );

            const [r1, r2] = await Promise.all([p1, p2]);

            expect(r1).toBe(r2);
            // ffmpeg should only be invoked once for the deduplicated pair
            const ffmpegCallsForDedup = mockFfmpeg.mock.calls.filter(
                (call: any[]) => call[0] === "/music/source.flac",
            );
            expect(ffmpegCallsForDedup).toHaveLength(1);
            expect(mockPrisma.transcodedFile.upsert).toHaveBeenCalledTimes(1);
        });

        it("coalesces identical transcodes across service instances", async () => {
            const firstService = createService();
            const secondService = createService();
            const sourceModified = new Date("2025-01-10T00:00:00.000Z");
            ffmpegControl.mode = "pending";

            const first = (firstService as any).transcodeToCache(
                "track-shared-flight",
                "high",
                "/music/source.flac",
                sourceModified,
            );
            const second = (secondService as any).transcodeToCache(
                "track-shared-flight",
                "high",
                "/music/source.flac",
                sourceModified,
            );

            expect(second).toBe(first);
            await waitForFfmpegCommandCount(1);
            expect(mockFfmpeg).toHaveBeenCalledTimes(1);

            ffmpegControl.commands[0].__handlers.end();
            await expect(Promise.all([first, second])).resolves.toHaveLength(2);
            expect(mockPrisma.transcodedFile.upsert).toHaveBeenCalledTimes(1);
        });

        it("bounds concurrent transcodes across service instances", async () => {
            const firstService = createService();
            const secondService = createService();
            const sourceModified = new Date("2025-01-10T00:00:00.000Z");
            ffmpegControl.mode = "pending";

            const transcodes = [
                (firstService as any).transcodeToCache(
                    "track-concurrency-1",
                    "high",
                    "/music/source-1.flac",
                    sourceModified,
                ),
                (secondService as any).transcodeToCache(
                    "track-concurrency-2",
                    "high",
                    "/music/source-2.flac",
                    sourceModified,
                ),
                (firstService as any).transcodeToCache(
                    "track-concurrency-3",
                    "high",
                    "/music/source-3.flac",
                    sourceModified,
                ),
                (secondService as any).transcodeToCache(
                    "track-concurrency-4",
                    "high",
                    "/music/source-4.flac",
                    sourceModified,
                ),
            ];

            await waitForFfmpegCommandCount(3);
            expect(mockFfmpeg).toHaveBeenCalledTimes(3);

            ffmpegControl.commands[0].__handlers.end();
            await waitForFfmpegCommandCount(4);
            expect(mockFfmpeg).toHaveBeenCalledTimes(4);

            ffmpegControl.commands.slice(1).forEach((command) => {
                command.__handlers.end();
            });
            await expect(Promise.all(transcodes)).resolves.toHaveLength(4);
        });

        it("kills timed-out transcodes, removes partial output, and permits retry", async () => {
            const service = createService();
            const sourceModified = new Date("2025-01-10T00:00:00.000Z");
            let deadlineHandler: (() => void) | undefined;
            const setTimeoutSpy = jest
                .spyOn(global, "setTimeout")
                .mockImplementation(((handler: () => void, delay: number) => {
                    expect(delay).toBe(5 * 60 * 1000);
                    deadlineHandler = handler;
                    return 6789 as unknown as NodeJS.Timeout;
                }) as typeof setTimeout);
            ffmpegControl.mode = "pending";

            const timedOut = (service as any).transcodeToCache(
                "track-timeout",
                "high",
                "/music/source.flac",
                sourceModified,
            );
            await waitForFfmpegCommandCount(1);

            expect(deadlineHandler).toBeDefined();
            deadlineHandler?.();
            await expect(timedOut).rejects.toMatchObject({
                code: ErrorCode.TRANSCODE_FAILED,
                category: ErrorCategory.RECOVERABLE,
                message: expect.stringContaining("timed out"),
            });
            expect(ffmpegControl.commands[0].kill).toHaveBeenCalledWith(
                "SIGKILL",
            );
            expect(mockFsUnlinkCallback).toHaveBeenCalledWith(
                ffmpegControl.outputPath,
                expect.any(Function),
            );

            setTimeoutSpy.mockRestore();
            ffmpegControl.mode = "success";
            await expect(
                (service as any).transcodeToCache(
                    "track-timeout",
                    "high",
                    "/music/source.flac",
                    sourceModified,
                ),
            ).resolves.toEqual(expect.stringMatching(/\.mp3$/));
            expect(mockFfmpeg).toHaveBeenCalledTimes(2);
        });

        it("removes inflight entry after transcode failure so retries work", async () => {
            const service = createService();
            ffmpegControl.mode = "error";
            ffmpegControl.errorMessage = "encoding failed";

            await expect(
                (service as any).transcodeToCache(
                    "track-retry",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z"),
                ),
            ).rejects.toMatchObject({ name: "AppError" });

            // After failure, inflight map should be cleared so a retry can proceed
            ffmpegControl.mode = "success";
            mockFsStat.mockResolvedValueOnce({ size: 1024 });

            const result = await (service as any).transcodeToCache(
                "track-retry",
                "high",
                "/music/source.flac",
                new Date("2025-01-10T00:00:00.000Z"),
            );

            expect(result).toBeDefined();
        });
    });

    describe("getCacheSize", () => {
        it("returns total cache size in GB", async () => {
            const service = createService();
            const oneGb = 1024 * 1024 * 1024;

            mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
                { cacheSize: oneGb },
                { cacheSize: oneGb / 2 },
            ]);

            const size = await service.getCacheSize();

            expect(mockPrisma.transcodedFile.findMany).toHaveBeenCalledWith({
                select: { cacheSize: true },
            });
            expect(size).toBeCloseTo(1.5, 10);
        });
    });

    describe("evictCache", () => {
        it("does nothing when current size is already below target", async () => {
            const service = createService();
            jest.spyOn(service, "getCacheSize").mockResolvedValueOnce(0.4);

            await service.evictCache(1);

            expect(mockPrisma.transcodedFile.findMany).not.toHaveBeenCalled();
            expect(mockPrisma.transcodedFile.delete).not.toHaveBeenCalled();
        });

        it("evicts least-recently-used files until target is reached", async () => {
            const service = createService();
            const oneGb = 1024 * 1024 * 1024;
            jest.spyOn(service, "getCacheSize").mockResolvedValueOnce(2.0);

            mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
                {
                    id: "oldest",
                    cachePath: "oldest.mp3",
                    cacheSize: oneGb / 2,
                    lastAccessed: new Date("2024-01-01T00:00:00.000Z"),
                },
                {
                    id: "older",
                    cachePath: "older.mp3",
                    cacheSize: Math.floor(oneGb * 0.75),
                    lastAccessed: new Date("2024-01-02T00:00:00.000Z"),
                },
                {
                    id: "newest",
                    cachePath: "newest.mp3",
                    cacheSize: Math.floor(oneGb * 0.75),
                    lastAccessed: new Date("2024-01-03T00:00:00.000Z"),
                },
            ]);
            mockFsUnlink
                .mockRejectedValueOnce(new Error("unlink failed"))
                .mockResolvedValueOnce(undefined);

            await service.evictCache(1);

            expect(mockFsUnlink).toHaveBeenCalledWith("/cache/oldest.mp3");
            expect(mockFsUnlink).toHaveBeenCalledWith("/cache/older.mp3");
            expect(mockPrisma.transcodedFile.delete).toHaveBeenNthCalledWith(
                1,
                {
                    where: { id: "oldest" },
                },
            );
            expect(mockPrisma.transcodedFile.delete).toHaveBeenNthCalledWith(
                2,
                {
                    where: { id: "older" },
                },
            );
            expect(mockPrisma.transcodedFile.delete).toHaveBeenCalledTimes(2);
        });
    });

    describe("getMimeType", () => {
        it("returns mapped mime type for known extensions", () => {
            const service = createService();

            expect(service.getMimeType("/music/song.FLAC")).toBe("audio/flac");
            expect(service.getMimeType("/music/song.opus")).toBe("audio/opus");
        });

        it("falls back to audio/mpeg for unknown extensions", () => {
            const service = createService();

            expect(service.getMimeType("/music/song.unknown")).toBe(
                "audio/mpeg",
            );
        });
    });

    describe("streamFileWithRangeSupport", () => {
        it("streams full file with 200 when no range header is provided", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockConfig.allowedOrigins = ["https://client.example"];
            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockFsCreateReadStream.mockReturnValueOnce(stream);

            const req: any = {
                headers: {
                    origin: "https://client.example",
                },
            };
            const res = createMockResponse();

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            expect(mockParseRangeHeader).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.set).toHaveBeenCalledWith({
                "Content-Type": "audio/flac",
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000",
                "Content-Length": "1000",
                "Access-Control-Allow-Origin": "https://client.example",
                "Access-Control-Allow-Credentials": "true",
            });
            expect(mockFsCreateReadStream).toHaveBeenCalledWith(
                "/music/song.flac",
                { start: 0, end: 999 },
            );
            // pipeline() owns piping + teardown of both streams.
            expect(mockPipeline).toHaveBeenCalledWith(stream, res);
        });

        it("reflects an allowlisted origin with credentials when ALLOWED_ORIGINS is configured", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockConfig.allowedOrigins = ["https://client.example"];
            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockFsCreateReadStream.mockReturnValueOnce(stream);

            const req: any = {
                headers: {
                    origin: "https://client.example",
                },
            };
            const res = createMockResponse();

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            expect(res.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    "Access-Control-Allow-Origin": "https://client.example",
                    "Access-Control-Allow-Credentials": "true",
                }),
            );
        });

        it("omits CORS headers for origins outside the configured ALLOWED_ORIGINS allowlist", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockConfig.allowedOrigins = ["https://app.example"];
            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockFsCreateReadStream.mockReturnValueOnce(stream);

            const req: any = {
                headers: {
                    origin: "https://evil.example",
                },
            };
            const res = createMockResponse();

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            const headers = res.set.mock.calls[0][0];
            expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
            expect(headers).not.toHaveProperty(
                "Access-Control-Allow-Credentials",
            );
            // The stream itself is still served; only the credentialed CORS
            // reflection is withheld.
            expect(res.status).toHaveBeenCalledWith(200);
            expect(mockPipeline).toHaveBeenCalledWith(stream, res);
        });

        it("streams requested range with 206 and Content-Range", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockParseRangeHeader.mockReturnValueOnce({
                ok: true,
                start: 100,
                end: 199,
            });
            mockFsCreateReadStream.mockReturnValueOnce(stream);

            const req: any = {
                headers: {
                    range: "bytes=100-199",
                },
            };
            const res = createMockResponse();

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            expect(mockParseRangeHeader).toHaveBeenCalledWith(
                "bytes=100-199",
                1000,
            );
            expect(res.status).toHaveBeenCalledWith(206);
            expect(res.set).toHaveBeenCalledWith({
                "Content-Type": "audio/flac",
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000",
                "Content-Length": "100",
                "Content-Range": "bytes 100-199/1000",
            });
            expect(mockFsCreateReadStream).toHaveBeenCalledWith(
                "/music/song.flac",
                { start: 100, end: 199 },
            );
            expect(mockPipeline).toHaveBeenCalledWith(stream, res);
        });

        it("returns 416 for invalid range header", async () => {
            const service = createService();

            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockParseRangeHeader.mockReturnValueOnce({
                ok: false,
                status: 416,
            });

            const req: any = {
                headers: {
                    range: "bytes=5000-6000",
                },
            };
            const res = createMockResponse();

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            expect(res.status).toHaveBeenCalledWith(416);
            expect(res.set).toHaveBeenCalledWith({
                "Content-Range": "bytes */1000",
            });
            expect(res.end).toHaveBeenCalledTimes(1);
            expect(mockFsCreateReadStream).not.toHaveBeenCalled();
        });

        it("handles stream read errors by returning 500 when headers are not sent", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockFsCreateReadStream.mockReturnValueOnce(stream);
            mockPipeline.mockRejectedValueOnce(new Error("read failure"));

            const req: any = { headers: {} };
            const res = createMockResponse(false);

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            expect(res.status).toHaveBeenNthCalledWith(1, 200);
            expect(res.status).toHaveBeenNthCalledWith(2, 500);
            expect(res.end).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(
                "[AudioStreaming] Stream error for /music/song.flac:",
                expect.any(Error),
            );
        });

        it("ignores client aborts (ERR_STREAM_PREMATURE_CLOSE) without logging or 500", async () => {
            const service = createService();
            const stream = createMockReadStream();

            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockFsCreateReadStream.mockReturnValueOnce(stream);
            mockPipeline.mockRejectedValueOnce(
                Object.assign(new Error("aborted"), {
                    code: "ERR_STREAM_PREMATURE_CLOSE",
                }),
            );

            const req: any = { headers: {} };
            const res = createMockResponse(false);

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac",
            );

            // 200 set up front; the abort must not produce a 500 or an error log.
            expect(res.status).toHaveBeenCalledTimes(1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe("destroy", () => {
        it("clears eviction interval exactly once", () => {
            const service = createService();

            service.destroy();
            service.destroy();

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearIntervalSpy).toHaveBeenCalledWith(
                12345 as unknown as NodeJS.Timeout,
            );
        });
    });
});
