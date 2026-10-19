const mockUserCount = jest.fn();
const mockGetStatus = jest.fn();
const mockUploadActive = jest.fn();
const mockRestartRequired = jest.fn();
const mockCancelUpload = jest.fn();
const mockSetStatus = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: { user: { count: mockUserCount } },
}));
jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
    restoreChunkLimiter: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    restoreMutationLimiter: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));
jest.mock("../../services/backup/restoreJob", () => ({
    getRestoreStatus: mockGetStatus,
    isRestoreJobActive: (status: { state: string }) =>
        [
            "validating",
            "resetting",
            "replaying",
            "loading",
            "migrating",
            "reencrypting",
        ].includes(status.state),
    setRestoreStatus: mockSetStatus,
    startRestoreJob: jest.fn(),
}));
jest.mock("../../services/backup/restoreUploads", () => ({
    cancelRestoreUpload: mockCancelUpload,
    claimCompletedRestoreUpload: jest.fn(),
    completeRestoreUpload: jest.fn(),
    createRestoreUpload: jest.fn(),
    hasActiveRestoreUpload: mockUploadActive,
    MAX_RESTORE_SIZE_BYTES: 256 * 1024 * 1024 * 1024,
    RESTORE_CHUNK_SIZE_BYTES: 4 * 1024 * 1024,
    writeRestoreChunk: jest.fn(),
}));
jest.mock("../../services/backup/restartRequired", () => ({
    isRestartRequired: mockRestartRequired,
}));
jest.mock("../../services/backup/backupArchiveReader", () => ({
    readBackupHeader: jest.fn(),
}));
jest.mock("../../services/backup/backupKeyWrap", () => ({
    unwrapEncryptionKey: jest.fn(),
}));
jest.mock("../../services/backup/restoreCompatibility", () => ({
    evaluateRestoreCompatibility: jest.fn(),
    readImageMigrations: jest.fn(),
}));
jest.mock("../../config/appVersion", () => ({
    resolveAppVersion: () => "2.6.1",
}));

import router from "../restore";

function handler(path: string, method: "get" | "post" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route.methods[method],
    );
    return layer.route.stack.at(-1).handle;
}

function response() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
        sendStatus: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
    };
    return res;
}

describe("restore routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUserCount.mockResolvedValue(0);
        mockUploadActive.mockResolvedValue(false);
        mockRestartRequired.mockResolvedValue(false);
        mockCancelUpload.mockResolvedValue(false);
        mockGetStatus.mockResolvedValue({
            state: "idle",
            progress: null,
            error: null,
            summary: null,
        });
    });

    it("returns the exact status envelope", async () => {
        const res = response();
        await handler("/status", "get")({}, res, jest.fn());
        expect(res.body).toEqual({
            available: true,
            state: "idle",
            progress: null,
            error: null,
            summary: null,
            restartRequired: false,
        });
    });

    it("returns 403 when upload creation is unavailable after setup", async () => {
        mockUserCount.mockResolvedValue(1);
        const res = response();
        await handler("/uploads", "post")(
            { body: { sizeBytes: 1 } },
            res,
            jest.fn(),
        );
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
            error: "Restore is unavailable after setup",
            code: "RESTORE_UNAVAILABLE",
        });
    });

    it("returns 413 for a declared backup above the hard bound", async () => {
        const res = response();
        await handler("/uploads", "post")(
            { body: { sizeBytes: 256 * 1024 * 1024 * 1024 + 1 } },
            res,
            jest.fn(),
        );
        expect(res.statusCode).toBe(413);
        expect(res.body).toEqual({
            error: "Backup exceeds the size limit",
            code: "BACKUP_TOO_LARGE",
        });
    });

    it("resets uploading status only when that upload was cancelled", async () => {
        mockCancelUpload.mockResolvedValue(true);
        mockGetStatus.mockResolvedValue({
            state: "uploading",
            progress: null,
            error: null,
            summary: null,
        });
        const res = response();
        await handler("/uploads/:uploadId", "delete")(
            { params: { uploadId: "x".repeat(43) } },
            res,
            jest.fn(),
        );
        expect(mockSetStatus).toHaveBeenCalledWith({
            state: "idle",
            progress: null,
            error: null,
            summary: null,
        });
    });

    it("preserves completed status when no upload was cancelled", async () => {
        mockGetStatus.mockResolvedValue({
            state: "complete",
            progress: null,
            error: null,
            summary: { rows: 10 },
        });
        const res = response();
        await handler("/uploads/:uploadId", "delete")(
            { params: { uploadId: "x".repeat(43) } },
            res,
            jest.fn(),
        );
        expect(mockSetStatus).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(204);
    });
});
