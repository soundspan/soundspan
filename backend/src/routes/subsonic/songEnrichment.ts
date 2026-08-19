import { prisma } from "../../utils/db";

/** Authenticated-user fields added to a Subsonic song response. */
export type SongEnrichment = {
    playedAt?: Date;
    starredAt?: Date;
    userRating?: number;
    playCount?: number;
};

function uniqueTrackIds(trackIds: Array<string | null | undefined>): string[] {
    return Array.from(
        new Set(
            trackIds.filter(
                (trackId): trackId is string =>
                    typeof trackId === "string" && trackId.length > 0,
            ),
        ),
    );
}

function mergeEnrichment(
    target: Map<string, SongEnrichment>,
    trackId: string,
    value: SongEnrichment,
): void {
    target.set(trackId, { ...target.get(trackId), ...value });
}

/** Load every authenticated-user song field in one bounded query per store. */
export async function loadSongEnrichmentByTrackId(
    userId: string,
    trackIds: Array<string | null | undefined>,
    preloadedStarredAtByTrackId?: ReadonlyMap<string, Date>,
    preloadedPlayByTrackId?: ReadonlyMap<string, SongEnrichment>,
): Promise<Map<string, SongEnrichment>> {
    const ids = uniqueTrackIds(trackIds);
    if (ids.length === 0) return new Map();
    const [plays, likedTracks, ratings] = await Promise.all([
        preloadedPlayByTrackId
            ? Promise.resolve([])
            : prisma.play.groupBy({
                  by: ["trackId"],
                  where: { userId, trackId: { in: ids } },
                  _count: { _all: true },
                  _max: { playedAt: true },
              }),
        preloadedStarredAtByTrackId
            ? Promise.resolve(
                  Array.from(
                      preloadedStarredAtByTrackId,
                      ([trackId, likedAt]) => ({ trackId, likedAt }),
                  ),
              )
            : prisma.likedTrack.findMany({
                  where: { userId, trackId: { in: ids } },
                  select: { trackId: true, likedAt: true },
              }),
        prisma.trackRating.findMany({
            where: { userId, trackId: { in: ids } },
            select: { trackId: true, rating: true },
        }),
    ]);
    const result = new Map<string, SongEnrichment>();
    for (const [trackId, value] of preloadedPlayByTrackId ?? []) {
        mergeEnrichment(result, trackId, value);
    }
    for (const play of plays) {
        if (!play.trackId) continue;
        mergeEnrichment(result, play.trackId, {
            playedAt: play._max?.playedAt ?? undefined,
            playCount: play._count?._all || undefined,
        });
    }
    for (const likedTrack of likedTracks) {
        mergeEnrichment(result, likedTrack.trackId, {
            starredAt: likedTrack.likedAt,
        });
    }
    for (const rating of ratings) {
        mergeEnrichment(result, rating.trackId, { userRating: rating.rating });
    }
    return result;
}

/** Persist or clear one authenticated user's numeric song rating. */
export async function setSongUserRating(
    userId: string,
    trackId: string,
    rating: number,
): Promise<void> {
    if (rating === 0) {
        await prisma.trackRating.deleteMany({ where: { userId, trackId } });
        return;
    }
    await prisma.trackRating.upsert({
        where: { userId_trackId: { userId, trackId } },
        create: { userId, trackId, rating },
        update: { rating },
    });
}

/** Project per-song fields onto an album without fabricating missing values. */
export function combineSongEnrichmentForAlbum(
    trackIds: string[],
    enrichmentByTrackId: ReadonlyMap<string, SongEnrichment>,
): SongEnrichment {
    let playedAt: Date | undefined;
    let starredAt: Date | undefined;
    let playCount = 0;
    for (const trackId of trackIds) {
        const value = enrichmentByTrackId.get(trackId);
        if (!value) continue;
        if (value.playedAt && (!playedAt || value.playedAt > playedAt)) {
            playedAt = value.playedAt;
        }
        if (value.starredAt && (!starredAt || value.starredAt > starredAt)) {
            starredAt = value.starredAt;
        }
        playCount += value.playCount ?? 0;
    }
    return { playedAt, starredAt, playCount: playCount || undefined };
}
