/**
 * RemoteTrackMetadataRefreshService — Re-fetches metadata for remote provider rows
 * that still have placeholder values ("Unknown", empty strings) from before the
 * metadata preservation fix.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { tidalStreamingService } from "./tidalStreaming";
import { ytMusicService } from "./youtubeMusic";

const log = logger.child("RemoteTrackMetadataRefresh");

const DEFAULT_BATCH_SIZE = 100;
const TITLE_PLACEHOLDERS = ["Unknown", "unknown", "", "Unknown Track", "unknown track"];
const ARTIST_PLACEHOLDERS = ["Unknown", "unknown", "", "Unknown Artist", "unknown artist"];
const ALBUM_PLACEHOLDERS = ["Unknown", "unknown", "", "Unknown Album", "unknown album", "Single", "single"];
const REAL_VALUE_PLACEHOLDERS = new Set(["unknown", "", "single", "unknown album", "unknown artist", "unknown track"]);

/**
 * Returns true if the value is a real (non-placeholder) string.
 */
function isRealValue(value: string | undefined | null): value is string {
    if (!value) return false;
    return !REAL_VALUE_PLACEHOLDERS.has(value.toLowerCase().trim());
}

function buildTidalPlaceholderWhere(): object[] {
    return [
        { title: { in: TITLE_PLACEHOLDERS } },
        { artist: { in: ARTIST_PLACEHOLDERS } },
        { album: { in: ALBUM_PLACEHOLDERS } },
    ];
}

function buildYtPlaceholderWhere(): object[] {
    return [
        { title: { in: TITLE_PLACEHOLDERS } },
        { artist: { in: ARTIST_PLACEHOLDERS } },
        { album: { in: ALBUM_PLACEHOLDERS } },
    ];
}

function dedupeUserIds(userIds: Array<string | null | undefined>): string[] {
    return Array.from(
        new Set(
            userIds.filter(
                (userId): userId is string =>
                    typeof userId === "string" && userId.trim().length > 0
            )
        )
    );
}

class RemoteTrackMetadataRefreshService {
    /**
     * Find remote provider rows with placeholder metadata and re-fetch from provider APIs.
     */
    async refreshUnknownMetadata(
        batchSize: number = DEFAULT_BATCH_SIZE
    ): Promise<{ updated: number; failed: number }> {
        const unknownTidal = await prisma.trackTidal.findMany({
            where: {
                OR: buildTidalPlaceholderWhere(),
            },
            select: {
                id: true,
                tidalId: true,
                likedBy: { select: { userId: true } },
            },
            take: batchSize,
        });

        const unknownYt = await prisma.trackYtMusic.findMany({
            where: {
                OR: buildYtPlaceholderWhere(),
            },
            select: { id: true, videoId: true },
            take: batchSize,
        });

        if (unknownTidal.length === 0 && unknownYt.length === 0) {
            return { updated: 0, failed: 0 };
        }

        log.info(
            `Found ${unknownTidal.length} Tidal and ${unknownYt.length} YT Music rows with placeholder metadata`
        );

        let updated = 0;
        let failed = 0;

        // Refresh Tidal rows
        if (unknownTidal.length > 0) {
            const tidalUsers = await prisma.userSettings.findMany({
                where: { tidalOAuthJson: { not: null } },
                select: { userId: true },
            });
            const tidalUserIds = dedupeUserIds(
                tidalUsers.map((user) => user.userId)
            );
            const tidalUserIdSet = new Set(tidalUserIds);
            let preferredTidalUserId: string | null = null;

            if (tidalUserIds.length > 0) {
                for (const row of unknownTidal) {
                    try {
                        const candidateUserIds = dedupeUserIds([
                            preferredTidalUserId,
                            ...row.likedBy
                                .map((likedBy) => likedBy.userId)
                                .filter((userId) => tidalUserIdSet.has(userId)),
                            ...tidalUserIds,
                        ]);

                        let detail = null;
                        let successfulUserId: string | null = null;

                        for (const candidateUserId of candidateUserIds) {
                            try {
                                detail = await tidalStreamingService.getTrack(
                                    candidateUserId,
                                    row.tidalId
                                );
                            } catch (err) {
                                log.warn(
                                    `Failed to refresh TrackTidal id=${row.id} with user ${candidateUserId}`,
                                    err
                                );
                                continue;
                            }

                            if (detail) {
                                successfulUserId = candidateUserId;
                                break;
                            }
                        }

                        const updateData: Record<string, string | number> = {};
                        if (isRealValue(detail?.title)) updateData.title = detail.title;
                        if (isRealValue(detail?.artist)) updateData.artist = detail.artist;
                        if (isRealValue(detail?.album?.title)) updateData.album = detail.album.title;
                        if (detail?.duration && detail.duration > 0) updateData.duration = detail.duration;

                        if (Object.keys(updateData).length > 0) {
                            await prisma.trackTidal.update({
                                where: { id: row.id },
                                data: updateData,
                            });
                            preferredTidalUserId = successfulUserId;
                            log.debug(`Refreshed TrackTidal id=${row.id}: updated fields [${Object.keys(updateData).join(", ")}]`);
                            updated++;
                        } else {
                            log.warn(
                                `TrackTidal id=${row.id}: no candidate Tidal credentials returned real metadata`
                            );
                            failed++;
                        }
                    } catch (err) {
                        log.warn(`Failed to refresh TrackTidal id=${row.id}`, err);
                        failed++;
                    }
                }
            } else {
                log.warn(
                    `No authenticated Tidal user found — skipping ${unknownTidal.length} rows with placeholder metadata`
                );
                failed += unknownTidal.length;
            }
        }

        // Refresh YT Music rows
        if (unknownYt.length > 0) {
            log.debug(
                `Refreshing ${unknownYt.length} YT Music rows via __public__ metadata lookup`
            );
            for (const row of unknownYt) {
                try {
                    const song = await ytMusicService.getSong(
                        "__public__",
                        row.videoId
                    );
                    const ytUpdateData: Record<string, string | number> = {};
                    if (isRealValue(song?.title)) ytUpdateData.title = song.title;
                    if (isRealValue(song?.artist)) ytUpdateData.artist = song.artist;
                    if (isRealValue(song?.album)) ytUpdateData.album = song.album;
                    if (song?.duration && song.duration > 0) ytUpdateData.duration = song.duration;

                    if (Object.keys(ytUpdateData).length > 0) {
                        await prisma.trackYtMusic.update({
                            where: { id: row.id },
                            data: ytUpdateData,
                        });
                        log.debug(`Refreshed TrackYtMusic id=${row.id}: updated fields [${Object.keys(ytUpdateData).join(", ")}]`);
                        updated++;
                    } else {
                        log.debug(`TrackYtMusic id=${row.id}: API returned no real metadata`);
                        failed++;
                    }
                } catch (err) {
                    log.warn(`Failed to refresh TrackYtMusic id=${row.id}`, err);
                    failed++;
                }
            }
        }

        log.info(`Metadata refresh complete: ${updated} updated, ${failed} failed`);

        return { updated, failed };
    }
}

export const remoteTrackMetadataRefreshService = new RemoteTrackMetadataRefreshService();
