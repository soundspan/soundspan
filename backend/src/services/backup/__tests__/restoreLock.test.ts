import { EventEmitter } from "events";

const client = Object.assign(new EventEmitter(), {
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
});

jest.mock("pg", () => ({ Client: jest.fn(() => client) }));
jest.mock("../../../config", () => ({
    config: { databaseUrl: "postgresql://target/database" },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

describe("restore advisory lock probe", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        client.connect.mockResolvedValue(undefined);
        client.end.mockResolvedValue(undefined);
    });

    it("uses a dedicated client for the configured restore database", async () => {
        client.query.mockResolvedValue({ rows: [{ held: true }] });
        const { isRestoreLockHeld } = await import("../restoreLock");
        await expect(isRestoreLockHeld(10_000)).resolves.toBe(true);
        const { Client } = await import("pg");
        expect(Client).toHaveBeenCalledWith(
            expect.objectContaining({
                connectionString: "postgresql://target/database",
                query_timeout: 1_000,
            }),
        );
    });

    it("reuses a recent known result when a transient probe fails", async () => {
        client.query.mockRejectedValue(new Error("switchover"));
        const { isRestoreLockHeld, recordRestoreLockState } =
            await import("../restoreLock");
        recordRestoreLockState(true, 10_000);
        await expect(isRestoreLockHeld(13_000)).resolves.toBe(true);
    });

    it("retains process-owned lock knowledge for the life of the job", async () => {
        client.query.mockRejectedValue(new Error("switchover"));
        const { isRestoreLockHeld, recordRestoreLockState } =
            await import("../restoreLock");
        recordRestoreLockState(true, 10_000);

        await expect(isRestoreLockHeld(100_000)).resolves.toBe(true);
        expect(client.query).not.toHaveBeenCalled();
    });
});
