import * as crypto from "crypto";

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

const mockFsExistsSync = jest.fn();
const mockFsMkdirSync = jest.fn();
const mockFsCreateReadStream = jest.fn();
const mockFsStat = jest.fn();
const mockFsUnlink = jest.fn();

const mockPrisma = {
    transcodedFile: {
        findFirst: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
    },
};

const mockParseFile = jest.fn();
const mockParseRangeHeader = jest.fn();

type FfmpegMode = "success" | "error" | "throw";

const ffmpegControl: {
    mode: FfmpegMode;
    errorMessage: string;
    outputPath?: string;
    lastCommand?: any;
} = {
    mode: "success",
    errorMessage: "",
};

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
    return command;
});

jest.mock("fs", () => ({
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    createReadStream: mockFsCreateReadStream,
    promises: {
        stat: mockFsStat,
        unlink: mockFsUnlink,
    },
}));

jest.mock("p-queue", () => {
    return class MockPQueue {
        constructor(_options?: unknown) {}

        add<T>(task: () => Promise<T> | T): Promise<T> {
            return Promise.resolve().then(task);
        }
    };
});

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("music-metadata", () => ({
    parseFile: mockParseFile,
}), { virtual: true });

jest.mock("../../utils/rangeParser", () => ({
    parseRangeHeader: mockParseRangeHeader,
}));

jest.mock("@ffmpeg-installer/ffmpeg", () => ({
    __esModule: true,
    default: {
        path: "/mock/bin/ffmpeg",
    },
}));

jest.mock("fluent-ffmpeg", () => ({
    __esModule: true,
    default: Object.assign(mockFfmpeg, {
        setFfmpegPath: mockSetFfmpegPath,
    }),
}));

