const DEFAULT_SCAN_BATCH_SIZE = 250;
const DEFAULT_SCAN_ITERATION_LIMIT = 10_000;

interface RedisScanClient {
    scan(
        cursor: string,
        matchKeyword: "MATCH",
        pattern: string,
        countKeyword: "COUNT",
        count: number,
    ): Promise<[string, string[]]>;
}

/** Collect matching Redis keys with bounded, incremental SCAN calls. */
export async function scanRedisKeys(
    redis: RedisScanClient,
    pattern: string,
    batchSize = DEFAULT_SCAN_BATCH_SIZE,
    iterationLimit = DEFAULT_SCAN_ITERATION_LIMIT,
): Promise<string[]> {
    if (batchSize <= 0 || iterationLimit <= 0) {
        throw new RangeError("Redis scan bounds must be positive");
    }

    const keys = new Set<string>();
    let cursor = "0";
    for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
        const [nextCursor, page] = await redis.scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            batchSize,
        );
        page.forEach((key) => keys.add(key));
        cursor = nextCursor;
        if (cursor === "0") return [...keys];
    }

    throw new Error(`Redis SCAN iteration limit reached for ${pattern}`);
}

/** Redis COUNT hint used for enrichment mix-cache scans. */
export const ENRICHMENT_MIX_SCAN_BATCH_SIZE = DEFAULT_SCAN_BATCH_SIZE;
