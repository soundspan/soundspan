export type FrontendLogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type FrontendLogContext = Record<string, unknown>;

export interface FrontendLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    child: (scope: string) => FrontendLogger;
}

const LOG_LEVELS: Record<FrontendLogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

const DEFAULT_LEVEL: FrontendLogLevel =
    process.env.NODE_ENV === "production" ? "warn" : "info";

const resolveLogLevel = (): FrontendLogLevel => {
    const configured = process.env.NEXT_PUBLIC_LOG_LEVEL?.trim().toLowerCase();

    if (!configured) {
        return DEFAULT_LEVEL;
    }

    if (configured in LOG_LEVELS) {
        return configured as FrontendLogLevel;
    }

    return "silent";
};

const currentLevel = resolveLogLevel();

function shouldLog(level: FrontendLogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function isContextCandidate(value: unknown): value is FrontendLogContext {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof Error)
    );
}

function normalizeError(error: unknown): unknown {
    if (!(error instanceof Error)) {
        return error;
    }

    return {
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
}

function normalizeContext(context: FrontendLogContext): FrontendLogContext {
    const output: FrontendLogContext = {};
    for (const [key, value] of Object.entries(context)) {
        output[key] = normalizeError(value);
    }
    return output;
}

function splitArgs(args: unknown[]): {
    context: FrontendLogContext | null;
    passthrough: unknown[];
} {
    if (args.length === 0) {
        return { context: null, passthrough: [] };
    }

    const [first, ...rest] = args;
    if (!isContextCandidate(first)) {
        return {
            context: null,
            passthrough: args.map(normalizeError),
        };
    }

    return {
        context: normalizeContext(first),
        passthrough: rest.map(normalizeError),
    };
}

function emit(
    level: Exclude<FrontendLogLevel, "silent">,
    scope: string | null,
    message: string,
    args: unknown[],
): void {
    if (!shouldLog(level)) {
        return;
    }

    const prefix = scope
        ? `[${level.toUpperCase()}] [${scope}] ${message}`
        : `[${level.toUpperCase()}] ${message}`;
    const { context, passthrough } = splitArgs(args);

    const method = level === "debug"
        ? console.debug
        : level === "info"
            ? console.info
            : level === "warn"
                ? console.warn
                : console.error;

    if (context) {
        method(prefix, context, ...passthrough);
        return;
    }

    method(prefix, ...passthrough);
}

export function createFrontendLogger(scope?: string): FrontendLogger {
    const scoped = scope?.trim() || null;

    return {
        debug: (message: string, ...args: unknown[]) =>
            emit("debug", scoped, message, args),
        info: (message: string, ...args: unknown[]) =>
            emit("info", scoped, message, args),
        warn: (message: string, ...args: unknown[]) =>
            emit("warn", scoped, message, args),
        error: (message: string, ...args: unknown[]) =>
            emit("error", scoped, message, args),
        child: (childScope: string) => {
            const trimmed = childScope.trim();
            const nextScope = scoped ? `${scoped}.${trimmed}` : trimmed;
            return createFrontendLogger(nextScope);
        },
    };
}

export async function withFrontendLogTiming<T>(
    logger: FrontendLogger,
    operation: string,
    run: () => Promise<T> | T,
    context: FrontendLogContext = {},
): Promise<T> {
    const startedAt = Date.now();
    logger.debug(`${operation} started`, context);

    try {
        const result = await run();
        logger.debug(`${operation} completed`, {
            ...context,
            durationMs: Date.now() - startedAt,
        });
        return result;
    } catch (error) {
        logger.error(`${operation} failed`, {
            ...context,
            durationMs: Date.now() - startedAt,
            error,
        });
        throw error;
    }
}

export const frontendLogger = createFrontendLogger("frontend");
