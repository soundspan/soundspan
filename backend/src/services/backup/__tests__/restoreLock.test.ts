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
        client.removeAllListeners();
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

    it("keeps one probe connection across cache windows", async () => {
        client.query.mockResolvedValue({ rows: [{ held: false }] });
        const { isRestoreLockHeld } = await import("../restoreLock");

        await expect(isRestoreLockHeld(10_000)).resolves.toBe(false);
        await expect(isRestoreLockHeld(12_001)).resolves.toBe(false);

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(client.query).toHaveBeenCalledTimes(2);
        expect(client.end).not.toHaveBeenCalled();
    });

    it("falls back to the last successful result for sixty seconds only", async () => {
        client.query
            .mockResolvedValueOnce({ rows: [{ held: true }] })
            .mockRejectedValue(new Error("switchover"));
        const { isRestoreLockHeld } = await import("../restoreLock");

        await expect(isRestoreLockHeld(10_000)).resolves.toBe(true);
        await expect(isRestoreLockHeld(13_000)).resolves.toBe(true);
        await expect(isRestoreLockHeld(13_001)).resolves.toBe(true);
        await expect(isRestoreLockHeld(70_001)).resolves.toBe(false);

        expect(client.query).toHaveBeenCalledTimes(3);
    });

    it("retains process-owned lock knowledge for the life of the job", async () => {
        client.query.mockRejectedValue(new Error("switchover"));
        const { isRestoreLockHeld, recordRestoreLockState } =
            await import("../restoreLock");
        recordRestoreLockState(true, 10_000);

        await expect(isRestoreLockHeld(100_000)).resolves.toBe(true);
        expect(client.query).not.toHaveBeenCalled();
    });

    it("caches a failed probe for the normal two-second window", async () => {
        client.query.mockRejectedValue(new Error("database unavailable"));
        const { isRestoreLockHeld } = await import("../restoreLock");

        await expect(isRestoreLockHeld(20_000)).resolves.toBe(false);
        await expect(isRestoreLockHeld(20_500)).resolves.toBe(false);

        expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("backs off after a failed lazy connection", async () => {
        client.connect.mockRejectedValueOnce(new Error("connect failed"));
        client.end.mockRejectedValueOnce(new Error("already closed"));
        const { isRestoreLockHeld } = await import("../restoreLock");

        await expect(isRestoreLockHeld(30_000)).resolves.toBe(false);
        await expect(isRestoreLockHeld(30_500)).resolves.toBe(false);

        expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it("discards an errored long-lived probe and reconnects after backoff", async () => {
        client.query.mockResolvedValue({ rows: [{ held: false }] });
        const { isRestoreLockHeld } = await import("../restoreLock");
        const now = Date.now();
        await expect(isRestoreLockHeld(now)).resolves.toBe(false);

        client.emit("error", new Error("idle connection dropped"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(isRestoreLockHeld(now + 2_001)).resolves.toBe(false);

        expect(client.connect).toHaveBeenCalledTimes(2);
    });

    it("invalidates process-owned and stale lock knowledge", async () => {
        client.query.mockResolvedValue({ rows: [{ held: false }] });
        const {
            invalidateRestoreLockCache,
            isRestoreLockHeld,
            recordRestoreLockState,
        } = await import("../restoreLock");
        recordRestoreLockState(true, 50_000);
        invalidateRestoreLockCache();

        await expect(isRestoreLockHeld(50_001)).resolves.toBe(false);
        expect(client.query).toHaveBeenCalledTimes(1);
    });
});
