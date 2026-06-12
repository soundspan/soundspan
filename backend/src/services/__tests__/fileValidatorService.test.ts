const mockFsAccess = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockLibraryHealthUpsert = jest.fn();
const mockLibraryHealthDeleteMany = jest.fn();

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
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
        },
        libraryHealthRecord: {
            upsert: (...args: unknown[]) => mockLibraryHealthUpsert(...args),
            deleteMany: (...args: unknown[]) => mockLibraryHealthDeleteMany(...args),
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
        mockLibraryHealthUpsert.mockResolvedValue({});
        mockLibraryHealthDeleteMany.mockResolvedValue({});
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
        expect(result.tracksRemoved).toBe(0);
        expect(result.tracksMissing.sort()).toEqual(["missing", "traversal"]);
        expect(result.duration).toBeGreaterThanOrEqual(0);
        const missingRecordCall = mockLibraryHealthUpsert.mock.calls.find(
            ([arg]) => arg.where?.trackId === "missing"
        )?.[0];
        const traversalRecordCall = mockLibraryHealthUpsert.mock.calls.find(
            ([arg]) => arg.where?.trackId === "traversal"
        )?.[0];

        expect(missingRecordCall).toBeDefined();
        expect(traversalRecordCall).toBeDefined();
        expect(missingRecordCall.update.status).toBe("MISSING_FROM_DISK");
        expect(traversalRecordCall.update.status).toBe("MISSING_FROM_DISK");
        expect(mockLibraryHealthUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { trackId: "missing" },
                update: expect.objectContaining({
                    status: "MISSING_FROM_DISK",
                    filePath: "missing.mp3",
                }),
            })
        );
        expect(mockLibraryHealthUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { trackId: "traversal" },
                update: expect.objectContaining({
                    filePath: "../../etc/passwd",
                }),
            })
        );
        expect(mockLibraryHealthDeleteMany).toHaveBeenCalledWith({
            where: {
                trackId: {
                    in: expect.arrayContaining(
                        Array.from({ length: 100 }, (_, i) => `ok-${i}`)
                    ),
                },
                status: "MISSING_FROM_DISK",
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

    it("clears health records when all tracks are healthy", async () => {
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
        expect(mockLibraryHealthUpsert).not.toHaveBeenCalled();
        expect(mockLibraryHealthDeleteMany).toHaveBeenCalledWith({
            where: {
                trackId: {
                    in: ["ok"],
                },
                status: "MISSING_FROM_DISK",
            },
        });
    });

    it("returns false when validateTrack cannot find the track", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce(null);

        await expect(service.validateTrack("missing-track-id")).resolves.toBe(false);
        expect(mockLibraryHealthUpsert).not.toHaveBeenCalled();
        expect(mockLibraryHealthDeleteMany).not.toHaveBeenCalled();
    });

    it("marks validateTrack path traversal tracks as missing-from-disk health issues with detail", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-1",
            filePath: "../escape.mp3",
            title: "Escape",
        });

        await expect(service.validateTrack("track-1")).resolves.toBe(false);
        expect(mockLibraryHealthUpsert).toHaveBeenCalledWith({
            where: { trackId: "track-1" },
            update: {
                status: "MISSING_FROM_DISK",
                filePath: "../escape.mp3",
                detail: "Path traversal attempt detected during validation",
            },
            create: {
                trackId: "track-1",
                status: "MISSING_FROM_DISK",
                filePath: "../escape.mp3",
                detail: "Path traversal attempt detected during validation",
            },
        });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[FileValidator] Path traversal attempt detected: ../escape.mp3"
        );
    });

    it("marks missing single tracks and returns false", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-2",
            filePath: "missing-track.mp3",
            title: "Missing Track",
        });
        mockFsAccess.mockRejectedValueOnce(new Error("ENOENT"));

        await expect(service.validateTrack("track-2")).resolves.toBe(false);
        expect(mockLibraryHealthUpsert).toHaveBeenCalledWith({
            where: { trackId: "track-2" },
            update: {
                status: "MISSING_FROM_DISK",
                filePath: "missing-track.mp3",
                detail: null,
            },
            create: {
                trackId: "track-2",
                status: "MISSING_FROM_DISK",
                filePath: "missing-track.mp3",
                detail: null,
            },
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[FileValidator] Track file missing, recording health issue: Missing Track"
        );
    });

    it("clears health records for valid single tracks that exist", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-3",
            filePath: "exists.mp3",
            title: "Exists",
        });
        mockFsAccess.mockResolvedValueOnce(undefined);

        await expect(service.validateTrack("track-3")).resolves.toBe(true);
        expect(mockLibraryHealthDeleteMany).toHaveBeenCalledWith({
            where: {
                trackId: "track-3",
                status: "MISSING_FROM_DISK",
            },
        });
        expect(mockLibraryHealthUpsert).not.toHaveBeenCalled();
    });

    it("preserves unreadable metadata health records for tracks that still exist", async () => {
        const service = new FileValidatorService();
        mockFindUnique.mockResolvedValueOnce({
            id: "track-4",
            filePath: "exists.mp3",
            title: "Exists",
        });
        mockFsAccess.mockResolvedValueOnce(undefined);

        await expect(service.validateTrack("track-4")).resolves.toBe(true);

        expect(mockLibraryHealthDeleteMany).toHaveBeenCalledWith({
            where: {
                trackId: "track-4",
                status: "MISSING_FROM_DISK",
            },
        });
    });
});
