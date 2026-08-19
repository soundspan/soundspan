const evalScript = jest.fn();
const warn = jest.fn();

jest.mock("../../../utils/redis", () => ({
    redisClient: { eval: evalScript },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn }) },
}));

import {
    clearLibraryHealthPurgeMarker,
    readLibraryHealthPurgeMarker,
    refreshLibraryHealthPurgeMarker,
    startLibraryHealthPurgeMarker,
} from "../purgeMarker";

describe("library health purge marker", () => {
    const expiries = new Map<string, number>();
    const remaining = new Map<string, number>();

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-19T12:00:00.000Z"),
        );
        jest.clearAllMocks();
        expiries.clear();
        remaining.clear();
        evalScript.mockImplementation(
            async (
                _script: string,
                options: { keys: string[]; arguments: string[] },
            ) => {
                if (options.arguments.length === 4) {
                    const [sweepId, count, expiresAt] = options.arguments;
                    if (_script.includes("ZSCORE") && !expiries.has(sweepId)) {
                        return 0;
                    }
                    expiries.set(sweepId, Number(expiresAt));
                    remaining.set(sweepId, Number(count));
                    return 1;
                }
                if (options.arguments.length === 1) {
                    const [argument] = options.arguments;
                    if (/^\d+$/.test(argument)) {
                        const now = Number(argument);
                        for (const [sweepId, expiresAt] of expiries) {
                            if (expiresAt <= now) {
                                expiries.delete(sweepId);
                                remaining.delete(sweepId);
                            }
                        }
                        if (remaining.size === 0) return "-1";
                        return String(Math.max(...remaining.values()));
                    }
                    expiries.delete(argument);
                    remaining.delete(argument);
                    return 1;
                }
                throw new Error("Unexpected purge marker script call");
            },
        );
    });

    afterEach(() => jest.useRealTimers());

    it("refreshes an owner's one-hour expiry", async () => {
        await startLibraryHealthPurgeMarker("sweep-a", 12);
        jest.advanceTimersByTime(30 * 60 * 1000);
        await refreshLibraryHealthPurgeMarker("sweep-a", 11);
        jest.advanceTimersByTime(31 * 60 * 1000);

        await expect(readLibraryHealthPurgeMarker()).resolves.toBe(11);
        expect(evalScript).toHaveBeenCalledWith(expect.any(String), {
            keys: [
                "library-health:purge-active:owners",
                "library-health:purge-active:remaining",
            ],
            arguments: expect.arrayContaining(["sweep-a", "11", "3600"]),
        });
    });

    it("keeps distinct run ownership when a reusable root job id interleaves", async () => {
        await startLibraryHealthPurgeMarker("run-a", 7);
        await startLibraryHealthPurgeMarker("run-b", 19);

        await clearLibraryHealthPurgeMarker("run-a");

        await expect(readLibraryHealthPurgeMarker()).resolves.toBe(19);

        await clearLibraryHealthPurgeMarker("run-b");
        await expect(readLibraryHealthPurgeMarker()).resolves.toBeNull();
    });

    it("does not resurrect an owner when a delayed refresh lands after clear", async () => {
        await startLibraryHealthPurgeMarker("sweep-a", 7);
        let landRefresh!: () => void;
        evalScript.mockImplementationOnce(
            (
                script: string,
                options: { keys: string[]; arguments: string[] },
            ) =>
                new Promise<number>((resolve) => {
                    landRefresh = () => {
                        const [sweepId, count, expiresAt] = options.arguments;
                        if (
                            !script.includes("ZSCORE") ||
                            expiries.has(sweepId)
                        ) {
                            expiries.set(sweepId, Number(expiresAt));
                            remaining.set(sweepId, Number(count));
                        }
                        resolve(1);
                    };
                }),
        );

        const refresh = refreshLibraryHealthPurgeMarker("sweep-a", 6);
        await jest.advanceTimersByTimeAsync(1_500);
        await refresh;
        await clearLibraryHealthPurgeMarker("sweep-a");
        landRefresh();
        await Promise.resolve();

        await expect(readLibraryHealthPurgeMarker()).resolves.toBeNull();
    });
});
