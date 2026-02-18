import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "./logger";

type BackendProcessRole = "api" | "worker" | "all";

function inferBackendProcessRole(): {
    role: BackendProcessRole;
    source: string;
} {
    const configuredRole = (process.env.BACKEND_PROCESS_ROLE || "")
        .trim()
        .toLowerCase();
    if (
        configuredRole === "api" ||
        configuredRole === "worker" ||
        configuredRole === "all"
    ) {
        return { role: configuredRole, source: "env" };
    }

    if (configuredRole) {
        logger.warn(
            `[Startup] Invalid BACKEND_PROCESS_ROLE="${process.env.BACKEND_PROCESS_ROLE}", inferring role from entrypoint`,
        );
    }

    const entrypoint = (process.argv[1] || "").toLowerCase();
    if (
        entrypoint.endsWith("worker.js") ||
        entrypoint.endsWith("worker.ts") ||
        entrypoint.endsWith("/worker.js") ||
        entrypoint.endsWith("/worker.ts")
    ) {
        return { role: "worker", source: "role-inferred(entrypoint-worker)" };
    }
    if (
        entrypoint.endsWith("index.js") ||
        entrypoint.endsWith("index.ts") ||
        entrypoint.endsWith("/index.js") ||
        entrypoint.endsWith("/index.ts")
    ) {
        return { role: "api", source: "role-inferred(entrypoint-api)" };
    }

    return { role: "all", source: "role-inferred(default-all)" };
}

const backendProcessRoleResolution = inferBackendProcessRole();
const backendProcessRole = backendProcessRoleResolution.role;
const defaultConnectionLimitByRole: Record<string, number> = {
    api: 4,
    worker: 2,
    all: 6,
};

// Role-aware defaults keep aggregate DB connection pressure predictable in HA
// while preserving explicit operator overrides through DATABASE_POOL_SIZE.
const defaultConnectionLimit =
    defaultConnectionLimitByRole[backendProcessRole] ??
    defaultConnectionLimitByRole.all;
const parsedLimit = parseInt(
    process.env.DATABASE_POOL_SIZE || `${defaultConnectionLimit}`,
    10
);
const parsedTimeout = parseInt(process.env.DATABASE_POOL_TIMEOUT || "30", 10);
const connectionLimit = Number.isNaN(parsedLimit) ?
        defaultConnectionLimit
    :   Math.max(1, parsedLimit);
const poolTimeout = Number.isNaN(parsedTimeout) ? 30 : parsedTimeout;
const poolConfigSource =
    process.env.DATABASE_POOL_SIZE ?
        "env"
    :   `${backendProcessRoleResolution.source}:role-default(${backendProcessRole})`;

function resolveDatabaseUrlWithPoolConfig(databaseUrl: string): string {
    const poolParams = `connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`;
    try {
        const parsed = new URL(databaseUrl);
        parsed.searchParams.set("connection_limit", String(connectionLimit));
        parsed.searchParams.set("pool_timeout", String(poolTimeout));
        return parsed.toString();
    } catch {
        return `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}${poolParams}`;
    }
}

export const prisma = new PrismaClient({
    log:
        (
            process.env.NODE_ENV === "development" &&
            process.env.LOG_QUERIES === "true"
        ) ?
            ["query", "error", "warn"]
        :   ["error", "warn"],
    datasources: {
        db: {
            url:
                process.env.DATABASE_URL ?
                    resolveDatabaseUrlWithPoolConfig(process.env.DATABASE_URL)
                :   undefined,
        },
    },
});

// Log pool configuration on startup
logger.info(
    `Database connection pool configured: role=${backendProcessRole}, source=${poolConfigSource}, limit=${connectionLimit}, timeout=${poolTimeout}s`,
);

export { Prisma };
