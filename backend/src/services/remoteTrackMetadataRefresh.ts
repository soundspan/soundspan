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
const PLACEHOLDER_VALUES = new Set(["unknown", ""]);

/**
 * Returns true if the value is a real (non-placeholder) string.
 */
function isRealValue(value: string | undefined | null): value is string {
    if (!value) return false;
    return !PLACEHOLDER_VALUES.has(value.toLowerCase().trim());
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
                OR: [
                    { title: { in: ["Unknown", "unknown", ""] } },
                    { artist: { in: ["Unknown", "unknown", ""] } },
                ],
            },
            select: { id: true, tidalId: true },
            take: batchSize,
        });

        const unknownYt = await prisma.trackYtMusic.findMany({
            where: {
                OR: [
                    { title: { in: ["Unknown", "unknown", ""] } },
                    { artist: { in: ["Unknown", "unknown", ""] } },
                ],
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
            const tidalUser = await prisma.userSettings.findFirst({
                where: { tidalOAuthJson: { not: null } },
                select: { userId: true },
            });

            if (tidalUser) {
                log.debug(
                    `Using user ${tidalUser.userId} credentials for Tidal metadata refresh of ${unknownTidal.length} rows`
                );
                for (const row of unknownTidal) {
                    try {
                        const detail = await tidalStreamingService.getTrack(
                            tidalUser.userId,
                            row.tidalId
                        );
                        const updateData: Record<string, string | number> = {};
                        if (isRealValue(detail?.title)) updateData.title = detail!.title;
                        if (isRealValue(detail?.artist)) updateData.artist = detail!.artist;
                        if (isRealValue(detail?.album?.title)) updateData.album = detail!.album!.title;
                        if (detail?.duration && detail.duration > 0) updateData.duration = detail.duration;

                        if (Object.keys(updateData).length > 0) {
                            await prisma.trackTidal.update({
                                where: { id: row.id },
                                data: updateData,
                            });
                            log.debug(`Refreshed TrackTidal id=${row.id}: updated fields [${Object.keys(updateData).join(", ")}]`);
                            updated++;
                        } else {
                            log.debug(`TrackTidal id=${row.id}: API returned no real metadata`);
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
                    if (isRealValue(song?.title)) ytUpdateData.title = song!.title;
                    if (isRealValue(song?.artist)) ytUpdateData.artist = song!.artist;
                    if (isRealValue(song?.album)) ytUpdateData.album = song!.album!;
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
