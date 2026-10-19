import type { Client } from "pg";
import { createRestoreExecutionState } from "../restoreJobTypes";

const mockDeployMigrations = jest.fn();
const mockReencrypt = jest.fn();
const mockSetStatus = jest.fn();
const mockSetTerminalStatus = jest.fn();
const mockMarkRestart = jest.fn();

jest.mock("../restoreMigrationReplay", () => ({
    deployCurrentMigrations: mockDeployMigrations,
}));
jest.mock("../restoreReencrypt", () => ({
    reencryptRestoredCredentials: mockReencrypt,
}));
jest.mock("../restoreStatus", () => ({
    setRestoreStatus: mockSetStatus,
    setTerminalRestoreStatus: mockSetTerminalStatus,
}));
jest.mock("../restartRequired", () => ({
    markRestartRequired: mockMarkRestart,
}));
jest.mock("../../../config", () => ({
    config: { databaseUrl: "postgresql://target/database" },
}));
jest.mock("../../../config/appVersion", () => ({
    resolveAppVersion: () => "2.6.1",
}));
jest.mock("../../../utils/apiKeyHash", () => ({
    getPepperFingerprint: () => null,
}));

const options = {
    uploadId: "upload",
    filePath: "/tmp/restore",
    backupKey: "backup-key",
    backupPepperFingerprint: null,
    macKey: Buffer.alloc(32),
};
const client = {} as Client;

describe("committed restore completion guards", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeployMigrations.mockResolvedValue(undefined);
        mockReencrypt.mockResolvedValue({
            credentialsReencrypted: 0,
            credentialsUndecryptable: 0,
            processedColumns: [],
        });
        mockSetStatus.mockResolvedValue(10_000);
        mockSetTerminalStatus.mockResolvedValue(undefined);
        mockMarkRestart.mockResolvedValue(undefined);
    });

    it("rejects completion when the restore key was not prepared", async () => {
        const { finishCommittedRestore } = await import("../restoreCompletion");

        await expect(
            finishCommittedRestore(
                client,
                "restore-id",
                options,
                createRestoreExecutionState(),
            ),
        ).rejects.toThrow("Restore key was not prepared");

        expect(mockDeployMigrations).not.toHaveBeenCalled();
    });

    it("rejects completion when validation state is missing", async () => {
        const { finishCommittedRestore } = await import("../restoreCompletion");
        const state = createRestoreExecutionState();
        state.currentKey = "current-key";

        await expect(
            finishCommittedRestore(client, "restore-id", options, state),
        ).rejects.toThrow("Restore was not prepared");

        expect(mockDeployMigrations).toHaveBeenCalledTimes(1);
        expect(mockReencrypt).toHaveBeenCalledTimes(1);
    });

    it("writes an early marker and a newer completion marker in phase order", async () => {
        const calls: string[] = [];
        let migratingWrittenAt = 0;
        let markerWrites = 0;
        mockMarkRestart.mockImplementation(async () => {
            calls.push(markerWrites === 0 ? "early-marker" : "finished-marker");
            markerWrites += 1;
        });
        mockSetStatus.mockImplementation(async (status, notBefore: number) => {
            calls.push(status.state);
            migratingWrittenAt = Math.max(Date.now(), notBefore);
            return migratingWrittenAt;
        });
        mockDeployMigrations.mockImplementation(async () => {
            calls.push("deploy");
        });
        mockReencrypt.mockImplementation(async () => {
            calls.push("reencrypt");
            return {
                credentialsReencrypted: 0,
                credentialsUndecryptable: 0,
                processedColumns: [],
            };
        });
        mockSetTerminalStatus.mockImplementation(async () => {
            calls.push("complete");
        });
        const { finishCommittedRestore } = await import("../restoreCompletion");
        const state = createRestoreExecutionState();
        state.currentKey = "current-key";
        state.prepared = {
            validated: {
                header: {
                    createdAt: "2026-10-19T12:00:00.000Z",
                    appVersion: "2.5.0",
                    tables: [],
                } as never,
                rows: 0,
            },
            compatibility: {
                outcome: "ok",
                migrationsToReplay: [],
                pendingAfterLoad: 0,
                checksumWarnings: [],
            },
        };
        await finishCommittedRestore(
            client,
            "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
            options,
            state,
        );

        expect(calls).toEqual([
            "early-marker",
            "migrating",
            "deploy",
            "reencrypt",
            "finished-marker",
            "complete",
        ]);
        expect(mockMarkRestart).toHaveBeenCalledTimes(2);
        const earlyTimestamp = mockMarkRestart.mock.calls[0]![0] as number;
        const finishedTimestamp = mockMarkRestart.mock.calls[1]![0] as number;
        expect(finishedTimestamp).toBeGreaterThan(migratingWrittenAt);
        expect(finishedTimestamp).toBeGreaterThan(earlyTimestamp);
        expect(mockDeployMigrations).toHaveBeenCalledWith(
            "postgresql://target/database",
        );
    });
});
