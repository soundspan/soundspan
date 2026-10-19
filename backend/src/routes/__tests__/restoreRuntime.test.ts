const mockUserCount = jest.fn();
const mockGetStatus = jest.fn();
const mockUploadActive = jest.fn();
const mockRestoreLockHeld = jest.fn();
const mockRestartRequired = jest.fn();
const mockCancelUpload = jest.fn();
const mockSetStatus = jest.fn();
const mockParseRestoreChunk = jest.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
);
const mockBeginRestoreCompletion = jest.fn();
const mockUnwrapEncryptionKey = jest.fn();
const mockCreateRestoreUpload = jest.fn();

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
jest.mock("../../middleware/restoreChunkBody", () => ({
    parseRestoreChunk: mockParseRestoreChunk,
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
    beginRestoreCompletion: mockBeginRestoreCompletion,
    cancelRestoreUpload: mockCancelUpload,
    claimCompletedRestoreUpload: jest.fn(),
    completeRestoreUpload: jest.fn(),
    createRestoreUpload: mockCreateRestoreUpload,
    getActiveRestoreUpload: mockUploadActive,
    releaseRestoreCompletion: jest.fn(),
    MAX_RESTORE_SIZE_BYTES: 256 * 1024 * 1024 * 1024,
    RESTORE_CHUNK_SIZE_BYTES: 4 * 1024 * 1024,
    writeRestoreChunk: jest.fn(),
}));
jest.mock("../../services/backup/restoreLock", () => ({
    isRestoreLockHeld: mockRestoreLockHeld,
}));
jest.mock("../../services/backup/restartRequired", () => ({
    isRestartRequired: mockRestartRequired,
}));
jest.mock("../../services/backup/backupArchiveReader", () => ({
    readBackupHeader: jest.fn(),
}));
jest.mock("../../services/backup/backupKeyWrap", () => ({
    unwrapEncryptionKey: mockUnwrapEncryptionKey,
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
        mockUploadActive.mockResolvedValue(null);
        mockRestoreLockHeld.mockResolvedValue(false);
        mockRestartRequired.mockResolvedValue(false);
        mockCancelUpload.mockResolvedValue(false);
        mockBeginRestoreCompletion.mockResolvedValue(undefined);
        mockCreateRestoreUpload.mockResolvedValue({
            uploadId: "x".repeat(43),
            chunkSizeBytes: 4 * 1024 * 1024,
            totalChunks: 1,
            expiresAt: "2026-10-19T12:15:00.000Z",
        });
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
            upload: null,
        });
    });

    it("returns the live upload expiry in status", async () => {
        mockUploadActive.mockResolvedValue({
            expiresAt: "2026-10-19T12:15:00.000Z",
        });
        const res = response();
        await handler("/status", "get")({}, res, jest.fn());
        expect(res.body.upload).toEqual({
            expiresAt: "2026-10-19T12:15:00.000Z",
        });
        expect(res.body.available).toBe(false);
    });

    it("returns 503 when restore status cannot be read", async () => {
        const { RestoreError } =
            await import("../../services/backup/backupErrors");
        mockGetStatus.mockRejectedValue(
            new RestoreError(
                "RESTORE_STATUS_UNAVAILABLE",
                "Restore status is temporarily unavailable",
            ),
        );
        const res = response();
        await handler("/status", "get")({}, res, jest.fn());
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Restore status is temporarily unavailable",
            code: "RESTORE_STATUS_UNAVAILABLE",
        });
    });

    it("does not query users while the restore lock is held", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        mockGetStatus.mockResolvedValue({
            state: "loading",
            progress: null,
            error: null,
            summary: null,
        });
        const res = response();
        await handler("/status", "get")({}, res, jest.fn());
        expect(mockUserCount).not.toHaveBeenCalled();
        expect(res.body.available).toBe(false);
    });

    it("hides restore details after setup when no restart is pending", async () => {
        mockUserCount.mockResolvedValue(1);
        mockGetStatus.mockResolvedValue({
            state: "complete",
            progress: { completedRows: 4 },
            error: { code: "SECRET", message: "detail" },
            summary: { rows: 4, backupAppVersion: "old" },
        });
        const res = response();
        await handler("/status", "get")({}, res, jest.fn());
        expect(res.body).toEqual({
            available: false,
            state: "complete",
            restartRequired: false,
            progress: null,
            error: null,
            summary: null,
            upload: null,
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

    it("checks the restore lock before the fresh-install user count", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        const res = response();
        await handler("/uploads", "post")(
            { body: { sizeBytes: 1 } },
            res,
            jest.fn(),
        );
        expect(res.statusCode).toBe(409);
        expect(mockUserCount).not.toHaveBeenCalled();
    });

    it("checks availability before parsing a chunk body", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        const layer = (router as any).stack.find(
            (entry: any) =>
                entry.route?.path === "/uploads/:uploadId/chunks/:index",
        );
        const precondition = layer.route.stack[1].handle;
        const res = response();
        const next = jest.fn();
        await precondition({}, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(mockParseRestoreChunk).not.toHaveBeenCalled();
        expect(mockUserCount).not.toHaveBeenCalled();
    });

    it("rejects a concurrent completion before passphrase derivation", async () => {
        const { RestoreError } =
            await import("../../services/backup/backupErrors");
        mockBeginRestoreCompletion.mockRejectedValue(
            new RestoreError(
                "RESTORE_IN_PROGRESS",
                "A restore is already in progress",
            ),
        );
        const res = response();
        await handler("/uploads/:uploadId/complete", "post")(
            {
                params: { uploadId: "x".repeat(43) },
                body: { passphrase: "long-enough-passphrase" },
            },
            res,
            jest.fn(),
        );
        expect(res.statusCode).toBe(409);
        expect(mockUnwrapEncryptionKey).not.toHaveBeenCalled();
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

    it("returns 507 when restore staging is unavailable", async () => {
        const { RestoreError } =
            await import("../../services/backup/backupErrors");
        mockCreateRestoreUpload.mockRejectedValue(
            new RestoreError(
                "RESTORE_STAGING_UNAVAILABLE",
                "Restore staging storage is unavailable",
            ),
        );
        const res = response();
        await handler("/uploads", "post")(
            { body: { sizeBytes: 1 } },
            res,
            jest.fn(),
        );
        expect(res.statusCode).toBe(507);
        expect(res.body).toEqual({
            error: "Restore staging storage is unavailable",
            code: "RESTORE_STAGING_UNAVAILABLE",
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
