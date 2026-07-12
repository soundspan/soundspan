import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export interface CreatePrismaClientOptions {
    /** Maximum pooled connections (pg Pool `max`). */
    connectionLimit?: number;
    /** Seconds to wait for a free pooled connection before erroring. */
    poolTimeoutSeconds?: number;
    log?: Prisma.PrismaClientOptions["log"];
    /** Overrides process.env.DATABASE_URL when provided. */
    databaseUrl?: string;
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

    const adapter = new PrismaPg({
        connectionString: options.databaseUrl ?? process.env.DATABASE_URL,
        ...(connectionLimit !== undefined ? { max: connectionLimit } : {}),
        ...(poolTimeoutSeconds !== undefined ?
            { connectionTimeoutMillis: poolTimeoutSeconds * 1000 }
        :   {}),
    });

    return new PrismaClient({
        adapter,
        ...(options.log !== undefined ? { log: options.log } : {}),
    });
}
