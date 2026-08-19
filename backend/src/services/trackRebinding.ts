import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import type { TrackIdentity, TrackIdentityMatch } from "./trackIdentityMatcher";
import {
    applyTrackReplacement,
    removeReplacementCacheFiles,
} from "./trackReplacement";
import { recomputeAlbumLoudness } from "./albumLoudness";

const log = logger.child("MusicScannerService");

interface RebindTrack extends TrackIdentity {
    fileModified: Date;
    mime: string | null;
    albumId: string;
    audioHashedAt: Date | null;
}

/** Report whether two available content hashes identify a track replacement. */
export function hasAudioReplacement(
    storedHash: string | null,
    nextHash: string | null,
): boolean {
    return storedHash !== null && nextHash !== null && storedHash !== nextHash;
}

/** Report whether a detected change lacks equal, non-null content hashes. */
export function hasUnprovenAudioChange(
    storedHash: string | null,
    nextHash: string | null,
): boolean {
    return storedHash === null || nextHash === null;
}

function buildRebindData(
    candidate: RebindTrack,
    missing: RebindTrack,
): Prisma.TrackUpdateArgs["data"] {
    const hashData =
        candidate.audioHash === null && missing.audioHash !== null
            ? {}
            : {
                  audioHash: candidate.audioHash,
                  audioHashedAt: candidate.audioHashedAt,
              };
    return {
        filePath: candidate.filePath,
        fileModified: candidate.fileModified,
        fileSize: candidate.fileSize,
        mime: candidate.mime,
        albumId: candidate.albumId,
        title: candidate.title,
        trackNo: candidate.trackNo,
        discNo: candidate.discNo,
        duration: candidate.duration,
        recordingMbid: candidate.recordingMbid,
        isrc: candidate.isrc,
        ...hashData,
        removedAt: null,
    };
}

async function commitRebind(
    match: TrackIdentityMatch<RebindTrack, RebindTrack>,
    replacement: boolean,
    unprovenChange: boolean,
): Promise<string[]> {
    return prisma.$transaction(async (transaction) => {
        await transaction.track.delete({ where: { id: match.candidate.id } });
        const trackData = buildRebindData(match.candidate, match.missing);
        const cachePaths = replacement
            ? await applyTrackReplacement(
                  transaction,
                  match.missing.id,
                  trackData,
              )
            : [];
        if (!replacement) {
            await transaction.track.update({
                where: { id: match.missing.id },
                data: {
                    ...trackData,
                    ...(unprovenChange
                        ? { loudnessLufs: null, truePeakDb: null }
                        : {}),
                },
            });
            await recomputeAlbumLoudness(transaction, [
                match.missing.albumId,
                match.candidate.albumId,
            ]);
        }
        await transaction.libraryHealthRecord.deleteMany({
            where: { trackId: match.missing.id },
        });
        return cachePaths;
    });
}

/** Rebind one moved or revived track and invalidate every affected derived value. */
export async function rebindMovedTrack(
    match: TrackIdentityMatch<RebindTrack, RebindTrack>,
    revival: boolean,
): Promise<void> {
    const replacement = hasAudioReplacement(
        match.missing.audioHash,
        match.candidate.audioHash,
    );
    const unprovenChange = hasUnprovenAudioChange(
        match.missing.audioHash,
        match.candidate.audioHash,
    );
    const cachePaths = await commitRebind(match, replacement, unprovenChange);
    await removeReplacementCacheFiles(cachePaths);
    const action = revival ? "Revived" : "Re-bound";
    log.info(
        `${action} track ${match.missing.filePath} → ${match.candidate.filePath}`,
    );
}
