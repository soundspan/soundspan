import {
    readVibeWorkerStatus,
    VIBE_WORKER_STATUS_KEY_PREFIX,
    VIBE_WORKER_STATUS_REGISTRY_KEY,
    writeVibeWorkerStatus,
    type VibeWorkerStatusRedis,
} from "../vibeWorkerStatus";

class InMemoryStatusRedis implements VibeWorkerStatusRedis {
    readonly registries = new Map<string, Map<string, number>>();
    readonly sets = new Map<string, Set<string>>();
    readonly values = new Map<string, string>();
    readonly mGetBatchSizes: number[] = [];
    legacyCleanupRuns = 0;
    afterRegistryScript: (() => void) | null = null;
    failLegacyCleanup = false;

    get registry(): Map<string, number> {
        return this.registryFor(VIBE_WORKER_STATUS_REGISTRY_KEY);
    }

    registryFor(key: string): Map<string, number> {
        let registry = this.registries.get(key);
        if (!registry) {
            registry = new Map<string, number>();
            this.registries.set(key, registry);
        }
        return registry;
    }

    async eval(
        _script: string,
        options: { keys: string[]; arguments?: string[] },
    ): Promise<unknown> {
        if (options.keys.length === 1) {
            const [registryKey] = options.keys;
            const [cutoff, maximum] = options.arguments ?? [];
            if (!registryKey || !cutoff || !maximum) return 0;
            await this.zRemRangeByScore(registryKey, "-inf", Number(cutoff));
            const excess = this.registryFor(registryKey).size - Number(maximum);
            if (excess > 0) {
                await this.zRemRangeByRank(registryKey, 0, excess - 1);
            }
            const members = await this.zRange(registryKey, 0, -1);
            this.afterRegistryScript?.();
            return members;
        }
        const [legacyRegistryKey, markerKey] = options.keys;
        if (!legacyRegistryKey || !markerKey) return 0;
        if (this.failLegacyCleanup) {
            throw new Error("legacy cleanup failed");
        }
        if (this.values.get(markerKey) === "done") return 0;
        if (this.sets.has(legacyRegistryKey) && _script.includes("ZRANGE")) {
            throw new Error(
                "WRONGTYPE Operation against a key holding the wrong kind of value",
            );
        }
        this.registries.delete(legacyRegistryKey);
        this.sets.delete(legacyRegistryKey);
        this.values.set(markerKey, "done");
        this.legacyCleanupRuns += 1;
        return 1;
    }

    async mGet(keys: string[]): Promise<Array<string | null>> {
        this.mGetBatchSizes.push(keys.length);
        return keys.map((key) => this.values.get(key) ?? null);
    }

    async set(
        key: string,
        value: string,
        _options: { PX: number },
    ): Promise<unknown> {
        this.values.set(key, value);
        return "OK";
    }

    async zAdd(
        key: string,
        member: { score: number; value: string },
    ): Promise<unknown> {
        this.registryFor(key).set(member.value, member.score);
        return 1;
    }

    async sAdd(key: string, member: string): Promise<number> {
        const members = this.sets.get(key) ?? new Set<string>();
        this.sets.set(key, members);
        const previousSize = members.size;
        members.add(member);
        return members.size - previousSize;
    }

    async zRange(key: string, start: number, stop: number): Promise<string[]> {
        const members = [...this.registryFor(key)]
            .sort(
                ([leftKey, leftScore], [rightKey, rightScore]) =>
                    leftScore - rightScore || leftKey.localeCompare(rightKey),
            )
            .map(([key]) => key);
        const inclusiveStop = stop < 0 ? members.length : stop + 1;
        return members.slice(start, inclusiveStop);
    }

    async zRem(key: string, members: string[]): Promise<unknown> {
        const registry = this.registryFor(key);
        for (const member of members) registry.delete(member);
        return members.length;
    }

