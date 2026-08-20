const prismaPgConstructor = jest.fn();
const prismaClientConstructor = jest.fn();

jest.mock("@prisma/adapter-pg", () => ({
    PrismaPg: class {
        constructor(...args: unknown[]) {
            prismaPgConstructor(...args);
        }
    },
}));

jest.mock("@prisma/client", () => ({
    Prisma: {},
    PrismaClient: class {
        constructor(...args: unknown[]) {
            prismaClientConstructor(...args);
        }
    },
}));

import { createPrismaClient } from "../prismaClientFactory";

describe("createPrismaClient", () => {
    beforeEach(() => {
        prismaPgConstructor.mockClear();
        prismaClientConstructor.mockClear();
    });

    it("enables TCP keepalive on the pg pool", () => {
        createPrismaClient({ databaseUrl: "postgresql://u:p@db:5432/app" });

        expect(prismaPgConstructor).toHaveBeenCalledTimes(1);
        const poolConfig = prismaPgConstructor.mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(poolConfig.keepAlive).toBe(true);
        expect(poolConfig.keepAliveInitialDelayMillis).toBe(10_000);
    });

    it("applies pool sizing and schema options", () => {
        createPrismaClient({
            databaseUrl: "postgresql://u:p@db:5432/app?schema=tenant",
            connectionLimit: 12,
            poolTimeoutSeconds: 20,
        });

        const [poolConfig, adapterOptions] = prismaPgConstructor.mock
            .calls[0] as [Record<string, unknown>, Record<string, unknown>];
        expect(poolConfig.max).toBe(12);
        expect(poolConfig.connectionTimeoutMillis).toBe(20_000);
        expect(adapterOptions).toEqual({ schema: "tenant" });
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
