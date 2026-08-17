/** Redis key for provider-backed audio embedding jobs. */
export const VIBE_PROVIDER_QUEUE_KEY = "audio:clap:queue";

const LEGACY_TEXT_EMBED_STREAM = "audio:text:embed:requests";
const LEGACY_TEXT_EMBED_GROUP = "clap:text:embed:group";
const LEGACY_WORKER_HEARTBEAT = "clap:worker:heartbeat";
const RESERVATION_PATTERN = `${VIBE_PROVIDER_QUEUE_KEY}:reserved:*`;
const SCAN_BATCH_SIZE = 100;
const MAX_SCAN_PAGES = 1_000;

/** Minimal Redis surface required by the one-shot transition cleanup. */
export interface LegacyVibeRedisCleanupClient {
    del(key: string): Promise<number>;
    scan(
        cursor: string,
        options: { MATCH: string; COUNT: number },
    ): Promise<{ cursor: string; keys: string[] }>;
    ttl(key: string): Promise<number>;
    xGroupDestroy(key: string, group: string): Promise<number>;
}

interface CleanupLogger {
    warn(message: string, context?: unknown): void;
}

/** Summary of transition artifacts removed from Redis. */
export interface LegacyVibeRedisCleanupResult {
    staleReservationsDeleted: number;
}

async function runBestEffort(
    operation: () => Promise<unknown>,
    description: string,
    logger: CleanupLogger,
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        logger.warn(`Failed to ${description}`, { error });
    }
}

async function deleteStaleReservations(
    client: LegacyVibeRedisCleanupClient,
    logger: CleanupLogger,
): Promise<number> {
    let cursor = "0";
    let deleted = 0;
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
        const result = await client.scan(cursor, {
            MATCH: RESERVATION_PATTERN,
            COUNT: SCAN_BATCH_SIZE,
        });
        for (let index = 0; index < SCAN_BATCH_SIZE; index += 1) {
            const key = result.keys[index];
            if (!key) break;
            await runBestEffort(
                async () => {
                    if ((await client.ttl(key)) !== -1) return;
                    deleted += await client.del(key);
                },
                `remove stale vibe reservation ${key}`,
                logger,
            );
        }
        cursor = result.cursor;
        if (cursor === "0") return deleted;
    }
    logger.warn("Legacy vibe reservation scan reached its page limit", {
        maxPages: MAX_SCAN_PAGES,
    });
    return deleted;
}

/** Removes retired CLAP transport artifacts without disturbing valid jobs. */
export async function cleanupLegacyVibeRedisArtifacts(
    client: LegacyVibeRedisCleanupClient,
    logger: CleanupLogger,
): Promise<LegacyVibeRedisCleanupResult> {
    await runBestEffort(
        () =>
            client.xGroupDestroy(
                LEGACY_TEXT_EMBED_STREAM,
                LEGACY_TEXT_EMBED_GROUP,
            ),
        "remove the legacy text-embedding consumer group",
        logger,
    );
    await runBestEffort(
        () => client.del(LEGACY_TEXT_EMBED_STREAM),
        "remove the legacy text-embedding stream",
        logger,
    );
    await runBestEffort(
        () => client.del(LEGACY_WORKER_HEARTBEAT),
        "remove the legacy CLAP worker heartbeat",
        logger,
    );
    let staleReservationsDeleted = 0;
    await runBestEffort(
        async () => {
            staleReservationsDeleted = await deleteStaleReservations(
                client,
                logger,
            );
        },
        "scan legacy vibe queue reservations",
        logger,
    );
    return { staleReservationsDeleted };
}
