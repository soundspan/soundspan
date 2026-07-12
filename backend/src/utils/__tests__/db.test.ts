describe("db connection pool config", () => {
    const originalEnv = process.env;
    const originalArgv = process.argv;

    afterEach(() => {
        process.env = originalEnv;
        process.argv = originalArgv;
        jest.resetModules();
        jest.clearAllMocks();
        jest.unmock("@prisma/client");
        jest.unmock("@prisma/adapter-pg");
    });

    function loadDbModule(options?: {
        role?: string;
        argv1?: string;
        poolSize?: string;
        poolTimeout?: string;
        databaseUrl?: string;
    }) {
        process.env = { ...originalEnv };
        process.argv = [...originalArgv];

        if (options?.role === undefined) {
            delete process.env.BACKEND_PROCESS_ROLE;
        } else {
            process.env.BACKEND_PROCESS_ROLE = options.role;
        }
        if (options?.poolSize === undefined) {
            delete process.env.DATABASE_POOL_SIZE;
        } else {
            process.env.DATABASE_POOL_SIZE = options.poolSize;
        }
        if (options?.poolTimeout === undefined) {
            delete process.env.DATABASE_POOL_TIMEOUT;
        } else {
            process.env.DATABASE_POOL_TIMEOUT = options.poolTimeout;
        }

        process.env.DATABASE_URL =
            options?.databaseUrl ??
            "postgresql://soundspan:secret@db.example:5432/soundspan";
        process.argv[1] = options?.argv1 ?? "/app/dist/index.js";

        const prismaClientCtor = jest.fn().mockImplementation((opts: unknown) => ({
            __opts: opts,
        }));
        const prismaPgCtor = jest.fn().mockImplementation((config: unknown) => ({
            __config: config,
        }));
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
        };

        jest.doMock("@prisma/client", () => ({
            PrismaClient: prismaClientCtor,
            Prisma: {},
        }));
        jest.doMock("@prisma/adapter-pg", () => ({
            PrismaPg: prismaPgCtor,
        }));
        jest.doMock("../logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const dbModule = require("../db");

        return {
            dbModule,
            prismaClientCtor,
            prismaPgCtor,
            logger,
        };
    }

    it("uses worker-default pool when role is inferred from worker entrypoint", () => {
        const { prismaClientCtor, prismaPgCtor, logger } = loadDbModule({
            argv1: "/app/dist/worker.js",
        });

        const poolConfig = prismaPgCtor.mock.calls[0][0];
        expect(poolConfig.max).toBe(4);
        expect(poolConfig.connectionTimeoutMillis).toBe(30_000);

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        expect(prismaOptions.adapter).toBe(prismaPgCtor.mock.results[0].value);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("role=worker"),
        );
    });

    it("warns on invalid role and infers api defaults from api entrypoint", () => {
        const { prismaPgCtor, logger } = loadDbModule({
            role: "bogus",
            argv1: "/app/dist/index.js",
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Invalid BACKEND_PROCESS_ROLE"),
        );
        const poolConfig = prismaPgCtor.mock.calls[0][0];
        expect(poolConfig.max).toBe(8);
        expect(poolConfig.connectionTimeoutMillis).toBe(30_000);
    });

    it("respects explicit pool overrides and passes DATABASE_URL through untouched", () => {
        const { prismaPgCtor } = loadDbModule({
            role: "worker",
            poolSize: "9",
            poolTimeout: "15",
            databaseUrl:
                "postgresql://soundspan:secret@db.example:5432/soundspan?sslmode=require",
        });

        const poolConfig = prismaPgCtor.mock.calls[0][0];
        expect(poolConfig.connectionString).toBe(
            "postgresql://soundspan:secret@db.example:5432/soundspan?sslmode=require",
        );
        expect(poolConfig.max).toBe(9);
        expect(poolConfig.connectionTimeoutMillis).toBe(15_000);
    });

    it("falls back to role=all defaults when entrypoint inference is unknown", () => {
        const { prismaPgCtor, logger } = loadDbModule({
            argv1: "/app/dist/custom-entry.js",
        });

        const poolConfig = prismaPgCtor.mock.calls[0][0];
        expect(poolConfig.max).toBe(12);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("role=all")
        );
    });

    it("does not smuggle pool sizing into the connection string", () => {
        const { prismaPgCtor } = loadDbModule({});

        const poolConfig = prismaPgCtor.mock.calls[0][0];
        expect(poolConfig.connectionString).toBe(
            "postgresql://soundspan:secret@db.example:5432/soundspan",
        );
        expect(poolConfig.connectionString).not.toContain("connection_limit");
        expect(poolConfig.connectionString).not.toContain("pool_timeout");
    });
});
