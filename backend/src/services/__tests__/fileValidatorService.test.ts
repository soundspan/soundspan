const mockFsAccess = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockFindMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockFindUnique = jest.fn();
const mockDelete = jest.fn();

jest.mock("fs", () => ({
    promises: {
        access: (...args: unknown[]) => mockFsAccess(...args),
    },
    constants: {
        F_OK: 0,
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
            deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            delete: (...args: unknown[]) => mockDelete(...args),
        },
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
        },
    },
}));

jest.mock("p-queue", () => ({
    __esModule: true,
    default: class MockPQueue {
        add<T>(task: () => Promise<T>): Promise<T> {
            return task();
        }

        onIdle(): Promise<void> {
            return Promise.resolve();
        }
    },
}));

import { FileValidatorService } from "../fileValidator";

describe("FileValidatorService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeleteMany.mockResolvedValue({});
        mockDelete.mockResolvedValue({});
        mockFsAccess.mockResolvedValue(undefined);
    });

    it("validates the library with traversal, missing files, progress logs, and per-track errors", async () => {
        const service = new FileValidatorService();

        const tracks = [
            ...Array.from({ length: 100 }, (_, i) => ({
                id: `ok-${i}`,
                filePath: `ok-${i}.mp3`,
                title: `Track ${i}`,
            })),
            {
                id: "traversal",
                filePath: "../../etc/passwd",
                title: "Traversal",
            },
            {
                id: "missing",
                filePath: "missing.mp3",
                title: "Missing",
            },
            {
                id: "error",
                filePath: undefined as unknown as string,
                title: "Error Track",
            },
        ];

        mockFindMany.mockResolvedValue(tracks);
        mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (String(candidatePath).includes("missing.mp3")) {
                throw new Error("ENOENT");
            }
            return undefined;
        });

        const result = await service.validateLibrary();

        expect(result.tracksChecked).toBe(102);
        expect(result.tracksRemoved).toBe(2);
        expect(result.tracksMissing.sort()).toEqual(["missing", "traversal"]);
        expect(result.duration).toBeGreaterThanOrEqual(0);
        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: {
                id: {
                    in: expect.arrayContaining(["traversal", "missing"]),
                },
            },
        });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[FileValidator] Path traversal attempt detected: ../../etc/passwd"
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[FileValidator] Error checking undefined:",
            expect.any(String)
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            expect.stringMatching(
                /\[FileValidator\] Progress: 100\/\d+ tracks checked, \d+ missing/
            )
        );
    });

    it("skips deleteMany when no tracks are missing", async () => {
        const service = new FileValidatorService();
        mockFindMany.mockResolvedValue([
            {
                id: "ok",
                filePath: "ok.mp3",
                title: "OK",
            },
        ]);
        mockFsAccess.mockResolvedValue(undefined);

        const result = await service.validateLibrary();

        expect(result).toEqual(
            expect.objectContaining({
                tracksChecked: 1,
                tracksRemoved: 0,
                tracksMissing: [],
            })
        );
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it("returns false when validateTrack cannot find the track", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce(null);

        await expect(service.validateTrack("missing-track-id")).resolves.toBe(false);
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it("returns false on validateTrack path traversal attempts", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-1",
            filePath: "../escape.mp3",
            title: "Escape",
        });

        await expect(service.validateTrack("track-1")).resolves.toBe(false);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[FileValidator] Path traversal attempt detected: ../escape.mp3"
        );
    });

    it("removes missing single tracks and returns false", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-2",
            filePath: "missing-track.mp3",
            title: "Missing Track",
        });
        mockFsAccess.mockRejectedValueOnce(new Error("ENOENT"));

        await expect(service.validateTrack("track-2")).resolves.toBe(false);
        expect(mockDelete).toHaveBeenCalledWith({
            where: { id: "track-2" },
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[FileValidator] Track file missing, removing from DB: Missing Track"
        );
    });

    it("returns true for valid single tracks that exist", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-3",
            filePath: "exists.mp3",
            title: "Exists",
        });
        mockFsAccess.mockResolvedValueOnce(undefined);

        await expect(service.validateTrack("track-3")).resolves.toBe(true);
        expect(mockDelete).not.toHaveBeenCalled();
    });
});
