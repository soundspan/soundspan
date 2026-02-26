export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogContext = Record<string, unknown>;

export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    child: (scope: string) => Logger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

const DEFAULT_LOG_LEVEL: LogLevel =
    process.env.NODE_ENV === "production" ? "warn" : "debug";

const resolveLogLevel = (): LogLevel => {
    const configured = process.env.LOG_LEVEL?.trim().toLowerCase();

    if (!configured) {
        return DEFAULT_LOG_LEVEL;
    }

    if (configured in LOG_LEVELS) {
        return configured as LogLevel;
    }

    return "silent";
};

const currentLevel = resolveLogLevel();

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function isLogContextCandidate(value: unknown): value is LogContext {
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

function normalizeContext(context: LogContext): LogContext {
    const output: LogContext = {};
    for (const [key, value] of Object.entries(context)) {
        output[key] = normalizeError(value);
    }
    return output;
}

function splitArgs(args: unknown[]): {
    context: LogContext | null;
    passthrough: unknown[];
} {
    if (args.length === 0) {
        return { context: null, passthrough: [] };
    }

    const [first, ...rest] = args;
    if (!isLogContextCandidate(first)) {
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
    level: Exclude<LogLevel, "silent">,
    message: string,
    scope: string | null,
    args: unknown[],
): void {
    if (!shouldLog(level)) {
        return;
    }

    const { context, passthrough } = splitArgs(args);
    const prefix = scope
        ? `[${level.toUpperCase()}] [${scope}] ${message}`
        : `[${level.toUpperCase()}] ${message}`;

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

export function createLogger(scope?: string): Logger {
    const scoped = scope?.trim() || null;

    return {
        debug: (message: string, ...args: unknown[]) =>
            emit("debug", message, scoped, args),
        info: (message: string, ...args: unknown[]) =>
            emit("info", message, scoped, args),
        warn: (message: string, ...args: unknown[]) =>
            emit("warn", message, scoped, args),
        error: (message: string, ...args: unknown[]) =>
            emit("error", message, scoped, args),
        child: (childScope: string) => {
            const trimmed = childScope.trim();
            const nextScope = scoped ? `${scoped}.${trimmed}` : trimmed;
            return createLogger(nextScope);
        },
    };
}

export async function withLogTiming<T>(
    loggerInstance: Logger,
    operation: string,
    run: () => Promise<T> | T,
    context: LogContext = {},
): Promise<T> {
    const startedAt = Date.now();
    loggerInstance.debug(`${operation} started`, context);

    try {
        const result = await run();
        loggerInstance.debug(`${operation} completed`, {
            ...context,
            durationMs: Date.now() - startedAt,
        });
        return result;
    } catch (error) {
        loggerInstance.error(`${operation} failed`, {
            ...context,
            durationMs: Date.now() - startedAt,
            error,
        });
        throw error;
    }
}

export function logErrorWithContext(
    loggerInstance: Logger,
    message: string,
    error: unknown,
    context: LogContext = {},
): void {
    loggerInstance.error(message, {
        ...context,
        error,
    });
}

export const logger = createLogger();
