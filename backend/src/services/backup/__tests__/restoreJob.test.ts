import { RestoreError, RestoreMigrationError } from "../backupErrors";
import { EventEmitter } from "events";
import { Client } from "pg";

const mockClientConnect = jest.fn();
const mockClientEnd = jest.fn();
const mockClientQuery = jest.fn();
const mockSetStatus = jest.fn();
const mockValidate = jest.fn();
const mockReadImageMigrations = jest.fn();
const mockEvaluateCompatibility = jest.fn();
const mockResetSchema = jest.fn();
const mockReplayMigrations = jest.fn();
const mockDeployMigrations = jest.fn();
const mockLoadData = jest.fn();
const mockReencrypt = jest.fn();
const mockReleaseUpload = jest.fn();
const mockMarkRestart = jest.fn();
const mockUserCount = jest.fn();
const mockRm = jest.fn();
const mockUnlink = jest.fn();
const mockLoggerError = jest.fn();
const mockClient = Object.assign(new EventEmitter(), {
    connect: mockClientConnect,
    end: mockClientEnd,
    query: mockClientQuery,
});

jest.mock("pg", () => ({
    Client: jest.fn(() => mockClient),
}));
jest.mock("fs/promises", () => ({
    __esModule: true,
    default: { rm: mockRm, unlink: mockUnlink },
}));
jest.mock("../../../config", () => ({
    config: {
        databaseUrl: "postgresql://user:password@database/soundspan",
        music: { transcodeCachePath: "/tmp/cache/transcodes" },
    },
}));
jest.mock("../../../config/appVersion", () => ({
    resolveAppVersion: () => "2.6.1",
}));
jest.mock("../../../utils/encryption", () => ({
    getSettingsEncryptionKey: () => "current-key",
}));
jest.mock("../../../utils/db", () => ({
    prisma: { user: { count: mockUserCount } },
}));
jest.mock("../../../utils/apiKeyHash", () => ({
    getPepperFingerprint: () => "pepper",
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            error: mockLoggerError,
            info: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));
jest.mock("../backupArchiveReader", () => ({
    validateBackupArchive: mockValidate,
}));
jest.mock("../restoreCompatibility", () => ({
    evaluateRestoreCompatibility: mockEvaluateCompatibility,
    readImageMigrations: mockReadImageMigrations,
}));
jest.mock("../restoreSchemaReset", () => ({
    resetApplicationSchema: mockResetSchema,
}));
jest.mock("../restoreMigrationReplay", () => ({
    replayBackupMigrations: mockReplayMigrations,
    deployCurrentMigrations: mockDeployMigrations,
}));
jest.mock("../restoreDataLoad", () => ({ loadBackupData: mockLoadData }));
jest.mock("../restoreReencrypt", () => ({
    reencryptRestoredCredentials: mockReencrypt,
}));
jest.mock("../restoreUploads", () => ({
    releaseRestoreUpload: mockReleaseUpload,
    restoreStagingDirectory: () => "/tmp/cache/restore-staging",
}));
jest.mock("../restartRequired", () => ({
    markRestartRequired: mockMarkRestart,
}));
jest.mock("../restoreStatus", () => ({
    setRestoreStatus: mockSetStatus,
}));

import { startRestoreJob } from "../restoreJob";

const validation = {
    header: {
        createdAt: "2026-10-19T12:00:00.000Z",
        appVersion: "2.5.0",
        pepperFingerprint: "pepper",
        tables: [{ name: "User", columns: [], rowCount: 2 }],
    },
    rows: 2,
};

const jobOptions = {
    uploadId: "upload-id",
    filePath: "/tmp/restore.upload",
    backupKey: "backup-key",
    backupPepperFingerprint: "pepper",
    macKey: Buffer.alloc(32),
};

async function waitForTerminalStatus(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
            mockSetStatus.mock.calls.some(
                ([status]) =>
                    status.state === "complete" || status.state === "failed",
            )
        ) {
            return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Detached restore did not reach a terminal status");
}

describe("restore job", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClientConnect.mockResolvedValue(undefined);
        mockClientEnd.mockResolvedValue(undefined);
        mockClientQuery.mockImplementation(async (sql: string) =>
            sql.includes("pg_try_advisory_lock")
                ? { rows: [{ acquired: true }] }
                : { rows: [{ pg_advisory_unlock: true }] },
        );
        mockSetStatus.mockResolvedValue(undefined);
        mockValidate.mockResolvedValue(validation);
        mockReadImageMigrations.mockResolvedValue([]);
        mockEvaluateCompatibility.mockReturnValue({
            outcome: "ok",
            migrationsToReplay: [],
            pendingAfterLoad: 0,
            checksumWarnings: [],
        });
        mockResetSchema.mockResolvedValue(undefined);
        mockReplayMigrations.mockResolvedValue(undefined);
        mockDeployMigrations.mockResolvedValue(undefined);
        mockLoadData.mockResolvedValue(undefined);
        mockReencrypt.mockResolvedValue({
            credentialsReencrypted: 1,
            credentialsUndecryptable: 0,
            processedColumns: [],
        });
        mockReleaseUpload.mockResolvedValue(undefined);
        mockMarkRestart.mockResolvedValue(undefined);
        mockUserCount.mockResolvedValue(0);
        mockRm.mockResolvedValue(undefined);
        mockUnlink.mockResolvedValue(undefined);
    });

    it("fails immediately when the advisory lock is already held", async () => {
        mockClientQuery.mockResolvedValueOnce({ rows: [{ acquired: false }] });
        await expect(startRestoreJob(jobOptions)).rejects.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });
        expect(Client).toHaveBeenCalledWith(
            expect.objectContaining({ query_timeout: 2 * 60 * 60 * 1000 }),
        );
        expect(mockSetStatus).not.toHaveBeenCalled();
        expect(mockResetSchema).not.toHaveBeenCalled();
        expect(mockClientEnd).toHaveBeenCalledTimes(1);
        expect(mockUnlink).toHaveBeenCalledWith("/tmp/restore.upload");
    });

    it("reports the original failure when fresh-install cleanup succeeds", async () => {
        mockLoadData.mockRejectedValue(
            new RestoreError("BACKUP_ROW_COUNT_MISMATCH", "row mismatch"),
        );
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        expect(mockSetStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "failed",
                error: {
                    code: "BACKUP_ROW_COUNT_MISMATCH",
                    message: "row mismatch",
                },
            }),
        );
    });

    it("rejects a restored database with no admin before load commit", async () => {
        mockLoadData.mockImplementation(
            async (
                _client: unknown,
                _file: unknown,
                _header: unknown,
                _progress: unknown,
                beforeCommit: (client: typeof mockClient) => Promise<void>,
            ) => beforeCommit(mockClient),
        );
        mockClientQuery.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("SELECT EXISTS")) {
                return { rows: [{ present: false }] };
            }
            return { rows: [] };
        });
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        expect(mockSetStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "failed",
                error: {
                    code: "BACKUP_HAS_NO_ADMIN",
                    message: "This backup has no admin account.",
                },
            }),
        );
    });

    it("turns a dedicated client error into a failed restore", async () => {
        let resolveLoad: (() => void) | undefined;
        mockLoadData.mockImplementation(
            () => new Promise<void>((resolve) => (resolveLoad = resolve)),
        );
        await startRestoreJob(jobOptions);
        mockClient.emit("error", new Error("connection terminated"));
        await waitForTerminalStatus();
        resolveLoad?.();
        expect(mockSetStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: "failed" }),
        );
    });

    it("re-encrypts existing columns before commit and only new columns after migrations", async () => {
        mockClientQuery.mockImplementation(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
                return { rows: [{ acquired: true }] };
            }
            if (sql.includes("SELECT EXISTS")) {
                return { rows: [{ present: true }] };
            }
            return { rows: [] };
        });
        mockLoadData.mockImplementation(
            async (
                _client: unknown,
                _file: unknown,
                _header: unknown,
                _progress: unknown,
                beforeCommit: (client: typeof mockClient) => Promise<void>,
            ) => beforeCommit(mockClient),
        );
        mockReencrypt
            .mockResolvedValueOnce({
                credentialsReencrypted: 2,
                credentialsUndecryptable: 1,
                processedColumns: ["SystemSettings.openaiApiKey"],
            })
            .mockResolvedValueOnce({
                credentialsReencrypted: 1,
                credentialsUndecryptable: 0,
                processedColumns: ["User.twoFactorSecret"],
            });

        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();

        expect(mockReencrypt).toHaveBeenNthCalledWith(
            1,
            mockClient,
            "backup-key",
            "current-key",
        );
        expect(mockReencrypt).toHaveBeenNthCalledWith(
            2,
            mockClient,
            "backup-key",
            "current-key",
            new Set(["SystemSettings.openaiApiKey"]),
        );
        expect(mockSetStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "complete",
                summary: expect.objectContaining({
                    credentialsReencrypted: 3,
                    credentialsUndecryptable: 1,
                }),
            }),
        );
    });

    it("reports cleanup failure when the database cannot be reset", async () => {
        mockLoadData.mockRejectedValue(new Error("load failed"));
        mockResetSchema
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("cleanup failed"));
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        expect(mockSetStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "failed",
                error: {
                    code: "RESTORE_CLEANUP_FAILED",
                    message:
                        "The restore failed and the database could not be reset to a fresh install. Check the server logs.",
                },
            }),
        );
    });

    it("does not reject the detached job when replay-directory removal fails", async () => {
        mockRm.mockRejectedValue(new Error("rm failed"));
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockLoggerError).not.toHaveBeenCalledWith(
            "Detached restore job failed",
            expect.anything(),
        );
    });

    it("throttles loading progress and always writes first and final values", async () => {
        let now = 10_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        mockLoadData.mockImplementation(
            async (_client, _path, _header, report) => {
                await report({
                    completedTables: 0,
                    totalTables: 1,
                    completedRows: 1,
                    totalRows: 2,
                });
                await report({
                    completedTables: 0,
                    totalTables: 1,
                    completedRows: 2,
                    totalRows: 2,
                });
                now += 1_001;
                await report({
                    completedTables: 1,
                    totalTables: 1,
                    completedRows: 2,
                    totalRows: 2,
                });
            },
        );
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        const loading = mockSetStatus.mock.calls
            .map(([status]) => status)
            .filter((status) => status.state === "loading");
        expect(loading).toHaveLength(3);
        expect(loading[0].progress.completedRows).toBe(0);
        expect(loading.at(-1).progress.completedRows).toBe(2);
    });

    it("logs the redacted Prisma output tail for migration failures", async () => {
        mockReplayMigrations.mockRejectedValue(
            new RestoreMigrationError("migration failed at statement 4"),
        );
        await startRestoreJob(jobOptions);
        await waitForTerminalStatus();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Restore migration output",
            expect.objectContaining({
                outputTail: "migration failed at statement 4",
            }),
        );
    });
});
