import type { Prisma } from "@prisma/client";

interface VibeInvalidationStore {
    track: {
        updateMany(
            args: Prisma.TrackUpdateManyArgs,
        ): Promise<{ count: number }>;
    };
}

/** Atomically invalidates matching vibe work and advances its fencing token. */
export async function invalidateVibeAnalysis(
    store: VibeInvalidationStore,
    where: Prisma.TrackWhereInput,
    invalidatedAt: Date,
    additionalData: Prisma.TrackUpdateManyMutationInput = {},
): Promise<number> {
    const result = await store.track.updateMany({
        where,
        data: {
            ...additionalData,
            vibeAnalysisStatus: "pending",
            vibeAnalysisError: null,
            vibeAnalysisRetryCount: 0,
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: invalidatedAt,
            vibeAnalysisGeneration: { increment: 1 },
        },
    });
    if (!Number.isSafeInteger(result.count) || result.count < 0) {
        throw new Error("Vibe invalidation returned an invalid update count");
    }
    return result.count;
}
