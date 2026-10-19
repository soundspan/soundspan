import type { Client } from "pg";
import { RestoreError } from "../backupErrors";
import type { RestoreExecutionState } from "../restoreJobTypes";

const mockWithRecoveryClient = jest.fn();
const mockResetSchema = jest.fn();
const mockDeployMigrations = jest.fn();
const mockFinishCommitted = jest.fn();
const mockMarkRestart = jest.fn();
const mockSetTerminalStatus = jest.fn();
const mockLoggerError = jest.fn();
const client = { query: jest.fn() } as unknown as Client;

jest.mock("../restoreClient", () => ({
    withRecoveryRestoreClient: mockWithRecoveryClient,
}));
jest.mock("../restoreSchemaReset", () => ({
    resetApplicationSchema: mockResetSchema,
}));
jest.mock("../restoreMigrationReplay", () => ({
    deployCurrentMigrations: mockDeployMigrations,
}));
jest.mock("../restoreCompletion", () => ({
    finishCommittedRestore: mockFinishCommitted,
}));
jest.mock("../restartRequired", () => ({
    markRestartRequired: mockMarkRestart,
}));
jest.mock("../restoreStatus", () => ({
    setTerminalRestoreStatus: mockSetTerminalStatus,
}));
jest.mock("../../../config", () => ({
    config: { databaseUrl: "postgresql://target/database" },
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            error: mockLoggerError,
            info: jest.fn(),
        }),
    },
}));

const options = {
    uploadId: "upload",
    filePath: "/tmp/restore",
    backupKey: "backup-key",
    backupPepperFingerprint: null,
    macKey: Buffer.alloc(32),
};

function state(
    overrides: Partial<RestoreExecutionState> = {},
): RestoreExecutionState {
    return {
        prepared: {
            validated: {
                header: { tables: [] } as never,
                rows: 0,
            },
            compatibility: {
                outcome: "ok",
                migrationsToReplay: [],
                pendingAfterLoad: 0,
                checksumWarnings: [],
            },
        },
        progress: null,
        firstPass: {
            credentialsReencrypted: 0,
            credentialsUndecryptable: 0,
            processedColumns: [],
        },
        currentKey: "current-key",
        resetStarted: true,
        loadCommitted: false,
        loadCommitConfirmed: false,
        replayDir: null,
        ...overrides,
    };
}

describe("restore failure recovery", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (client.query as jest.Mock).mockResolvedValue({
            rows: [{ present: false }],
        });
        mockWithRecoveryClient.mockImplementation(
            async (
                _pid: number | null,
                work: (value: Client) => Promise<void>,
            ) => work(client),
        );
        mockResetSchema.mockResolvedValue(undefined);
        mockDeployMigrations.mockResolvedValue(undefined);
        mockFinishCommitted.mockResolvedValue(undefined);
        mockMarkRestart.mockResolvedValue(undefined);
        mockSetTerminalStatus.mockResolvedValue(undefined);
    });

    it("cleans to a migrated fresh install after a pre-commit failure", async () => {
        const { handleRestoreFailure } = await import("../restoreRecovery");
        await handleRestoreFailure(
            "restore-id",
            options,
            state(),
            new RestoreError("BACKUP_INVALID", "invalid backup"),
            44,
        );

        expect(mockResetSchema).toHaveBeenCalledWith(client, {
            allowExistingUsers: true,
        });
        expect(mockDeployMigrations).toHaveBeenCalledTimes(1);
        expect(mockSetTerminalStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "failed",
                error: { code: "BACKUP_INVALID", message: "invalid backup" },
            }),
        );
    });

    it("finishes without reset when COMMIT threw but users exist", async () => {
        (client.query as jest.Mock).mockResolvedValue({
            rows: [{ present: true }],
        });
        const { handleRestoreFailure } = await import("../restoreRecovery");
        const execution = state({ loadCommitted: true });

        await handleRestoreFailure(
            "restore-id",
            options,
            execution,
            new Error("commit acknowledgement lost"),
            44,
        );

        expect(mockFinishCommitted).toHaveBeenCalledWith(
            client,
            "restore-id",
            options,
            execution,
        );
        expect(mockResetSchema).not.toHaveBeenCalled();
    });

    it("cleans when COMMIT threw and no users exist", async () => {
        const { handleRestoreFailure } = await import("../restoreRecovery");
        await handleRestoreFailure(
            "restore-id",
            options,
            state({ loadCommitted: true }),
            new Error("commit acknowledgement lost"),
            44,
        );

        expect(mockResetSchema).toHaveBeenCalledTimes(1);
        expect(mockFinishCommitted).not.toHaveBeenCalled();
    });

    it("finishes a confirmed load after migrate-to-head fails", async () => {
        const { handleRestoreFailure } = await import("../restoreRecovery");
        const execution = state({
            loadCommitted: true,
            loadCommitConfirmed: true,
        });

        await handleRestoreFailure(
            "restore-id",
            options,
            execution,
            new Error("migration failed"),
            44,
        );

        expect(mockFinishCommitted).toHaveBeenCalledTimes(1);
        expect(client.query).not.toHaveBeenCalled();
        expect(mockResetSchema).not.toHaveBeenCalled();
    });

    it("reports a non-destructive incomplete finish and sets the marker", async () => {
        mockFinishCommitted.mockRejectedValue(new Error("finish failed"));
        const { handleRestoreFailure } = await import("../restoreRecovery");

        await handleRestoreFailure(
            "restore-id",
            options,
            state({ loadCommitted: true, loadCommitConfirmed: true }),
            new Error("migration failed"),
            44,
        );

        expect(mockResetSchema).not.toHaveBeenCalled();
        expect(mockMarkRestart).toHaveBeenCalledTimes(1);
        expect(mockSetTerminalStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                state: "failed",
                error: {
                    code: "RESTORE_FINISH_INCOMPLETE",
                    message:
                        "Your data was restored, but the last steps didn't finish. Restart soundspan; startup applies any remaining database changes. Check stored service connections afterwards.",
                },
            }),
        );
    });

    it("reports cleanup failure when the fresh install cannot be rebuilt", async () => {
        mockResetSchema.mockRejectedValue(new Error("reset failed"));
        const { handleRestoreFailure } = await import("../restoreRecovery");

        await handleRestoreFailure(
            "restore-id",
            options,
            state(),
            new Error("load failed"),
            44,
        );

        expect(mockSetTerminalStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "RESTORE_CLEANUP_FAILED",
                }),
            }),
        );
    });

    it("reports incomplete finishing when a confirmed load cannot reconnect", async () => {
        mockWithRecoveryClient.mockRejectedValue(new Error("database down"));
        const { handleRestoreFailure } = await import("../restoreRecovery");

        await handleRestoreFailure(
            "restore-id",
            options,
            state({ loadCommitted: true, loadCommitConfirmed: true }),
            new Error("connection lost"),
            44,
        );

        expect(mockSetTerminalStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "RESTORE_FINISH_INCOMPLETE",
                }),
            }),
        );
        expect(mockResetSchema).not.toHaveBeenCalled();
    });

    it("reports cleanup failure when pre-commit recovery cannot reconnect", async () => {
        mockWithRecoveryClient.mockRejectedValue(new Error("database down"));
        const { handleRestoreFailure } = await import("../restoreRecovery");

        await handleRestoreFailure(
            "restore-id",
            options,
            state(),
            new Error("connection lost"),
            44,
        );

        expect(mockSetTerminalStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "RESTORE_CLEANUP_FAILED",
                }),
            }),
        );
    });
});
