import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { toErrorMessage } from "./errors";
import { logger } from "./logger";

const log =
    typeof logger.child === "function" ? logger.child("PrismaRetry") : logger;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 250;
const RETRYABLE_CODES = new Set(["P1001", "P1002", "P1017", "P2024", "P2037"]);

/** Per-call adjustments for the shared bounded Prisma retry policy. */
export interface PrismaRetryOptions {
    attempts?: number;
    baseDelayMs?: number;
    labelPrefix?: string;
    disconnectOnP2037?: boolean;
    p2037DelayMs?: number;
}

/** Return whether a Prisma failure is transient and safe to retry. */
export function isRetryablePrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return RETRYABLE_CODES.has(error.code);
    }
    if (error instanceof Prisma.PrismaClientRustPanicError) return true;
    const message = toErrorMessage(error);
    return (
        message.includes("Response from the Engine was empty") ||
        message.includes("Engine has already exited") ||
        message.includes("Can't reach database server") ||
        message.includes("Connection reset")
    );
}

function isP2037(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2037"
    );
}

function retryDelayMs(
    error: unknown,
    attempt: number,
    options: PrismaRetryOptions,
): number {
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_DELAY_MS;
    const selectedDelay =
        isP2037(error) && options.p2037DelayMs !== undefined
            ? options.p2037DelayMs
            : baseDelayMs;
    return selectedDelay * attempt;
}

async function reconnectForRetry(
    error: unknown,
    options: PrismaRetryOptions,
): Promise<void> {
    if (isP2037(error) && options.disconnectOnP2037) {
        await prisma.$disconnect().catch(() => {});
    }
    await prisma.$connect().catch(() => {});
}

/** Run one Prisma operation with bounded transient-error retries. */
export async function withPrismaRetry<T>(
    label: string,
    operation: () => Promise<T>,
    options: PrismaRetryOptions = {},
): Promise<T> {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!isRetryablePrismaError(error) || attempt === attempts) {
                throw error;
            }
            const prefix = options.labelPrefix ? `${options.labelPrefix} ` : "";
            log.warn(
                `${prefix}${label} failed (attempt ${attempt}/${attempts}), retrying`,
                error,
            );
            await reconnectForRetry(error, options);
            await new Promise((resolve) =>
                setTimeout(resolve, retryDelayMs(error, attempt, options)),
            );
        }
    }
    throw new Error(`${label} retry attempts exhausted`);
}
