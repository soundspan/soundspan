export {};

const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    sendCommand: jest.fn(),
    isReady: true,
};
const mockRestoreLockHeld = jest.fn();

jest.mock("../../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../restoreLock", () => ({ isRestoreLockHeld: mockRestoreLockHeld }));
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
        expect(mockRedis.sendCommand).not.toHaveBeenCalled();
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
});