import {
    AudioStreamingService,
    QUALITY_SETTINGS,
} from "../audioStreaming";
import { AppError, ErrorCategory, ErrorCode } from "../../utils/errors";

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

    beforeEach(() => {
        jest.clearAllMocks();

        ffmpegControl.mode = "success";
        ffmpegControl.errorMessage = "";
        ffmpegControl.outputPath = undefined;
        ffmpegControl.lastCommand = undefined;

        setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockReturnValue(12345 as unknown as NodeJS.Timeout);
        clearIntervalSpy = jest
            .spyOn(global, "clearInterval")
            .mockImplementation(() => undefined);

        mockFsExistsSync.mockReturnValue(true);
        mockFsMkdirSync.mockReturnValue(undefined);
        mockFsCreateReadStream.mockReturnValue(createMockReadStream());
        mockFsStat.mockResolvedValue({ size: 1024 });
        mockFsUnlink.mockResolvedValue(undefined);

        mockPrisma.transcodedFile.findFirst.mockResolvedValue(null);
        mockPrisma.transcodedFile.delete.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.update.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.create.mockResolvedValue(undefined);
        mockPrisma.transcodedFile.findMany.mockResolvedValue([]);

        mockParseFile.mockResolvedValue({ format: { bitrate: 500000 } });
        mockParseRangeHeader.mockReturnValue({ ok: true, start: 0, end: 99 });
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
                "/music/source.flac"
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
                "/music/source.flac"
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
            mockParseFile.mockResolvedValueOnce({ format: { bitrate: 512000 } });

            const sourceModified = new Date("2025-01-01T00:00:00.000Z");
            const result = await service.getStreamFilePath(
                "track-2",
                "high",
                sourceModified,
                "/music/source.flac"
            );

            expect(mockPrisma.transcodedFile.delete).toHaveBeenCalledWith({
                where: { id: "cache-stale" },
            });
            expect(mockFsUnlink).toHaveBeenCalledWith("/cache/stale-file.mp3");
            expect(transcodeSpy).toHaveBeenCalledWith(
                "track-2",
                "high",
                "/music/source.flac",
                sourceModified
            );
            expect(result).toEqual({
                filePath: "/cache/new-file.mp3",
                mimeType: "audio/mpeg",
            });
        });

        it("serves original file when source bitrate is below target to avoid upsampling", async () => {
            const service = createService();
            const transcodeSpy = jest.spyOn(service as any, "transcodeToCache");

            mockParseFile.mockResolvedValueOnce({ format: { bitrate: 192000 } });

            const result = await service.getStreamFilePath(
                "track-3",
                "high",
                new Date("2025-01-01T00:00:00.000Z"),
                "/music/source.m4a"
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
            const evictSpy = jest.spyOn(service, "evictCache").mockResolvedValue();

            mockParseFile.mockRejectedValueOnce(new Error("metadata unavailable"));
            const oneGb = 1024 * 1024 * 1024;
            mockPrisma.transcodedFile.findMany.mockResolvedValueOnce([
                { cacheSize: Math.floor(oneGb * 1.95) },
            ]);

            const result = await service.getStreamFilePath(
                "track-4",
                "high",
                new Date("2025-01-01T00:00:00.000Z"),
                "/music/source.flac"
            );

            expect(mockLogger.warn).toHaveBeenCalledWith(
                "[STREAM] Failed to read source metadata, will transcode anyway:",
                expect.any(Error)
            );
            expect(evictSpy).toHaveBeenCalledWith(1.6);
            expect(transcodeSpy).toHaveBeenCalledWith(
                "track-4",
                "high",
                "/music/source.flac",
                new Date("2025-01-01T00:00:00.000Z")
            );
            expect(result).toEqual({
                filePath: "/cache/fallback.mp3",
                mimeType: "audio/mpeg",
            });
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
                sourceModified
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
                QUALITY_SETTINGS.high.bitrate
            );
            expect(ffmpegControl.lastCommand.audioCodec).toHaveBeenCalledWith(
                "libmp3lame"
            );
            expect(ffmpegControl.lastCommand.format).toHaveBeenCalledWith("mp3");
            expect(ffmpegControl.lastCommand.save).toHaveBeenCalledWith(expectedPath);
            expect(mockPrisma.transcodedFile.create).toHaveBeenCalledWith({
                data: {
                    trackId: "track-success",
                    quality: "high",
                    cachePath: expectedFileName,
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
                    new Date("2025-01-10T00:00:00.000Z")
                )
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
                    new Date("2025-01-10T00:00:00.000Z")
                )
            ).rejects.toMatchObject({
                name: "AppError",
                code: ErrorCode.TRANSCODE_FAILED,
                category: ErrorCategory.RECOVERABLE,
            });
        });

        it("throws recoverable DB error when cache record persistence fails", async () => {
            const service = createService();
            mockFsStat.mockResolvedValueOnce({ size: 100 });
            mockPrisma.transcodedFile.create.mockRejectedValueOnce(
                new Error("db write failed")
            );

            await expect(
                (service as any).transcodeToCache(
                    "track-db",
                    "high",
                    "/music/source.flac",
                    new Date("2025-01-10T00:00:00.000Z")
                )
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
                    new Date("2025-01-10T00:00:00.000Z")
                )
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
                    new Date("2025-01-10T00:00:00.000Z")
                )
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
                    new Date("2025-01-10T00:00:00.000Z")
                )
            ).rejects.toBeInstanceOf(AppError);
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
            expect(mockPrisma.transcodedFile.delete).toHaveBeenNthCalledWith(1, {
                where: { id: "oldest" },
            });
            expect(mockPrisma.transcodedFile.delete).toHaveBeenNthCalledWith(2, {
                where: { id: "older" },
            });
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

            expect(service.getMimeType("/music/song.unknown")).toBe("audio/mpeg");
        });
    });

    describe("streamFileWithRangeSupport", () => {
        it("streams full file with 200 when no range header is provided", async () => {
            const service = createService();
            const stream = createMockReadStream();

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
                "audio/flac"
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
                { start: 0, end: 999 }
            );
            expect(stream.pipe).toHaveBeenCalledWith(res);

            res.emit("close");
            expect(stream.destroy).toHaveBeenCalledTimes(1);
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
                "audio/flac"
            );

            expect(mockParseRangeHeader).toHaveBeenCalledWith("bytes=100-199", 1000);
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
                { start: 100, end: 199 }
            );
            expect(stream.pipe).toHaveBeenCalledWith(res);
        });

        it("returns 416 for invalid range header", async () => {
            const service = createService();

            mockFsStat.mockResolvedValueOnce({ size: 1000 });
            mockParseRangeHeader.mockReturnValueOnce({ ok: false, status: 416 });

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
                "audio/flac"
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

            const req: any = { headers: {} };
            const res = createMockResponse(false);

            await service.streamFileWithRangeSupport(
                req,
                res as any,
                "/music/song.flac",
                "audio/flac"
            );

            stream.emit("error", new Error("read failure"));

            expect(res.status).toHaveBeenNthCalledWith(1, 200);
            expect(res.status).toHaveBeenNthCalledWith(2, 500);
            expect(res.end).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(
                "[AudioStreaming] Stream error for /music/song.flac:",
                expect.any(Error)
            );
        });
    });

    describe("destroy", () => {
        it("clears eviction interval exactly once", () => {
            const service = createService();

            service.destroy();
            service.destroy();

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearIntervalSpy).toHaveBeenCalledWith(
                12345 as unknown as NodeJS.Timeout
            );
        });
    });
});
