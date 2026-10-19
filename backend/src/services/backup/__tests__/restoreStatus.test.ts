const mockRedisGet = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock("../../../utils/redis", () => ({
    redisClient: { get: mockRedisGet, set: jest.fn() },
}));
jest.mock("../../../utils/db", () => ({
    prisma: { $queryRaw: mockQueryRaw },
}));

describe("effective restore status", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
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
        mockQueryRaw.mockResolvedValue([{ held: true }]);
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "loading",
            error: null,
        });
        await expect(getRestoreStatus()).resolves.toMatchObject({
            state: "loading",
        });
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
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
        mockQueryRaw.mockResolvedValue([{ held: false }]);
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
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("fails open to idle when Redis status cannot be read", async () => {
        mockRedisGet.mockRejectedValue(new Error("redis unavailable"));
        const { getRestoreStatus } = await import("../restoreStatus");
        await expect(getRestoreStatus()).resolves.toEqual({
            state: "idle",
            progress: null,
            error: null,
            summary: null,
        });
    });
});
