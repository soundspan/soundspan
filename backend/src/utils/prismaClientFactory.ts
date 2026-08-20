import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// First keepalive probe after 10s idle. Node then applies its own probe
// cadence (TCP_KEEPINTVL=1s, TCP_KEEPCNT=10) rather than kernel defaults.
const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000;

export interface CreatePrismaClientOptions {
    /** Maximum pooled connections (pg Pool `max`). */
    connectionLimit?: number;
    /** Seconds to wait for a free pooled connection before erroring. */
    poolTimeoutSeconds?: number;
    log?: Prisma.PrismaClientOptions["log"];
    /** Overrides process.env.DATABASE_URL when provided. */
    databaseUrl?: string;
}

function schemaFromDatabaseUrl(
    databaseUrl: string | undefined,
): string | undefined {
    if (!databaseUrl) return undefined;
    try {
        return new URL(databaseUrl).searchParams.get("schema") || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Prisma 7 removed the embedded Rust engine and the `datasources` constructor
 * option; every direct database connection now goes through a driver adapter.
 * This factory is the single place the backend builds the pg adapter so pool
 * sizing stays consistent across the API, workers, scripts, and seeds.
 */
export function createPrismaClient(
    options: CreatePrismaClientOptions = {},
): PrismaClient {
    const { connectionLimit, poolTimeoutSeconds } = options;
    if (connectionLimit !== undefined && connectionLimit < 1) {
        throw new Error(
            `createPrismaClient: connectionLimit must be >= 1, got ${connectionLimit}`,
        );
    }
    if (poolTimeoutSeconds !== undefined && poolTimeoutSeconds <= 0) {
        throw new Error(
            `createPrismaClient: poolTimeoutSeconds must be > 0, got ${poolTimeoutSeconds}`,
        );
    }

    const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    const schema = schemaFromDatabaseUrl(databaseUrl);
    const adapter = new PrismaPg(
        {
            connectionString: databaseUrl,
            // TCP keepalive protects pooled connections that cross NAT hops
            // (NodePort, firewalls, cross-cluster routing): without probes an
            // idle flow's conntrack entry expires and the next query dies with
            // "Connection terminated unexpectedly".
            keepAlive: true,
            keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
            ...(connectionLimit !== undefined ? { max: connectionLimit } : {}),
            ...(poolTimeoutSeconds !== undefined
                ? { connectionTimeoutMillis: poolTimeoutSeconds * 1000 }
                : {}),
        },
        schema ? { schema } : undefined,
    );

    return new PrismaClient({
        adapter,
        ...(options.log !== undefined ? { log: options.log } : {}),
    });
}
