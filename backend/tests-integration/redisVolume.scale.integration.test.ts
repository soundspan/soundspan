import type {
    Options as ExpressRateLimitOptions,
    Store,
} from "express-rate-limit";
import Redis from "ioredis";
import {
    createRedisRateLimitOptions,
    type RateLimitRedisClient,
} from "../src/middleware/rateLimitStore";
import {
    enqueueReservedWork,
    type EnrichmentQueueRedis,
} from "../src/workers/enrichmentQueue";
import {
    readVibeWorkerStatus,
    VIBE_WORKER_STATUS_KEY_PREFIX,
    VIBE_WORKER_STATUS_REGISTRY_KEY,
    type VibeWorkerStatusRedis,
} from "../src/workers/vibeWorkerStatus";

const integrationRedisUrl = process.env.INTEGRATION_REDIS_URL;
const describeWithRedis = integrationRedisUrl ? describe : describe.skip;
const SEEDED_KEY_COUNT = 25_000;
const STATUS_KEY_COUNT = 200;
const OTHER_STATUS_KEY_COUNT = 12_400;
const RESERVATION_KEY_COUNT =
    SEEDED_KEY_COUNT - STATUS_KEY_COUNT - OTHER_STATUS_KEY_COUNT;
const REDIS_BUDGET_MS = 2_000;
const PIPELINE_BATCH_SIZE = 1_000;
const REFERENCE_NOW = new Date("2026-08-18T12:00:00.000Z");

function validateDedicatedRedisUrl(redisUrl: string): string {
    const parsed = new URL(redisUrl);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
        throw new Error("INTEGRATION_REDIS_URL must use redis:// or rediss://");
    }
    if (!/^\/\d+$/.test(parsed.pathname)) {
        throw new Error(
            "INTEGRATION_REDIS_URL must include an explicit /db-index suffix",
        );
    }
    const databaseIndex = Number(parsed.pathname.slice(1));
    if (!Number.isSafeInteger(databaseIndex)) {
        throw new Error("INTEGRATION_REDIS_URL database index is invalid");
    }
    if (
        databaseIndex === 0 &&
        process.env.ALLOW_SCALE_TEST_REDIS_DB_ZERO !== "1"
    ) {
        throw new Error(
            "Scale tests refuse Redis database 0 without ALLOW_SCALE_TEST_REDIS_DB_ZERO=1",
        );
    }
    return parsed.toString();
}

async function withinBudget<T>(
    label: string,
    operation: () => Promise<T>,
): Promise<T> {
    const startedAt = performance.now();
    const result = await operation();
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > REDIS_BUDGET_MS) {
        throw new Error(
            `${label} exceeded ${REDIS_BUDGET_MS}ms wall-clock budget (${elapsedMs.toFixed(1)}ms)`,
        );
    }
    return result;
}

function statusPayload(index: number): string {
    const checkedAt = new Date(
        REFERENCE_NOW.getTime() - (STATUS_KEY_COUNT - index) * 1_000,
    );
    return JSON.stringify({
        providerReachability: {
            reachable: true,
            checkedAt: checkedAt.toISOString(),
        },
        targetSpace: {
            id: "space_clap_music_audioset_v1",
            family: "clap-music-audioset",
            status: "active",
        },
        coverage: { embedded: index, pending: 1, failed: 0 },
    });
}

async function executePipeline(pipeline: ReturnType<Redis["pipeline"]>) {
    const results = await pipeline.exec();
    if (results === null) throw new Error("Redis pipeline returned no results");
    const failure = results.find(([error]) => error !== null);
    if (failure?.[0]) throw failure[0];
}

async function seedRegisteredStatuses(redis: Redis): Promise<void> {
    for (
        let start = 0;
        start < STATUS_KEY_COUNT;
        start += PIPELINE_BATCH_SIZE
    ) {
        const pipeline = redis.pipeline();
        const end = Math.min(start + PIPELINE_BATCH_SIZE, STATUS_KEY_COUNT);
        for (let index = start; index < end; index += 1) {
            const key = `${VIBE_WORKER_STATUS_KEY_PREFIX}scale-${index}`;
            pipeline.zadd(VIBE_WORKER_STATUS_REGISTRY_KEY, Date.now(), key);
            pipeline.set(key, statusPayload(index), "PX", 600_000);
        }
        await executePipeline(pipeline);
    }
}

async function seedWorkerStatusKeys(redis: Redis): Promise<void> {
    for (
        let start = 0;
        start < OTHER_STATUS_KEY_COUNT;
        start += PIPELINE_BATCH_SIZE
    ) {
        const pipeline = redis.pipeline();
        const end = Math.min(
            start + PIPELINE_BATCH_SIZE,
            OTHER_STATUS_KEY_COUNT,
        );
        for (let index = start; index < end; index += 1) {
            pipeline.set(
                `${VIBE_WORKER_STATUS_KEY_PREFIX}unregistered-${index}`,
                statusPayload(STATUS_KEY_COUNT + 100),
            );
        }
        await executePipeline(pipeline);
    }
}

