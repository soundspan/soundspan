import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";

const DISCOVER_WEEKLY_PRISMA_RETRY_ATTEMPTS = 3;
const discoverWeeklyBasePrisma = prisma;

/** Capture the persisted file identity for a discovery track. */
export function discoveryTrackFileSnapshot(track: {
    title: string;
    filePath: string | null;
}): { fileName: string; filePath: string } {
    const filePath = track.filePath ?? "";
    return {
        fileName: filePath.split("/").pop() || track.title || "",
        filePath,
    };
}

/** Return whether a Prisma failure is transient for discovery work. */
export function isRetryableDiscoverWeeklyPrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return ["P1001", "P1002", "P1017", "P2024", "P2037"].includes(
            error.code,
        );
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
        return true;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        const message = error.message || "";
        return (
            message.includes("Response from the Engine was empty") ||
            message.includes("Engine has already exited")
        );
    }

    const message =
        error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Response from the Engine was empty") ||
        message.includes("Engine has already exited") ||
        message.includes("Can't reach database server") ||
        message.includes("Connection reset")
    );
}

async function withDiscoverWeeklyPrismaRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (
                !isRetryableDiscoverWeeklyPrismaError(error) ||
                attempt === DISCOVER_WEEKLY_PRISMA_RETRY_ATTEMPTS
            ) {
                throw error;
            }

            logger.warn(
                `[DiscoverWeekly/Prisma] ${operationName} failed (attempt ${attempt}/${DISCOVER_WEEKLY_PRISMA_RETRY_ATTEMPTS}), retrying`,
                error,
            );
            await discoverWeeklyBasePrisma.$connect().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
}

/** Wrap Prisma client operations with the Discover Weekly retry policy. */
export function createPrismaRetryProxy<T extends object>(
    client: T,
    namespace: string,
): T {
    return new Proxy(client, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);

            if (typeof value === "function" && typeof property === "string") {
                return (...args: unknown[]) =>
                    withDiscoverWeeklyPrismaRetry(
                        `${namespace}.${property}`,
                        () => value.apply(target, args),
                    );
            }

            if (
                value &&
                typeof value === "object" &&
                typeof property === "string"
            ) {
                return new Proxy(value as object, {
                    get(modelTarget, modelProperty, modelReceiver) {
                        const modelValue = Reflect.get(
                            modelTarget,
                            modelProperty,
                            modelReceiver,
                        );

                        if (
                            typeof modelValue === "function" &&
                            typeof modelProperty === "string"
                        ) {
                            return (...args: unknown[]) =>
                                withDiscoverWeeklyPrismaRetry(
                                    `${namespace}.${property}.${modelProperty}`,
                                    () => modelValue.apply(modelTarget, args),
                                );
                        }

                        return modelValue;
                    },
                });
            }

            return value;
        },
    }) as T;
}

/** Shared retrying Prisma client for all Discover Weekly modules. */
export const discoverWeeklyPrisma = createPrismaRetryProxy(
    discoverWeeklyBasePrisma,
    "discoverWeekly",
);
