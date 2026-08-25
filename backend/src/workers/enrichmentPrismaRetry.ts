import { Prisma, prisma } from "../utils/db";
import { toErrorMessage } from "../utils/errors";
import { logger } from "../utils/logger";

const log = logger.child("Enrichment");
const ENRICHMENT_PRISMA_RETRY_ATTEMPTS = 3;

function isRetryableEnrichmentPrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return ["P1001", "P1002", "P1017", "P2024", "P2037"].includes(
            error.code,
        );
    }
    if (error instanceof Prisma.PrismaClientRustPanicError) return true;
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        return (
            error.message.includes("Response from the Engine was empty") ||
            error.message.includes("Engine has already exited")
        );
    }

    const message = toErrorMessage(error);
    return (
        message.includes("Response from the Engine was empty") ||
        message.includes("Engine has already exited") ||
        message.includes("Can't reach database server") ||
        message.includes("Connection reset")
    );
}

function isTooManyConnectionsPrismaError(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2037"
    );
}

/** Retry bounded enrichment database reads after transient Prisma failures. */
export async function withEnrichmentPrismaRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (
                !isRetryableEnrichmentPrismaError(error) ||
                attempt === ENRICHMENT_PRISMA_RETRY_ATTEMPTS
            ) {
                throw error;
            }
            log.warn(
                `${operationName} failed (attempt ${attempt}/${ENRICHMENT_PRISMA_RETRY_ATTEMPTS}), retrying`,
                error,
            );
            const tooManyConnections = isTooManyConnectionsPrismaError(error);
            const delayMs = tooManyConnections ? 1000 * attempt : 250 * attempt;
            if (tooManyConnections) {
                await prisma.$disconnect().catch(() => {});
            }
            await prisma.$connect().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}
