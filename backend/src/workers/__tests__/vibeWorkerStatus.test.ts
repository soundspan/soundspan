import {
    readVibeWorkerStatus,
    VIBE_WORKER_STATUS_KEY,
    writeVibeWorkerStatus,
    type VibeWorkerStatusRedis,
} from "../vibeWorkerStatus";

function createRedis(): jest.Mocked<VibeWorkerStatusRedis> {
    return {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
    };
}

describe("vibe worker status cache", () => {
    const status = {
        providerReachability: {
            reachable: true,
            checkedAt: "2026-08-17T12:00:00.000Z",
        },
        targetSpace: {
            id: "space-migrating",
            family: "student-family",
            status: "migrating" as const,
        },
        coverage: { embedded: 80, pending: 20, failed: 3 },
    };

    it("persists the last worker-owned verdict without an expiry", async () => {
        const redis = createRedis();

        await writeVibeWorkerStatus(redis, status);

        expect(redis.set).toHaveBeenCalledWith(
            VIBE_WORKER_STATUS_KEY,
            JSON.stringify(status),
        );
    });

    it("reads and validates the cached worker snapshot", async () => {
        const redis = createRedis();
        redis.get.mockResolvedValueOnce(JSON.stringify(status));

        await expect(readVibeWorkerStatus(redis)).resolves.toEqual(status);
    });

    it.each(["not-json", JSON.stringify({ reachable: "yes" })])(
        "treats invalid cached state as unavailable",
        async (stored) => {
            const redis = createRedis();
            redis.get.mockResolvedValueOnce(stored);

            await expect(readVibeWorkerStatus(redis)).resolves.toBeNull();
        },
    );
});
