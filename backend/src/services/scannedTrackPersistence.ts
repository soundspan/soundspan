import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { recomputeAlbumLoudness } from "./albumLoudness";
import { hasAudioReplacement, hasUnprovenAudioChange } from "./trackRebinding";
import {
    applyTrackReplacement,
    removeReplacementCacheFiles,
} from "./trackReplacement";

/** Prior audio identity needed to decide scanner loudness persistence. */
export interface ScanPersistenceContext {
    contentChangeDetected: boolean;
    storedAudioHash: string | null;
    computedAudioHash: string | null | undefined;
    previousAlbumId: string | null;
    previousDuration: number | null;
    revival: boolean;
}

function needsLoudnessRefresh(
    context: ScanPersistenceContext,
    nextAlbumId: string,
    nextDuration: number,
): boolean {
    return (
        context.revival ||
        (context.previousDuration !== null &&
            context.previousDuration !== nextDuration) ||
        (context.previousAlbumId !== null &&
            context.previousAlbumId !== nextAlbumId) ||
        (context.contentChangeDetected &&
            hasUnprovenAudioChange(
                context.storedAudioHash,
                context.computedAudioHash ?? null,
            ))
    );
}

/** Persists one scanned track with replacement and album-rollup decisions. */
export async function persistScannedTrack(
    trackUpsert: Prisma.TrackUpsertArgs,
    nextAlbumId: string,
    nextDuration: number,
    context: ScanPersistenceContext,
    clearHealthIssue: (trackId: string) => Promise<void>,
): Promise<void> {
    const replacement =
        context.contentChangeDetected &&
        hasAudioReplacement(
            context.storedAudioHash,
            context.computedAudioHash ?? null,
        );
    const unprovenChange =
        context.contentChangeDetected &&
        hasUnprovenAudioChange(
            context.storedAudioHash,
            context.computedAudioHash ?? null,
        );
    if (
        !replacement &&
        !needsLoudnessRefresh(context, nextAlbumId, nextDuration)
    ) {
        const track = await prisma.track.upsert(trackUpsert);
        await clearHealthIssue(track.id);
        return;
    }
    const cachePaths = await prisma.$transaction(async (transaction) => {
        const track = await transaction.track.upsert(trackUpsert);
        const paths = replacement
            ? await applyTrackReplacement(transaction, track.id)
            : [];
        if (unprovenChange) {
            await transaction.track.update({
                where: { id: track.id },
                data: { loudnessLufs: null, truePeakDb: null },
            });
        }
        await recomputeAlbumLoudness(transaction, [
            ...(context.previousAlbumId ? [context.previousAlbumId] : []),
            nextAlbumId,
        ]);
        await transaction.libraryHealthRecord.deleteMany({
            where: { trackId: track.id },
        });
        return paths;
    });
    await removeReplacementCacheFiles(cachePaths);
}
