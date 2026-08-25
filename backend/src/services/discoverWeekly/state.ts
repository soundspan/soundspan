import { prisma } from "../../utils/db";
import {
    isRetryablePrismaError,
    withPrismaRetry,
} from "../../utils/prismaRetry";

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
export const isRetryableDiscoverWeeklyPrismaError = isRetryablePrismaError;

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
                    withPrismaRetry(`${namespace}.${property}`, () =>
                        value.apply(target, args),
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
                                withPrismaRetry(
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
