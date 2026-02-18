describe("db connection pool config", () => {
    const originalEnv = process.env;
    const originalArgv = process.argv;

    afterEach(() => {
        process.env = originalEnv;
        process.argv = originalArgv;
        jest.resetModules();
        jest.clearAllMocks();
        jest.unmock("@prisma/client");
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
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
        };

        jest.doMock("@prisma/client", () => ({
            PrismaClient: prismaClientCtor,
            Prisma: {},
        }));
        jest.doMock("../logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const dbModule = require("../db");

        return {
            dbModule,
            prismaClientCtor,
            logger,
        };
    }

    it("uses worker-default pool when role is inferred from worker entrypoint", () => {
        const { prismaClientCtor, logger } = loadDbModule({
            argv1: "/app/dist/worker.js",
        });

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        const resolvedUrl: string = prismaOptions.datasources.db.url;

        expect(resolvedUrl).toContain("connection_limit=2");
        expect(resolvedUrl).toContain("pool_timeout=30");
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("role=worker"),
        );
    });

    it("warns on invalid role and infers api defaults from api entrypoint", () => {
        const { prismaClientCtor, logger } = loadDbModule({
            role: "bogus",
            argv1: "/app/dist/index.js",
        });

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        const resolvedUrl: string = prismaOptions.datasources.db.url;

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Invalid BACKEND_PROCESS_ROLE"),
        );
        expect(resolvedUrl).toContain("connection_limit=4");
        expect(resolvedUrl).toContain("pool_timeout=30");
    });

    it("respects explicit pool overrides and preserves existing query params", () => {
        const { prismaClientCtor } = loadDbModule({
            role: "worker",
            poolSize: "9",
            poolTimeout: "15",
            databaseUrl:
                "postgresql://soundspan:secret@db.example:5432/soundspan?sslmode=require",
        });

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        const resolvedUrl: string = prismaOptions.datasources.db.url;

        expect(resolvedUrl).toContain("sslmode=require");
        expect(resolvedUrl).toContain("connection_limit=9");
        expect(resolvedUrl).toContain("pool_timeout=15");
    });

    it("falls back to role=all defaults when entrypoint inference is unknown", () => {
        const { prismaClientCtor, logger } = loadDbModule({
            argv1: "/app/dist/custom-entry.js",
        });

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        const resolvedUrl: string = prismaOptions.datasources.db.url;

        expect(resolvedUrl).toContain("connection_limit=6");
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("role=all")
        );
    });

    it("appends pool params to non-URL DATABASE_URL values via fallback path", () => {
        const { prismaClientCtor } = loadDbModule({
            databaseUrl: "not-a-valid-url?foo=bar",
        });

        const prismaOptions = prismaClientCtor.mock.calls[0][0];
        const resolvedUrl: string = prismaOptions.datasources.db.url;

        expect(resolvedUrl).toBe(
            "not-a-valid-url?foo=bar&connection_limit=4&pool_timeout=30"
        );
    });
});