    async zRemRangeByRank(
        key: string,
        start: number,
        stop: number,
    ): Promise<unknown> {
        const registry = this.registryFor(key);
        const members = [...registry]
            .sort(
                ([leftKey, leftScore], [rightKey, rightScore]) =>
                    leftScore - rightScore || leftKey.localeCompare(rightKey),
            )
            .map(([member]) => member);
        const normalizedStop = stop < 0 ? members.length + stop : stop;
        if (normalizedStop < start) return 0;
        const removed = members.slice(start, normalizedStop + 1);
        for (const member of removed) registry.delete(member);
        return removed.length;
    }

    async zRemRangeByScore(
        key: string,
        minimum: number | string,
        maximum: number | string,
    ): Promise<unknown> {
        const minimumScore = minimum === "-inf" ? -Infinity : Number(minimum);
        const maximumScore = maximum === "+inf" ? Infinity : Number(maximum);
        const registry = this.registryFor(key);
        for (const [member, score] of registry) {
            if (score >= minimumScore && score <= maximumScore) {
                registry.delete(member);
            }
        }
        return 1;
    }
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

    function addStatus(
        redis: InMemoryStatusRedis,
        workerId: string,
        score: number,
        storedStatus: unknown = status,
    ): void {
        const key = `${VIBE_WORKER_STATUS_KEY_PREFIX}${workerId}`;
        redis.registry.set(key, score);
        redis.values.set(key, JSON.stringify(storedStatus));
    }

