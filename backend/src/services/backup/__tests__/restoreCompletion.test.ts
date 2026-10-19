import type { Client } from "pg";
import { createRestoreExecutionState } from "../restoreJobTypes";

const mockDeployMigrations = jest.fn();
const mockReencrypt = jest.fn();
const mockSetStatus = jest.fn();

jest.mock("../restoreMigrationReplay", () => ({
    deployCurrentMigrations: mockDeployMigrations,
}));
jest.mock("../restoreReencrypt", () => ({
    reencryptRestoredCredentials: mockReencrypt,
}));
jest.mock("../restoreStatus", () => ({
    setRestoreStatus: mockSetStatus,
    setTerminalRestoreStatus: jest.fn(),
}));
jest.mock("../restartRequired", () => ({ markRestartRequired: jest.fn() }));
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
        mockSetStatus.mockResolvedValue(undefined);
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
});