async function seedReservationKeys(redis: Redis): Promise<void> {
    for (
        let start = 0;
        start < RESERVATION_KEY_COUNT;
        start += PIPELINE_BATCH_SIZE
    ) {
        const pipeline = redis.pipeline();
        const end = Math.min(
            start + PIPELINE_BATCH_SIZE,
            RESERVATION_KEY_COUNT,
        );
        for (let index = start; index < end; index += 1) {
            pipeline.set(`audio:analysis:queue:reserved:scale-${index}`, "1");
        }
        await executePipeline(pipeline);
    }
}

async function seedVolume(redis: Redis): Promise<void> {
    await seedRegisteredStatuses(redis);
    await seedWorkerStatusKeys(redis);
    await seedReservationKeys(redis);
}

function statusRedisAdapter(redis: Redis): VibeWorkerStatusRedis {
    return {
        eval: (script, options) =>
            redis.eval(
                script,
                options.keys.length,
                ...options.keys,
                ...(options.arguments ?? []),
            ),
        mGet: (keys) => redis.mget(...keys),
        set: (key, value, options) => redis.set(key, value, "PX", options.PX),
        zAdd: (key, member) => redis.zadd(key, member.score, member.value),
        zRem: (key, members) => redis.zrem(key, ...members),
    };
}

function rateLimitRedisAdapter(redis: Redis): RateLimitRedisClient {
    return {
        get isReady() {
            return redis.status === "ready";
        },
        sendCommand: (args) => redis.call(args[0], ...args.slice(1)),
    };
}

async function waitForKeyExpiry(redis: Redis, key: string): Promise<boolean> {
    const maxPolls = 40;
    for (let poll = 0; poll < maxPolls; poll += 1) {
        if ((await redis.exists(key)) === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

describeWithRedis("Redis production-volume keyspace behavior", () => {
    let redis: Redis;

    beforeAll(async () => {
        const redisUrl = validateDedicatedRedisUrl(integrationRedisUrl!);
        redis = new Redis(redisUrl, {
            lazyConnect: true,
            connectTimeout: 5_000,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
        });
        await redis.connect();
        await redis.flushdb();
        await seedVolume(redis);
    });

    afterAll(async () => {
        if (!redis) return;
        await redis.flushdb();
        await redis.quit();
    });

    it("reads exact registry members without scanning the 25k-key database", async () => {
        const status = await withinBudget("worker status registry read", () =>
            readVibeWorkerStatus(statusRedisAdapter(redis), REFERENCE_NOW),
        );

        // Seeded value keys + the registry zset + the one-time v2-registry
        // cleanup marker written by the first status read.
        expect(await redis.dbsize()).toBe(SEEDED_KEY_COUNT + 2);
        expect(
            await redis.get(
                "soundspan:vibe-worker-status:v2-registry-cleanup:v1",
            ),
        ).toBe("done");
        expect(status?.coverage?.embedded).toBe(STATUS_KEY_COUNT - 1);
        expect(status?.providerReachability.reachable).toBe(true);

        await readVibeWorkerStatus(statusRedisAdapter(redis), REFERENCE_NOW);
        expect(await redis.dbsize()).toBe(SEEDED_KEY_COUNT + 2);
    });

    it("increments and expires a shared rate-limit counter", async () => {
        const client = rateLimitRedisAdapter(redis);
        const options = createRedisRateLimitOptions("scale-smoke", {
            client,
            commandTimeoutMs: REDIS_BUDGET_MS,
        });
        const store = options.store as Store | undefined;
        if (!store) throw new Error("Rate-limit store was not created");
        store.init?.({ windowMs: 250 } as ExpressRateLimitOptions);

        const [first, second] = await withinBudget(
            "rate-limit increment",
            async () => [
                await store.increment("client-a"),
                await store.increment("client-a"),
            ],
        );
        const key = "rl:scale-smoke:client-a";
        const ttlMs = await redis.pttl(key);

        expect(first.totalHits).toBe(1);
        expect(second.totalHits).toBe(2);
        expect(ttlMs).toBeGreaterThan(0);
        expect(await waitForKeyExpiry(redis, key)).toBe(true);
    });

    it("rejects reserved work when the real queue is already full", async () => {
        const queueKey = "audio:analysis:queue:scale-full";
        const maxDepth = 500;
        const payloads = Array.from({ length: maxDepth }, (_unused, index) =>
            JSON.stringify({ trackId: `existing-${index}` }),
        );
        await redis.rpush(queueKey, ...payloads);

        const admission = await withinBudget("full queue admission", () =>
            enqueueReservedWork(redis as EnrichmentQueueRedis, {
                queueKey,
                trackId: "rejected-track",
                payload: JSON.stringify({ trackId: "rejected-track" }),
                maxDepth,
                reservationTtlSeconds: 60,
            }),
        );

        expect(admission).toBe("full");
        expect(await redis.llen(queueKey)).toBe(maxDepth);
        expect(await redis.exists(`${queueKey}:reserved:rejected-track`)).toBe(
            0,
        );
    });
});
