import * as fs from "fs";
import * as path from "path";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const replacementLogger = logger.child("TrackReplacement");

type ReplacementTransaction = Pick<
    Prisma.TransactionClient,
    "track" | "trackEmbedding" | "transcodedFile"
>;

type TrackUpdateData = Prisma.TrackUpdateArgs["data"];

function replacementResetData(now: Date) {
    return {
        analysisStatus: "pending",
        analyzedAt: null,
        analysisError: null,
        analysisRetryCount: 0,
        analysisStartedAt: null,
        vibeAnalysisStatus: "pending",
        vibeAnalysisError: null,
        vibeAnalysisRetryCount: 0,
        vibeAnalysisStartedAt: null,
        vibeAnalysisStatusUpdatedAt: now,
    } satisfies TrackUpdateData;
}

/**
 * Resets derived analysis state and removes database-backed artifacts inside
 * the caller's transaction. The returned relative cache paths are removed
 * from disk only after the transaction commits.
 */
export async function applyTrackReplacement(
    transaction: ReplacementTransaction,
    trackId: string,
    trackData: TrackUpdateData = {},
): Promise<string[]> {
    const cachedFiles = await transaction.transcodedFile.findMany({
        where: { trackId },
        select: { cachePath: true },
    });
    await transaction.track.update({
        where: { id: trackId },
        data: { ...trackData, ...replacementResetData(new Date()) },
    });
    await transaction.trackEmbedding.deleteMany({ where: { trackId } });
    await transaction.transcodedFile.deleteMany({ where: { trackId } });
    return cachedFiles.map((file) => file.cachePath);
}

/** Removes committed replacement cache artifacts using the streaming cache root. */
export async function removeReplacementCacheFiles(
    cachePaths: readonly string[],
): Promise<void> {
    for (const cachePath of cachePaths) {
        const absolutePath = path.join(
            config.music.transcodeCachePath,
            cachePath,
        );
        try {
            await fs.promises.unlink(absolutePath);
        } catch (error: unknown) {
            replacementLogger.warn(
                `Failed to delete replacement transcode ${absolutePath}:`,
                error,
            );
        }
    }
}

/** Applies replacement semantics to a same-path track update. */
export async function resetTrackAfterReplacement(
    trackId: string,
): Promise<void> {
    const cachePaths = await prisma.$transaction((transaction) =>
        applyTrackReplacement(transaction, trackId),
    );
    await removeReplacementCacheFiles(cachePaths);
}
