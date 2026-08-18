import {
    readVibeWorkerStatus,
    VIBE_WORKER_STATUS_KEY_PREFIX,
    VIBE_WORKER_STATUS_REGISTRY_KEY,
    writeVibeWorkerStatus,
    type VibeWorkerStatusRedis,
} from "../vibeWorkerStatus";

function createRedis(): jest.Mocked<VibeWorkerStatusRedis> {
    return {
        mGet: jest.fn().mockResolvedValue([]),
        sAdd: jest.fn().mockResolvedValue(1),
        sMembers: jest.fn().mockResolvedValue([]),
        sRem: jest.fn().mockResolvedValue(0),
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

    it("persists a per-worker heartbeat for three refresh intervals", async () => {
        const redis = createRedis();

        await writeVibeWorkerStatus(redis, status, "worker-1");

        expect(redis.sAdd).toHaveBeenCalledWith(
            VIBE_WORKER_STATUS_REGISTRY_KEY,
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-1`,
        );
        expect(redis.set).toHaveBeenCalledWith(
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-1`,
            JSON.stringify(status),
            { PX: 180_000 },
        );
        expect(redis.sAdd.mock.invocationCallOrder[0]).toBeLessThan(
            redis.set.mock.invocationCallOrder[0],
        );
    });

    it("reports the newest fresh worker snapshot", async () => {
        const redis = createRedis();
        redis.sMembers.mockResolvedValueOnce([
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-old`,
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-new`,
        ]);
        redis.mGet.mockResolvedValueOnce([
            JSON.stringify({
                ...status,
                providerReachability: {
                    reachable: false,
                    checkedAt: "2026-08-17T11:59:00.000Z",
                },
            }),
            JSON.stringify(status),
        ]);

        await expect(
            readVibeWorkerStatus(redis, new Date("2026-08-17T12:01:00.000Z")),
        ).resolves.toEqual(status);
    });

    it("treats an expired key omitted by Redis as stale", async () => {
        const redis = createRedis();
        const expiredKey = `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-expired`;
        redis.sMembers.mockResolvedValueOnce([expiredKey]);
        redis.mGet.mockResolvedValueOnce([null]);

        await expect(readVibeWorkerStatus(redis)).resolves.toBeNull();
        expect(redis.sRem).toHaveBeenCalledWith(
            VIBE_WORKER_STATUS_REGISTRY_KEY,
            [expiredKey],
        );
    });

    it("treats an over-age checkedAt as stale while its Redis key survives", async () => {
        const redis = createRedis();
        redis.sMembers.mockResolvedValueOnce([
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-stale`,
        ]);
        redis.mGet.mockResolvedValueOnce([JSON.stringify(status)]);

        await expect(
            readVibeWorkerStatus(redis, new Date("2026-08-17T12:03:00.001Z")),
        ).resolves.toBeNull();
    });

    it.each(["not-json", JSON.stringify({ reachable: "yes" })])(
        "treats invalid cached state as unavailable",
        async (stored) => {
            const redis = createRedis();
            redis.sMembers.mockResolvedValueOnce([
                `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-invalid`,
            ]);
            redis.mGet.mockResolvedValueOnce([stored]);

            await expect(readVibeWorkerStatus(redis)).resolves.toBeNull();
        },
    );

    it("returns live status and removes dead registry keys", async () => {
        const redis = createRedis();
        const deadKey = `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-dead`;
        const liveKey = `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-live`;
        redis.sMembers.mockResolvedValueOnce([deadKey, liveKey]);
        redis.mGet.mockResolvedValueOnce([null, JSON.stringify(status)]);

        await expect(
            readVibeWorkerStatus(redis, new Date("2026-08-17T12:01:00.000Z")),
        ).resolves.toEqual(status);
        expect(redis.sRem).toHaveBeenCalledWith(
            VIBE_WORKER_STATUS_REGISTRY_KEY,
            [deadKey],
        );
    });

    it("rejects a registry above its defensive cardinality bound", async () => {
        const redis = createRedis();
        redis.sMembers.mockResolvedValueOnce(
            Array.from(
                { length: 257 },
                (_, index) => `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-${index}`,
            ),
        );

        await expect(readVibeWorkerStatus(redis)).rejects.toThrow(
            "Vibe worker status registry exceeded its cardinality bound",
        );
        expect(redis.mGet).not.toHaveBeenCalled();
    });
});
