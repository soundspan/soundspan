import {
    readVibeWorkerStatus,
    VIBE_WORKER_STATUS_KEY_PREFIX,
    VIBE_WORKER_STATUS_REGISTRY_KEY,
    writeVibeWorkerStatus,
    type VibeWorkerStatusRedis,
} from "../vibeWorkerStatus";

class InMemoryStatusRedis implements VibeWorkerStatusRedis {
    readonly registry = new Map<string, number>();
    readonly values = new Map<string, string>();

    async mGet(keys: string[]): Promise<Array<string | null>> {
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
        _key: string,
        member: { score: number; value: string },
    ): Promise<unknown> {
        this.registry.set(member.value, member.score);
        return 1;
    }

    async zRange(_key: string, start: number, stop: number): Promise<string[]> {
        const members = [...this.registry]
            .sort(
                ([leftKey, leftScore], [rightKey, rightScore]) =>
                    leftScore - rightScore || leftKey.localeCompare(rightKey),
            )
            .map(([key]) => key);
        const inclusiveStop = stop < 0 ? members.length : stop + 1;
        return members.slice(start, inclusiveStop);
    }

    async zRem(_key: string, members: string[]): Promise<unknown> {
        for (const member of members) this.registry.delete(member);
        return members.length;
    }

    async zRemRangeByScore(
        _key: string,
        minimum: number | string,
        maximum: number | string,
    ): Promise<unknown> {
        const minimumScore = minimum === "-inf" ? -Infinity : Number(minimum);
        const maximumScore = maximum === "+inf" ? Infinity : Number(maximum);
        for (const [member, score] of this.registry) {
            if (score >= minimumScore && score <= maximumScore) {
                this.registry.delete(member);
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
