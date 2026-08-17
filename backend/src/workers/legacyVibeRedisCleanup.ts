import { randomUUID } from "node:crypto";

/** Redis key for provider-backed audio embedding jobs. */
export const VIBE_PROVIDER_QUEUE_KEY = "audio:clap:queue";

const LEGACY_TEXT_EMBED_STREAM = "audio:text:embed:requests";
const LEGACY_TEXT_EMBED_GROUP = "clap:text:embed:group";
const LEGACY_WORKER_HEARTBEAT = "clap:worker:heartbeat";
const RESERVATION_PATTERN = `${VIBE_PROVIDER_QUEUE_KEY}:reserved:*`;
const CLEANUP_MARKER_KEY = "soundspan:legacy-vibe-cleanup:v1";
const CLEANUP_LEASE_KEY = `${CLEANUP_MARKER_KEY}:lease`;
const CLEANUP_LEASE_MS = 120_000;
const CLEANUP_DEADLINE_MS = 55_000;
const REDIS_OPERATION_TIMEOUT_MS = 5_000;
const SCAN_BATCH_SIZE = 2_048;
const MAX_KEYS_PER_PAGE = 2_048;
const MAX_SCAN_PAGES = 1_000;
const DELETE_TTL_LESS_RESERVATION_SCRIPT = `
if redis.call('TTL', KEYS[1]) == -1 then
    return redis.call('DEL', KEYS[1])
end
return 0
`;
const COMPLETE_CLEANUP_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], 'done')
redis.call('DEL', KEYS[1])
return 1
`;

/** Minimal Redis surface required by the one-shot transition cleanup. */
export interface LegacyVibeRedisCleanupClient {
    del(key: string): Promise<number>;
    destroy(): void;
    eval(
        script: string,
        options: { keys: string[]; arguments?: string[] },
    ): Promise<unknown>;
    get(key: string): Promise<string | null>;
    set(
        key: string,
        value: string,
        options: { NX: true; PX: number },
    ): Promise<string | null>;
    scan(
        cursor: string,
        options: { MATCH: string; COUNT: number },
    ): Promise<{ cursor: string; keys: string[] }>;
    xGroupDestroy(key: string, group: string): Promise<number>;
}

interface CleanupLogger {
    warn(message: string, context?: unknown): void;
}

interface CleanupOptions {
    deadlineMs?: number;
    operationTimeoutMs?: number;
    now?: () => number;
    ownerToken?: string;
}

/** Summary of transition artifacts removed from Redis. */
export interface LegacyVibeRedisCleanupResult {
    staleReservationsDeleted: number;
}

async function runRedisOperation<T>(
    client: LegacyVibeRedisCleanupClient,
    operation: () => Promise<T>,
    deadlineAt: number,
    operationTimeoutMs: number,
    now: () => number,
): Promise<T> {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0)
        throw new Error("Legacy vibe cleanup deadline exceeded");
    const timeoutMs = Math.min(remainingMs, operationTimeoutMs);
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            client.destroy();
            reject(new Error("Legacy vibe cleanup Redis operation timed out"));
        }, timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([operation(), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function deleteStaleReservations(
    client: LegacyVibeRedisCleanupClient,
    logger: CleanupLogger,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<number> {
    let cursor = "0";
    let deleted = 0;
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
        const result = await run(() =>
            client.scan(cursor, {
                MATCH: RESERVATION_PATTERN,
                COUNT: SCAN_BATCH_SIZE,
            }),
        );
        if (result.keys.length > MAX_KEYS_PER_PAGE) {
            logger.warn(
                "Legacy vibe reservation scan page exceeded its key limit",
                {
                    cursor,
                    keyCount: result.keys.length,
                    maxKeysPerPage: MAX_KEYS_PER_PAGE,
                },
            );
            throw new Error(
                "Legacy vibe reservation scan page exceeded its key limit",
            );
        }
        for (const key of result.keys) {
            const removed = await run(() =>
                client.eval(DELETE_TTL_LESS_RESERVATION_SCRIPT, {
                    keys: [key],
                }),
            );
            if (removed !== 0 && removed !== 1) {
                throw new Error(
                    "Legacy vibe cleanup returned an invalid delete result",
                );
            }
            deleted += removed;
        }
        cursor = result.cursor;
        if (cursor === "0") return deleted;
    }
    throw new Error("Legacy vibe reservation scan reached its page limit");
}

async function claimCleanup(
    client: LegacyVibeRedisCleanupClient,
    ownerToken: string,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
    if ((await run(() => client.get(CLEANUP_MARKER_KEY))) === "done")
        return false;
    const claimed = await run(() =>
        client.set(CLEANUP_LEASE_KEY, ownerToken, {
            NX: true,
            PX: CLEANUP_LEASE_MS,
        }),
    );
    if (claimed !== "OK") return false;
    return (await run(() => client.get(CLEANUP_MARKER_KEY))) !== "done";
}

async function destroyLegacyConsumerGroup(
    client: LegacyVibeRedisCleanupClient,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
    try {
        await run(() =>
            client.xGroupDestroy(
                LEGACY_TEXT_EMBED_STREAM,
                LEGACY_TEXT_EMBED_GROUP,
            ),
        );
    } catch (error) {
        if (error instanceof Error && error.message.includes("NOGROUP")) return;
        throw error;
    }
}

/** Removes retired CLAP transport artifacts without disturbing valid jobs. */
export async function cleanupLegacyVibeRedisArtifacts(
    client: LegacyVibeRedisCleanupClient,
    logger: CleanupLogger,
    options: CleanupOptions = {},
): Promise<LegacyVibeRedisCleanupResult> {
    const now = options.now ?? Date.now;
    const deadlineAt = now() + (options.deadlineMs ?? CLEANUP_DEADLINE_MS);
    const operationTimeoutMs =
        options.operationTimeoutMs ?? REDIS_OPERATION_TIMEOUT_MS;
    const ownerToken = options.ownerToken ?? randomUUID();
    const run = <T>(operation: () => Promise<T>) =>
        runRedisOperation(
            client,
            operation,
            deadlineAt,
            operationTimeoutMs,
            now,
        );
    if (!(await claimCleanup(client, ownerToken, run))) {
        return { staleReservationsDeleted: 0 };
    }
    await destroyLegacyConsumerGroup(client, run);
    await run(() => client.del(LEGACY_TEXT_EMBED_STREAM));
    await run(() => client.del(LEGACY_WORKER_HEARTBEAT));
    const staleReservationsDeleted = await deleteStaleReservations(
        client,
        logger,
        run,
    );
    const completed = await run(() =>
        client.eval(COMPLETE_CLEANUP_SCRIPT, {
            keys: [CLEANUP_LEASE_KEY, CLEANUP_MARKER_KEY],
            arguments: [ownerToken],
        }),
    );
    if (completed !== 1) throw new Error("Legacy vibe cleanup lease was lost");
    return { staleReservationsDeleted };
}
