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
        await refreshLibraryHealthPurgeMarker("sweep-a", 12);
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

    it("clears only the completing owner during interleaved sweeps", async () => {
        await refreshLibraryHealthPurgeMarker("sweep-a", 7);
        await refreshLibraryHealthPurgeMarker("sweep-b", 19);

        await clearLibraryHealthPurgeMarker("sweep-a");

        await expect(readLibraryHealthPurgeMarker()).resolves.toBe(19);

        await clearLibraryHealthPurgeMarker("sweep-b");
        await expect(readLibraryHealthPurgeMarker()).resolves.toBeNull();
    });
});
