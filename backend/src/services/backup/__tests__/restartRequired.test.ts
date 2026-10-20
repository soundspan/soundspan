export {};

const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    sendCommand: jest.fn(),
    isReady: true,
};
const mockRestoreLockHeld = jest.fn();
const mockConsumeLockRelease = jest.fn();

jest.mock("../../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../restoreLock", () => ({
    consumeRestoreLockRelease: mockConsumeLockRelease,
    isRestoreLockHeld: mockRestoreLockHeld,
}));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

function response() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

describe("restart-required middleware", () => {
    beforeEach(() => {
        jest.resetModules();
        mockRedis.get.mockReset();
        mockRedis.set.mockReset();
        mockRedis.sendCommand.mockReset();
        mockRedis.isReady = true;
        mockRestoreLockHeld.mockReset();
        mockRestoreLockHeld.mockResolvedValue(false);
        mockConsumeLockRelease.mockReset();
        mockConsumeLockRelease.mockReturnValue(false);
    });

    it.each(["/api/restore/status", "/health", "/api/health/ready"])(
        "allows exempt path %s",
        async (path) => {
            const { requireNoPendingRestart } =
                await import("../restartRequired");
            const next = jest.fn();
            await requireNoPendingRestart({ path } as any, response(), next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(mockRedis.sendCommand).not.toHaveBeenCalled();
        },
    );

    it("blocks other API paths with the canonical response", async () => {
        mockRedis.sendCommand.mockResolvedValue(
            String(Number.MAX_SAFE_INTEGER),
        );
        const { requireNoPendingRestart } = await import("../restartRequired");
        const res = response();
        const next = jest.fn();
        await requireNoPendingRestart(
            { path: "/api/library" } as any,
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Restart soundspan to finish the restore.",
            code: "RESTART_REQUIRED",
        });
    });

    it("blocks Subsonic requests when a restart is required", async () => {
        mockRedis.sendCommand.mockResolvedValue(
            String(Number.MAX_SAFE_INTEGER),
        );
        const { requireNoPendingRestart } = await import("../restartRequired");
        const res = response();
        const next = jest.fn();
        await requireNoPendingRestart(
            { path: "/rest/ping.view" } as any,
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Restart soundspan to finish the restore.",
            code: "RESTART_REQUIRED",
        });
    });

    it("blocks application APIs while a restore is active", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        const { requireNoPendingRestart } = await import("../restartRequired");
        const res = response();
        const next = jest.fn();
        await requireNoPendingRestart(
            { path: "/api/playlists" } as any,
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.body).toEqual({
            error: "A restore is in progress.",
            code: "RESTORE_IN_PROGRESS",
        });
        expect(mockRedis.sendCommand).toHaveBeenCalledTimes(1);
    });

    it("prefers the local restart marker over a still-held restore lock", async () => {
        mockRedis.set.mockResolvedValue("OK");
        mockRestoreLockHeld.mockResolvedValue(true);
        const { getRestoreBarrier, markRestartRequired } =
            await import("../restartRequired");

        await markRestartRequired(Number.MAX_SAFE_INTEGER);

        await expect(getRestoreBarrier()).resolves.toEqual({
            code: "RESTART_REQUIRED",
            message: "Restart soundspan to finish the restore.",
        });
        expect(mockRestoreLockHeld).not.toHaveBeenCalled();
    });

    it("retries a bounded restart-marker write and keeps the local barrier", async () => {
        mockRedis.set.mockRejectedValue(new Error("redis unavailable"));
        mockRedis.sendCommand.mockRejectedValue(new Error("redis unavailable"));
        const { getRestoreBarrier, isRestartRequired, markRestartRequired } =
            await import("../restartRequired");
        const completedAt = Date.now();

        await expect(markRestartRequired(completedAt)).rejects.toThrow(
            "redis unavailable",
        );
        expect(mockRedis.set).toHaveBeenCalledTimes(5);
        await expect(isRestartRequired(completedAt + 2_000)).resolves.toBe(
            true,
        );
        expect(mockRedis.sendCommand).not.toHaveBeenCalled();
        await expect(getRestoreBarrier()).resolves.toMatchObject({
            code: "RESTART_REQUIRED",
        });
    });

    it("keeps restore routes available while a restore is active", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        const { requireNoPendingRestart } = await import("../restartRequired");
        const next = jest.fn();
        await requireNoPendingRestart(
            { path: "/api/restore/status" } as any,
            response(),
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("caches the Redis result within the short barrier window", async () => {
        mockRedis.sendCommand.mockResolvedValue("0");
        const { isRestartRequired } = await import("../restartRequired");
        await isRestartRequired(10_000);
        await isRestartRequired(10_001);
        expect(mockRedis.sendCommand).toHaveBeenCalledTimes(1);
    });

    it("re-reads the marker after observing the restore lock release", async () => {
        mockRedis.sendCommand
            .mockResolvedValueOnce("0")
            .mockResolvedValueOnce(String(Number.MAX_SAFE_INTEGER));
        mockRestoreLockHeld
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        mockConsumeLockRelease.mockReturnValueOnce(true);
        const { getRestoreBarrier } = await import("../restartRequired");

        await expect(getRestoreBarrier()).resolves.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });
        await expect(getRestoreBarrier()).resolves.toMatchObject({
            code: "RESTART_REQUIRED",
        });
        expect(mockRedis.sendCommand).toHaveBeenCalledTimes(2);
    });

    it("fails open when Redis cannot be read", async () => {
        mockRedis.sendCommand.mockRejectedValue(new Error("redis down"));
        const { isRestartRequired } = await import("../restartRequired");
        await expect(isRestartRequired(20_000)).resolves.toBe(false);
    });

    it("normalizes path case before applying exemptions", async () => {
        mockRestoreLockHeld.mockResolvedValue(true);
        const { requireNoPendingRestart } = await import("../restartRequired");
        const res = response();
        const next = jest.fn();
        await requireNoPendingRestart(
            { path: "/API/onboarding/register" } as any,
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.body).toMatchObject({ code: "RESTORE_IN_PROGRESS" });
    });

    it("bounds a stalled Redis restart-marker read", async () => {
        jest.useFakeTimers();
        mockRedis.sendCommand.mockReturnValue(new Promise(() => undefined));
        const { isRestartRequired } = await import("../restartRequired");
        const pending = isRestartRequired(30_000);
        await jest.advanceTimersByTimeAsync(251);
        await expect(pending).resolves.toBe(false);
        jest.useRealTimers();
    });

    it("shares the raw marker timestamp between normal and forced reads", async () => {
        let resolveRead: ((value: string) => void) | undefined;
        mockRedis.sendCommand.mockReturnValueOnce(
            new Promise<string>((resolve) => {
                resolveRead = resolve;
            }),
        );
        const { readRestartMarker } = await import("../restartRequired");

        const normal = readRestartMarker(false, 40_000);
        const forced = readRestartMarker(true, 40_001);
        resolveRead?.("1234");

        await expect(normal).resolves.toBe(1234);
        await expect(forced).resolves.toBe(1234);
        expect(mockRedis.sendCommand).toHaveBeenCalledTimes(1);
    });

    it("stores an untagged restart marker without treating it as completion", async () => {
        mockRedis.set.mockResolvedValue("OK");
        const restoreId = "98e4582e-e030-4ae8-8aa9-63c8de4f707f";
        const { markRestartRequired, readCompletionMarkerForRestore } =
            await import("../restartRequired");

        await markRestartRequired(12_345, restoreId);

        expect(mockRedis.set).toHaveBeenCalledWith(
            "restore:restart-required",
            `12345:${restoreId}`,
        );
        await expect(
            readCompletionMarkerForRestore(restoreId, false, 12_346),
        ).resolves.toBe(0);
    });

    it("stores and matches a tagged restore completion marker", async () => {
        mockRedis.set.mockResolvedValue("OK");
        const restoreId = "98e4582e-e030-4ae8-8aa9-63c8de4f707f";
        const { markRestoreComplete, readCompletionMarkerForRestore } =
            await import("../restartRequired");

        await markRestoreComplete(12_345, restoreId);

        expect(mockRedis.set).toHaveBeenCalledWith(
            "restore:restart-required",
            `12345:${restoreId}:complete`,
        );
        await expect(
            readCompletionMarkerForRestore(
                "0e717451-202e-4bf2-bdff-07fa5a477c95",
                false,
                12_346,
            ),
        ).resolves.toBe(0);
        await expect(
            readCompletionMarkerForRestore(restoreId, false, 12_346),
        ).resolves.toBe(12_345);
    });

    it("does not parse an untagged failure-path marker as completion", async () => {
        const restoreId = "98e4582e-e030-4ae8-8aa9-63c8de4f707f";
        mockRedis.sendCommand.mockResolvedValue(`12345:${restoreId}`);
        const { readCompletionMarkerForRestore } =
            await import("../restartRequired");

        await expect(
            readCompletionMarkerForRestore(restoreId, true, 50_000),
        ).resolves.toBe(0);
    });

    it("parses a tagged completion marker read from Redis", async () => {
        const restoreId = "98e4582e-e030-4ae8-8aa9-63c8de4f707f";
        mockRedis.sendCommand.mockResolvedValue(`12345:${restoreId}:complete`);
        const { readCompletionMarkerForRestore } =
            await import("../restartRequired");

        await expect(
            readCompletionMarkerForRestore(restoreId, true, 50_000),
        ).resolves.toBe(12_345);
        await expect(
            readCompletionMarkerForRestore(
                "0e717451-202e-4bf2-bdff-07fa5a477c95",
                false,
                50_001,
            ),
        ).resolves.toBe(0);
    });
});
