import * as fs from "fs";
import * as path from "path";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { invalidateVibeAnalysis } from "./vibeInvalidation";

const replacementLogger = logger.child("TrackReplacement");

type ReplacementTransaction = Pick<
    Prisma.TransactionClient,
    "album" | "track" | "trackEmbedding" | "transcodedFile"
>;

type TrackUpdateData = Prisma.TrackUpdateManyMutationInput;

function replacementResetData() {
    return {
        analysisStatus: "pending",
        analyzedAt: null,
        analysisError: null,
        analysisRetryCount: 0,
        analysisStartedAt: null,
        loudnessLufs: null,
        truePeakDb: null,
    } satisfies TrackUpdateData;
}

/** Clears cached album loudness for every affected album in one store. */
export async function clearAlbumLoudness(
    store: Pick<Prisma.TransactionClient, "album">,
    albumIds: readonly string[],
): Promise<void> {
    const uniqueAlbumIds = [...new Set(albumIds)];
    if (uniqueAlbumIds.length === 0) return;
    await store.album.updateMany({
        where: { id: { in: uniqueAlbumIds } },
        data: { albumLoudnessLufs: null, albumTruePeakDb: null },
    });
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
    const existingTrack = await transaction.track.findUnique({
        where: { id: trackId },
        select: { albumId: true },
    });
    if (existingTrack === null) {
        throw new Error("Track replacement requires an existing track");
    }
    const cachedFiles = await transaction.transcodedFile.findMany({
        where: { trackId },
        select: { cachePath: true },
    });
    const invalidatedAt = new Date();
    const updated = await invalidateVibeAnalysis(
        transaction,
        { id: trackId },
        invalidatedAt,
        { ...trackData, ...replacementResetData() },
    );
    if (updated !== 1) {
        throw new Error("Track replacement requires exactly one track");
    }
    await transaction.trackEmbedding.deleteMany({ where: { trackId } });
    await transaction.transcodedFile.deleteMany({ where: { trackId } });
    const replacedTrack = await transaction.track.findUnique({
        where: { id: trackId },
        select: { albumId: true },
    });
    if (replacedTrack === null) {
        throw new Error("Replaced track disappeared before album invalidation");
    }
    await clearAlbumLoudness(transaction, [
        existingTrack.albumId,
        replacedTrack.albumId,
    ]);
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

/** Deletes cached stream rows and files without resetting analysis state. */
export async function clearTrackTranscodeCache(trackId: string): Promise<void> {
    const cachedFiles = await prisma.transcodedFile.findMany({
        where: { trackId },
        select: { cachePath: true },
    });
    await prisma.transcodedFile.deleteMany({ where: { trackId } });
    await removeReplacementCacheFiles(
        cachedFiles.map((file) => file.cachePath),
    );
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