    it("persists a timestamped heartbeat for three refresh intervals", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:00:00.000Z");
        const set = jest.spyOn(redis, "set");
        const zAdd = jest.spyOn(redis, "zAdd");

        await writeVibeWorkerStatus(redis, status, "worker-1", now);

        expect(set).toHaveBeenCalledWith(
            `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-1`,
            JSON.stringify(status),
            { PX: 180_000 },
        );
        expect(zAdd).toHaveBeenCalledWith(VIBE_WORKER_STATUS_REGISTRY_KEY, {
            score: now.getTime(),
            value: `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-1`,
        });
    });

    it("reports the newest fresh worker snapshot", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:01:00.000Z");
        addStatus(redis, "worker-old", now.getTime() - 120_000, {
            ...status,
            providerReachability: {
                reachable: false,
                checkedAt: "2026-08-17T11:59:00.000Z",
            },
        });
        addStatus(redis, "worker-new", now.getTime() - 60_000);

        await expect(readVibeWorkerStatus(redis, now)).resolves.toEqual(status);
    });

    it("removes a recent registry member whose status key is dead", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:01:00.000Z");
        const deadKey = `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-dead`;
        redis.registry.set(deadKey, now.getTime());

        await expect(readVibeWorkerStatus(redis, now)).resolves.toBeNull();
        expect(redis.registry.has(deadKey)).toBe(false);
    });

    it("treats an over-age checkedAt as stale while its Redis key survives", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:03:00.001Z");
        addStatus(redis, "worker-stale", now.getTime());

        await expect(readVibeWorkerStatus(redis, now)).resolves.toBeNull();
    });

    it.each(["not-json", JSON.stringify({ reachable: "yes" })])(
        "treats invalid cached state as unavailable",
        async (stored) => {
            const redis = new InMemoryStatusRedis();
            const now = new Date("2026-08-17T12:01:00.000Z");
            const key = `${VIBE_WORKER_STATUS_KEY_PREFIX}worker-invalid`;
            redis.registry.set(key, now.getTime());
            redis.values.set(key, stored);

            await expect(readVibeWorkerStatus(redis, now)).resolves.toBeNull();
        },
    );

    it("prunes 300 stale members before returning two live statuses", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:05:00.000Z");
        for (let index = 0; index < 300; index += 1) {
            addStatus(redis, `stale-${index}`, now.getTime() - 180_001);
        }
        addStatus(redis, "worker-live-1", now.getTime() - 60_000);
        addStatus(redis, "worker-live-2", now.getTime(), {
            ...status,
            providerReachability: {
                reachable: true,
                checkedAt: now.toISOString(),
            },
        });

        await expect(readVibeWorkerStatus(redis, now)).resolves.toMatchObject({
            providerReachability: { checkedAt: now.toISOString() },
        });
        expect(redis.registry.size).toBe(2);
    });

    it.each(["read", "write"])(
        "caps the %s path MGET at 256 fresh registry members",
        async (path) => {
            const redis = new InMemoryStatusRedis();
            const now = new Date("2026-08-17T12:00:00.000Z");
            for (let index = 0; index < 300; index += 1) {
                addStatus(redis, `fresh-${index}`, now.getTime() + index);
            }

            if (path === "read") {
                await readVibeWorkerStatus(redis, now);
            } else {
                await writeVibeWorkerStatus(redis, status, "writer", now);
            }

            expect(Math.max(...redis.mGetBatchSizes)).toBeLessThanOrEqual(256);
            expect(redis.registry.size).toBeLessThanOrEqual(256);
        },
    );

    it("removes the v2 registry once without disturbing v3 status", async () => {
        const redis = new InMemoryStatusRedis();
        const v2RegistryKey = "soundspan:vibe-worker-status:v2:registry";
        await redis.sAdd(
            v2RegistryKey,
            "soundspan:vibe-worker-status:v2:old-worker",
        );
        redis.values.set(
            "soundspan:vibe-worker-status:v2:old-worker",
            JSON.stringify(status),
        );
        const now = new Date("2026-08-17T12:00:00.000Z");
        addStatus(redis, "worker-v3", now.getTime());

        await expect(readVibeWorkerStatus(redis, now)).resolves.toEqual(status);
        await expect(readVibeWorkerStatus(redis, now)).resolves.toEqual(status);

        expect(redis.sets.has(v2RegistryKey)).toBe(false);
        expect(redis.legacyCleanupRuns).toBe(1);
        expect(
            redis.registry.has(`${VIBE_WORKER_STATUS_KEY_PREFIX}worker-v3`),
        ).toBe(true);
    });

    it("continues v3 reads when one-time v2 cleanup fails", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:00:00.000Z");
        redis.failLegacyCleanup = true;
        addStatus(redis, "worker-v3", now.getTime());

        await expect(readVibeWorkerStatus(redis, now)).resolves.toEqual(status);

        expect(
            redis.values.has(
                "soundspan:vibe-worker-status:v2-registry-cleanup:v1",
            ),
        ).toBe(false);
    });

    it("keeps MGET bounded when a heartbeat lands after the registry script", async () => {
        const redis = new InMemoryStatusRedis();
        const now = new Date("2026-08-17T12:00:00.000Z");
        for (let index = 0; index < 256; index += 1) {
            addStatus(redis, `fresh-${index}`, now.getTime() + index);
        }
        redis.afterRegistryScript = () => {
            addStatus(redis, "interleaved", now.getTime() + 1_000);
            redis.afterRegistryScript = null;
        };

        await readVibeWorkerStatus(redis, now);

        expect(Math.max(...redis.mGetBatchSizes)).toBeLessThanOrEqual(256);
    });

    it("keeps repeated restart identities bounded by timestamp expiry", async () => {
        const redis = new InMemoryStatusRedis();
        const startedAt = Date.parse("2026-08-17T12:00:00.000Z");

        for (let index = 0; index < 600; index += 1) {
            const now = new Date(startedAt + index * 60_000);
            await writeVibeWorkerStatus(
                redis,
                {
                    ...status,
                    providerReachability: {
                        reachable: true,
                        checkedAt: now.toISOString(),
                    },
                },
                `restart-${index}`,
                now,
            );
        }

        expect(redis.registry.size).toBeLessThanOrEqual(3);
    });
});
