import { Prisma } from "@prisma/client";

const MAX_ALBUMS_PER_RECOMPUTE = 10_000;

type AlbumLoudnessTransaction = Pick<
    Prisma.TransactionClient,
    "$executeRaw" | "$queryRaw"
>;

function uniqueSortedAlbumIds(albumIds: readonly string[]): string[] {
    const uniqueIds = [...new Set(albumIds)].sort();
    if (uniqueIds.length > MAX_ALBUMS_PER_RECOMPUTE) {
        throw new Error(
            "Album loudness recompute exceeds the bounded batch size",
        );
    }
    return uniqueIds;
}

async function lockAlbum(
    transaction: AlbumLoudnessTransaction,
    albumId: string,
): Promise<void> {
    // Cross-language lock contract: PostgreSQL hashtextextended(album id, 0)
    // is also used by services/audio-analyzer/loudness.py.
    // pg_advisory_xact_lock returns void, which $queryRaw cannot
    // deserialize — the repo's advisory locks always go through $executeRaw.
    await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${albumId}, 0))
    `;
}

async function updateAlbumAggregate(
    transaction: AlbumLoudnessTransaction,
    albumId: string,
): Promise<void> {
    await transaction.$executeRaw`
        UPDATE "Album" AS album
        SET "albumLoudnessLufs" = aggregate."albumLoudnessLufs",
            "albumTruePeakDb" = aggregate."albumTruePeakDb"
        FROM (
            SELECT
                10.0 * LOG(
                    SUM(track.duration * POWER(10.0, track."loudnessLufs" / 10.0))
                    / NULLIF(SUM(track.duration), 0)
                ) AS "albumLoudnessLufs",
                MAX(track."truePeakDb") AS "albumTruePeakDb"
            FROM "Track" AS track
            WHERE track."albumId" = ${albumId}
              AND track."removedAt" IS NULL
              AND track."loudnessLufs" IS NOT NULL
              AND track.duration > 0
        ) AS aggregate
        WHERE album.id = ${albumId}
    `;
}

/** Recomputes weighted loudness for active measured siblings under stable locks. */
export async function recomputeAlbumLoudness(
    transaction: AlbumLoudnessTransaction,
    albumIds: readonly string[],
): Promise<void> {
    const uniqueIds = uniqueSortedAlbumIds(albumIds);
    for (const albumId of uniqueIds) {
        await lockAlbum(transaction, albumId);
    }
    for (const albumId of uniqueIds) {
        await updateAlbumAggregate(transaction, albumId);
    }
}
