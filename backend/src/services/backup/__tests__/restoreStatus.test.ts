export {};

const mockRedisGet = jest.fn();
const mockRedis = {
    isReady: true,
    sendCommand: mockRedisGet,
    set: jest.fn(),
};
const mockRestoreLockHeld = jest.fn();
const mockReadCompletionMarkerForRestore = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../../../utils/redis", () => ({
    redisClient: mockRedis,
}));
jest.mock("../restoreLock", () => ({ isRestoreLockHeld: mockRestoreLockHeld }));
jest.mock("../restartRequired", () => ({
    readCompletionMarkerForRestore: mockReadCompletionMarkerForRestore,
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockLoggerWarn }) },
}));

describe("effective restore status", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockRedis.isReady = true;
        mockReadCompletionMarkerForRestore.mockResolvedValue(0);
    });

    it("preserves a running status while the database lock is held", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "loading",
                progress: null,
                error: null,
                summary: null,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(true);
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "loading",
            error: null,
        });
        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "loading",
        });
        expect(mockRestoreLockHeld).toHaveBeenCalledTimes(2);
    });

    it("maps a stale running status to an interrupted failure", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "resetting",
                progress: {
                    completedTables: 1,
                    totalTables: 2,
                    completedRows: 3,
                    totalRows: 4,
                },
                error: null,
                summary: null,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).resolves.toEqual({
            restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
            state: "failed",
            progress: null,
            error: {
                code: "RESTORE_INTERRUPTED",
                message:
                    "The restore stopped before it finished. Check the server logs, then reset the database and restore again.",
            },
            summary: null,
        });
    });

    it("maps a stale post-commit status to incomplete when only its early marker exists", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "migrating",
                progress: null,
                error: null,
                summary: null,
                writtenAt: 10_000,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        const { getRestoreStatus } = await import("../restoreStatus");

        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "failed",
            error: { code: "RESTORE_FINISH_INCOMPLETE" },
        });
        expect(mockReadCompletionMarkerForRestore).toHaveBeenCalledWith(
            "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
            true,
        );
    });

    it("maps a stale pre-commit status to interrupted when only its early marker exists", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "loading",
                progress: null,
                error: null,
                summary: null,
                writtenAt: 10_000,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        const { getRestoreStatus } = await import("../restoreStatus");

        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "failed",
            error: { code: "RESTORE_INTERRUPTED" },
        });
    });

    it("does not complete a stale post-commit status from a failure-path marker", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "reencrypting",
                progress: null,
                error: null,
                summary: null,
                writtenAt: 10_000,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        const { getRestoreStatus } = await import("../restoreStatus");

        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "failed",
            error: { code: "RESTORE_FINISH_INCOMPLETE" },
        });
    });

    it("maps a stale active status to complete after its completion marker", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "migrating",
                progress: null,
                error: null,
                summary: null,
                writtenAt: 10_000,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        mockReadCompletionMarkerForRestore.mockResolvedValue(10_001);
        const { getRestoreStatus } = await import("../restoreStatus");

        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "complete",
            error: null,
        });
    });

    it("does not complete a stale status from another restore's marker", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                state: "loading",
                progress: null,
                error: null,
                summary: null,
                writtenAt: 10_000,
            }),
        );
        mockRestoreLockHeld.mockResolvedValue(false);
        mockReadCompletionMarkerForRestore.mockResolvedValue(0);
        const { getRestoreStatus } = await import("../restoreStatus");

        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "failed",
            error: { code: "RESTORE_INTERRUPTED" },
        });
    });

    it.each(["migrating", "reencrypting"])(
        "maps stale post-commit phase %s to incomplete finishing",
        async (state) => {
            mockRedisGet.mockResolvedValue(
                JSON.stringify({
                    restoreId: "98e4582e-e030-4ae8-8aa9-63c8de4f707f",
                    state,
                    progress: null,
                    error: null,
                    summary: null,
                }),
            );
            mockRestoreLockHeld.mockResolvedValue(false);
            const { getRestoreStatus } = await import("../restoreStatus");

            await expect(getRestoreStatus()).resolves.toMatchObject({
                state: "failed",
                error: { code: "RESTORE_FINISH_INCOMPLETE" },
            });
        },
    );

    it("does not probe the database for a terminal status", async () => {
        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                state: "complete",
                progress: null,
                error: null,
                summary: null,
            }),
        );
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "complete",
        });
        expect(mockRestoreLockHeld).not.toHaveBeenCalled();
    });

    it("reports status storage failure instead of masking it as idle", async () => {
        mockRedisGet.mockRejectedValue(new Error("redis unavailable"));
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).rejects.toMatchObject({
            code: "RESTORE_STATUS_UNAVAILABLE",
        });
    });

    it("sanitizes status errors on write and accepts legacy oversized messages", async () => {
        const mockSet = jest.fn().mockResolvedValue(undefined);
        const redis = jest.requireMock("../../../utils/redis") as {
            redisClient: { set: jest.Mock };
        };
        redis.redisClient.set = mockSet;
        const { getRestoreStatus, setRestoreStatus } =
            await import("../restoreStatus");
        await setRestoreStatus({
            state: "failed",
            progress: null,
            error: { code: "FAIL", message: `${"x".repeat(600)}\nsecret` },
            summary: null,
        });
        const stored = JSON.parse(mockSet.mock.calls[0][1] as string) as {
            error: { message: string };
        };
        expect(stored.error.message).toHaveLength(500);
        expect(stored.error.message).not.toMatch(/[\r\n]/);

        mockRedisGet.mockResolvedValue(
            JSON.stringify({
                state: "failed",
                progress: null,
                error: { code: "FAIL", message: "y".repeat(10_000) },
                summary: null,
            }),
        );
        await expect(getRestoreStatus()).resolves.toMatchObject({
            error: { message: "y".repeat(500) },
        });
    });

    it("bounds a stalled status write and treats it as best effort", async () => {
        jest.useFakeTimers();
        mockRedis.set.mockReturnValueOnce(new Promise(() => undefined));
        const { setRestoreStatus } = await import("../restoreStatus");
        const pending = setRestoreStatus({
            state: "loading",
            progress: {
                completedTables: 0,
                totalTables: 1,
                completedRows: 0,
                totalRows: 1,
            },
            error: null,
            summary: null,
        });

        await jest.advanceTimersByTimeAsync(251);

        await expect(pending).resolves.toEqual(expect.any(Number));
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Could not persist restore status",
            expect.any(Error),
        );
        jest.useRealTimers();
    });

    it("retries a terminal status write three times with bounded delay", async () => {
        jest.useFakeTimers();
        mockRedis.set
            .mockRejectedValueOnce(new Error("redis down"))
            .mockRejectedValueOnce(new Error("redis down"))
            .mockResolvedValueOnce("OK");
        const { setTerminalRestoreStatus } = await import("../restoreStatus");
        const pending = setTerminalRestoreStatus({
            state: "failed",
            progress: null,
            error: { code: "RESTORE_FAILED", message: "failed" },
            summary: null,
        });

        await jest.advanceTimersByTimeAsync(1_000);

        await expect(pending).resolves.toBeUndefined();
        expect(mockRedis.set).toHaveBeenCalledTimes(3);
        jest.useRealTimers();
    });
});
