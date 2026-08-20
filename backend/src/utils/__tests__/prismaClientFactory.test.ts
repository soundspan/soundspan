import type { PrismaPg } from "@prisma/adapter-pg";

const prismaClientConstructor = jest.fn();

jest.mock("@prisma/client", () => ({
    Prisma: {},
    PrismaClient: class {
        constructor(...args: unknown[]) {
            prismaClientConstructor(...args);
        }
    },
}));

import { createPrismaClient } from "../prismaClientFactory";

interface PgPoolOptions {
    keepAlive?: boolean;
    keepAliveInitialDelayMillis?: number;
    max?: number;
    connectionTimeoutMillis?: number;
}

/**
 * Builds the REAL PrismaPg adapter through the factory and returns the pg
 * pool options it hands to pg.Pool. connect() constructs the pool lazily,
 * so no database connection is opened.
 */
async function poolOptionsFor(
    options: Parameters<typeof createPrismaClient>[0],
): Promise<{ poolOptions: PgPoolOptions; adapterFactory: PrismaPg }> {
    createPrismaClient(options);
    const clientArgs = prismaClientConstructor.mock.calls.at(-1)?.[0] as {
        adapter: PrismaPg;
    };
    const adapterFactory = clientArgs.adapter;
    const adapter = await adapterFactory.connect();
    const pool = adapter.underlyingDriver() as unknown as {
        options: PgPoolOptions;
    };
    const poolOptions = pool.options;
    await adapter.dispose();
    return { poolOptions, adapterFactory };
}

describe("createPrismaClient", () => {
    beforeEach(() => {
        prismaClientConstructor.mockClear();
    });

    it("enables TCP keepalive on the pg pool", async () => {
        const { poolOptions } = await poolOptionsFor({
            databaseUrl: "postgresql://u:p@db:5432/app",
        });

        expect(poolOptions.keepAlive).toBe(true);
        expect(poolOptions.keepAliveInitialDelayMillis).toBe(10_000);
    });

    it("applies pool sizing and schema options", async () => {
        const { poolOptions, adapterFactory } = await poolOptionsFor({
            databaseUrl: "postgresql://u:p@db:5432/app?schema=tenant",
            connectionLimit: 12,
            poolTimeoutSeconds: 20,
        });

        expect(poolOptions.max).toBe(12);
        expect(poolOptions.connectionTimeoutMillis).toBe(20_000);
        expect(
            (adapterFactory as unknown as { options?: { schema?: string } })
                .options?.schema,
        ).toBe("tenant");
    });

    it("rejects invalid pool bounds", () => {
        expect(() => createPrismaClient({ connectionLimit: 0 })).toThrow(
            "connectionLimit must be >= 1",
        );
        expect(() => createPrismaClient({ poolTimeoutSeconds: 0 })).toThrow(
            "poolTimeoutSeconds must be > 0",
        );
    });
});
