import { EventEmitter } from "events";

const mockRecordLock = jest.fn();
const mockInvalidateLock = jest.fn();
const clients: FakeClient[] = [];

interface FakeClient extends EventEmitter {
    connect: jest.Mock;
    end: jest.Mock;
    query: jest.Mock;
}

function fakeClient(): FakeClient {
    return Object.assign(new EventEmitter(), {
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
    });
}

jest.mock("pg", () => ({
    Client: jest.fn(() => {
        const client = clients.shift();
        if (!client) throw new Error("No fake client queued");
        return client;
    }),
}));
jest.mock("../../../config", () => ({
    config: { databaseUrl: "postgresql://target/database" },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));
jest.mock("../restoreLock", () => ({
    RESTORE_ADVISORY_LOCK: 5_331_001_002,
    recordRestoreLockState: mockRecordLock,
    invalidateRestoreLockCache: mockInvalidateLock,
}));

describe("restore client lifecycle", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clients.splice(0, clients.length);
    });

    afterEach(() => jest.useRealTimers());

    it("does not clear process ownership when a concurrent lock attempt loses", async () => {
        const client = fakeClient();
        client.query.mockResolvedValue({
            rows: [{ acquired: false, backend_pid: 55 }],
        });
        clients.push(client);
        const { acquireRestoreClient } = await import("../restoreClient");

        await expect(acquireRestoreClient()).rejects.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });

        expect(mockRecordLock).not.toHaveBeenCalled();
        expect(mockInvalidateLock).not.toHaveBeenCalled();
    });

    it("returns the backend pid for a successfully acquired restore lock", async () => {
        const client = fakeClient();
        client.query.mockResolvedValue({
            rows: [{ acquired: true, backend_pid: 55 }],
        });
        clients.push(client);
        const { acquireRestoreClient, releaseRestoreClient } =
            await import("../restoreClient");

        const handle = await acquireRestoreClient();

        expect(handle.backendPid).toBe(55);
        expect(mockRecordLock).toHaveBeenCalledWith(true);
        await releaseRestoreClient(handle);
    });

    it("retries connection twice, terminates the old pid, and locks before work", async () => {
        jest.useFakeTimers();
        const first = fakeClient();
        const second = fakeClient();
        const third = fakeClient();
        first.connect.mockRejectedValue(new Error("first down"));
        second.connect.mockRejectedValue(new Error("second down"));
        const order: string[] = [];
        third.query.mockImplementation(
            async (sql: string, params?: unknown[]) => {
                order.push(sql);
                if (sql.includes("pg_terminate_backend"))
                    expect(params).toEqual([77]);
                return { rows: [] };
            },
        );
        clients.push(first, second, third);
        const { withRecoveryRestoreClient } = await import("../restoreClient");
        const pending = withRecoveryRestoreClient(77, async (client) => {
            expect(client.listenerCount("error")).toBe(1);
            order.push("work");
            return "done";
        });

        await jest.advanceTimersByTimeAsync(3_000);

        await expect(pending).resolves.toBe("done");
        expect(order).toEqual([
            "SELECT pg_terminate_backend($1) AS terminated",
            "SET lock_timeout = '30s'",
            "SELECT pg_advisory_lock($1)",
            "work",
        ]);
        expect(first.end).toHaveBeenCalledTimes(1);
        expect(second.end).toHaveBeenCalledTimes(1);
        expect(third.end).toHaveBeenCalledTimes(1);
        const { Client } = await import("pg");
        expect(Client).toHaveBeenCalledWith(
            expect.objectContaining({ keepAlive: true }),
        );
    });

    it("keeps a recovery client's error listener active while work runs", async () => {
        const client = fakeClient();
        clients.push(client);
        const { withRecoveryRestoreClient } = await import("../restoreClient");

        await expect(
            withRecoveryRestoreClient(null, async (activeClient) => {
                activeClient.emit("error", new Error("connection lost"));
                return "done";
            }),
        ).resolves.toBe("done");

        expect(client.listenerCount("error")).toBe(0);
    });

    it("stops after the bounded recovery connection schedule", async () => {
        jest.useFakeTimers();
        const failures = Array.from({ length: 7 }, (_, index) => {
            const client = fakeClient();
            client.connect.mockRejectedValue(new Error(`down ${index}`));
            return client;
        });
        clients.push(...failures);
        const { withRecoveryRestoreClient } = await import("../restoreClient");

        const pending = withRecoveryRestoreClient(null, async () => "unused");
        const rejection = expect(pending).rejects.toThrow("down 6");
        await jest.advanceTimersByTimeAsync(60_000);
        await rejection;

        expect(failures).toHaveLength(7);
        for (const client of failures) {
            expect(client.end).toHaveBeenCalledTimes(1);
        }
    });
});
