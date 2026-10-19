import { EventEmitter } from "events";
import type { Client } from "pg";
import type { RestoreClientHandle } from "../restoreClient";

const mockRecordLock = jest.fn();
const mockInvalidateLock = jest.fn();
const clients: FakeClient[] = [];

interface FakeClient extends EventEmitter {
    connect: jest.Mock;
    end: jest.Mock;
    getTransactionStatus: jest.Mock;
    query: jest.Mock;
}

function fakeClient(): FakeClient {
    return Object.assign(new EventEmitter(), {
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockResolvedValue(undefined),
        getTransactionStatus: jest.fn().mockReturnValue("I"),
        query: jest.fn().mockResolvedValue({ rows: [] }),
    });
}

function restoreHandle(
    client: FakeClient,
    connectionError: Error | null,
    backendPid: number | null = null,
    backendStart: string | null = null,
): RestoreClientHandle {
    return {
        client: client as unknown as Client,
        backendPid,
        backendStart,
        connectionFailure: new Promise<Error>(() => undefined),
        detachClientError: jest.fn(),
        getConnectionError: () => connectionError,
    };
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

    it("keeps the acquisition error listener active through end", async () => {
        const client = fakeClient();
        let listenerPresentDuringEnd = false;
        client.query.mockResolvedValue({
            rows: [{ acquired: false, backend_pid: 55 }],
        });
        client.end.mockImplementation(async () => {
            listenerPresentDuringEnd = client.listenerCount("error") > 0;
            client.emit("error", new Error("late acquisition close error"));
        });
        clients.push(client);
        const { acquireRestoreClient } = await import("../restoreClient");

        await expect(acquireRestoreClient()).rejects.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });

        expect(listenerPresentDuringEnd).toBe(true);
        expect(client.listenerCount("error")).toBe(0);
    });

    it("returns the backend identity losslessly for an acquired restore lock", async () => {
        const client = fakeClient();
        const backendStart = "2026-10-19 12:00:00.123456+00";
        client.query.mockResolvedValue({
            rows: [
                {
                    acquired: true,
                    backend_pid: 55,
                    backend_start: backendStart,
                },
            ],
        });
        clients.push(client);
        const { acquireRestoreClient, releaseRestoreClient } =
            await import("../restoreClient");

        const handle = await acquireRestoreClient();

        expect(handle.backendPid).toBe(55);
        expect(handle.backendStart).toBe(backendStart);
        expect(client.query).toHaveBeenCalledWith(
            expect.stringContaining("backend_start::text"),
            [5_331_001_002],
        );
        expect(mockRecordLock).toHaveBeenCalledWith(true);
        await releaseRestoreClient(handle);
    });

    it("closes a healthy original before taking the recovery lock", async () => {
        const original = fakeClient();
        original.getTransactionStatus.mockReturnValue("T");
        const recovery = fakeClient();
        const order: string[] = [];
        original.query.mockImplementation(async (sql: string) => {
            order.push(`original:${sql}`);
            return { rows: [] };
        });
        original.end.mockImplementation(async () => {
            order.push("original:end");
        });
        recovery.connect.mockImplementation(async () => {
            order.push("recovery:connect");
        });
        recovery.query.mockImplementation(async (sql: string) => {
            order.push(`recovery:${sql}`);
            return { rows: [] };
        });
        clients.push(recovery);
        const { releaseRestoreClient, withRecoveryRestoreClient } =
            await import("../restoreClient");
        const handle = restoreHandle(
            original,
            null,
            77,
            "2026-10-19 12:00:00.123456+00",
        );

        await expect(
            withRecoveryRestoreClient(handle, async () => {
                order.push("work");
                return "done";
            }),
        ).resolves.toBe("done");
        await releaseRestoreClient(handle);
        expect(order).toEqual([
            "original:ROLLBACK",
            "original:SELECT pg_advisory_unlock($1)",
            "original:end",
            "recovery:connect",
            "recovery:SET lock_timeout = '30s'",
            "recovery:SELECT pg_advisory_lock($1)",
            "recovery:RESET lock_timeout",
            "work",
        ]);
        expect(
            recovery.query.mock.calls.some(([sql]) =>
                String(sql).includes("pg_terminate_backend"),
            ),
        ).toBe(false);
        expect(recovery.end).toHaveBeenCalledTimes(1);
        expect(original.end).toHaveBeenCalledTimes(1);
    });

    it("guards dead-backend termination by timestamp identity before locking", async () => {
        const original = fakeClient();
        const recovery = fakeClient();
        const backendStart = "2026-10-19 12:00:00.123456+00";
        const order: string[] = [];
        recovery.query.mockImplementation(
            async (sql: string, params?: unknown[]) => {
                order.push(sql);
                if (sql.includes("pg_terminate_backend")) {
                    expect(params).toEqual([77, backendStart]);
                    expect(sql).toContain("backend_start = $2::timestamptz");
                    expect(sql).toContain("pid <> pg_backend_pid()");
                }
                return { rows: [] };
            },
        );
        clients.push(recovery);
        const { withRecoveryRestoreClient } = await import("../restoreClient");
        const handle = restoreHandle(
            original,
            new Error("connection lost"),
            77,
            backendStart,
        );

        await expect(
            withRecoveryRestoreClient(handle, async () => {
                order.push("work");
                return "done";
            }),
        ).resolves.toBe("done");

        expect(original.query).not.toHaveBeenCalled();
        expect(order).toEqual([
            expect.stringContaining("pg_terminate_backend"),
            "SET lock_timeout = '30s'",
            "SELECT pg_advisory_lock($1)",
            "RESET lock_timeout",
            "work",
        ]);
    });

    it("bounds a stalled healthy close before guarded takeover", async () => {
        jest.useFakeTimers();
        const original = fakeClient();
        const recovery = fakeClient();
        let finishEnd: (() => void) | undefined;
        original.end.mockReturnValue(
            new Promise<void>((resolve) => {
                finishEnd = resolve;
            }),
        );
        clients.push(recovery);
        const { withRecoveryRestoreClient } = await import("../restoreClient");
        const handle = restoreHandle(
            original,
            null,
            77,
            "2026-10-19 12:00:00.123456+00",
        );

        const pending = withRecoveryRestoreClient(handle, async () => "done");
        await jest.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toBe("done");
        expect(recovery.query).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("pg_terminate_backend"),
            [77, "2026-10-19 12:00:00.123456+00"],
        );
        finishEnd?.();
    });

    it("keeps a recovery client's error listener active while work runs", async () => {
        const client = fakeClient();
        clients.push(client);
        const { withRecoveryRestoreClient } = await import("../restoreClient");

        const handle = restoreHandle(fakeClient(), null);
        await expect(
            withRecoveryRestoreClient(handle, async (activeClient) => {
                activeClient.emit("error", new Error("connection lost"));
                return "done";
            }),
        ).resolves.toBe("done");

        expect(client.listenerCount("error")).toBe(0);
    });

    it("keeps a recovery client's error listener active through end", async () => {
        const client = fakeClient();
        let listenerPresentDuringEnd = false;
        client.end.mockImplementation(async () => {
            listenerPresentDuringEnd = client.listenerCount("error") > 0;
            client.emit("error", new Error("late recovery close error"));
        });
        clients.push(client);
        const { withRecoveryRestoreClient } = await import("../restoreClient");

        const handle = restoreHandle(fakeClient(), null);
        await expect(
            withRecoveryRestoreClient(handle, async () => "done"),
        ).resolves.toBe("done");

        expect(listenerPresentDuringEnd).toBe(true);
        expect(client.listenerCount("error")).toBe(0);
    });

    it("keeps the original client's error listener active through end", async () => {
        const client = fakeClient();
        client.query.mockResolvedValue({
            rows: [
                {
                    acquired: true,
                    backend_pid: 55,
                    backend_start: "2026-10-19 12:00:00.123456+00",
                },
            ],
        });
        client.end.mockImplementation(async () => {
            client.emit("error", new Error("late fatal"));
        });
        clients.push(client);
        const { acquireRestoreClient, releaseRestoreClient } =
            await import("../restoreClient");
        const handle = await acquireRestoreClient();

        await expect(releaseRestoreClient(handle)).resolves.toBeUndefined();

        expect(handle.getConnectionError()).toMatchObject({
            message: "late fatal",
        });
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

        const handle = restoreHandle(
            fakeClient(),
            new Error("connection lost"),
        );
        const pending = withRecoveryRestoreClient(handle, async () => "unused");
        const rejection = expect(pending).rejects.toThrow("down 6");
        await jest.advanceTimersByTimeAsync(60_000);
        await rejection;

        expect(failures).toHaveLength(7);
        for (const client of failures) {
            expect(client.end).toHaveBeenCalledTimes(1);
        }
    });
});
