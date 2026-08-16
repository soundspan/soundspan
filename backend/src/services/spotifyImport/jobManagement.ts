import { normalizeString } from "../../utils/trackMatching";
import {
    getImportJob,
    jobLoggers,
    MATCHABLE_TRACK_WHERE,
    saveImportJob,
    spotifyImportPrisma,
} from "./state";
import type { ImportJob } from "./types";
import { SpotifyImportLifecycleService } from "./lifecycle";

export class SpotifyImportJobManagementService extends SpotifyImportLifecycleService {
    /**
     * Re-match pending tracks and add newly downloaded ones to the playlist
     */
    async refreshJobMatches(
        jobId: string,
    ): Promise<{ added: number; total: number }> {
        const logger = jobLoggers.get(jobId);
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }
        if (!job.createdPlaylistId) {
            throw new Error("No playlist created for this job");
        }

        let added = 0;

        // Get existing tracks in playlist
        const existingItems = await spotifyImportPrisma.playlistItem.findMany({
            where: { playlistId: job.createdPlaylistId },
            select: { trackId: true },
        });
        const existingTrackIds = new Set(
            existingItems.map((item) => item.trackId),
        );

        // Get next position
        const maxPosition = existingItems.length;
        let nextPosition = maxPosition;

        // Try to match each pending track
        for (const pendingTrack of job.pendingTracks) {
            const normalizedArtist = normalizeString(pendingTrack.artist);

            // Track model doesn't have normalizedTitle - use case-insensitive title matching
            const localTrack = await spotifyImportPrisma.track.findFirst({
                where: {
                    ...MATCHABLE_TRACK_WHERE,
                    title: {
                        equals: pendingTrack.title,
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: normalizedArtist,
                        },
                    },
                },
            });

            if (localTrack && !existingTrackIds.has(localTrack.id)) {
                // Add to playlist
                await spotifyImportPrisma.playlistItem.create({
                    data: {
                        playlistId: job.createdPlaylistId,
                        trackId: localTrack.id,
                        sort: nextPosition++,
                    },
                });
                existingTrackIds.add(localTrack.id);
                added++;
            }
        }

        job.tracksMatched += added;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.debug(
            `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`,
        );
        logger?.info(
            `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${job.tracksMatched}`,
        );

        return { added, total: job.tracksMatched };
    }

    /**
     * Get import job status (public method for routes)
     */
    async getJob(jobId: string): Promise<ImportJob | null> {
        return await getImportJob(jobId);
    }

    /**
     * Get all jobs for a user
     */
    async getUserJobs(userId: string): Promise<ImportJob[]> {
        // Get from database to include jobs across restarts
        const dbJobs = await spotifyImportPrisma.spotifyImportJob.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        return dbJobs
            .map((dbJob) => ({
                id: dbJob.id,
                userId: dbJob.userId,
                spotifyPlaylistId: dbJob.spotifyPlaylistId,
                playlistName: dbJob.playlistName,
                status: dbJob.status as ImportJob["status"],
                progress: dbJob.progress,
                albumsTotal: dbJob.albumsTotal,
                albumsCompleted: dbJob.albumsCompleted,
                tracksMatched: dbJob.tracksMatched,
                tracksTotal: dbJob.tracksTotal,
                tracksDownloadable: dbJob.tracksDownloadable,
                createdPlaylistId: dbJob.createdPlaylistId,
                error: dbJob.error,
                createdAt: dbJob.createdAt,
                updatedAt: dbJob.updatedAt,
                pendingTracks: (dbJob.pendingTracks as any) || [],
            }))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    /**
     * Cancel an import job without creating a playlist.
     * All pending downloads are marked as failed and the job is marked as cancelled.
     */
    async cancelJob(jobId: string): Promise<{
        playlistCreated: boolean;
        playlistId: string | null;
        tracksMatched: number;
    }> {
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }

        const logger = jobLoggers.get(jobId);
        logger?.debug(`[Spotify Import] Cancelling job ${jobId}...`);
        logger?.info(`Job cancelled by user`);

        // If already completed, cancelled, or failed, nothing to do
        if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled"
        ) {
            return {
                playlistCreated: !!job.createdPlaylistId,
                playlistId: job.createdPlaylistId || null,
                tracksMatched: job.tracksMatched,
            };
        }

        // Mark any pending download jobs as cancelled
        await spotifyImportPrisma.downloadJob.updateMany({
            where: {
                metadata: {
                    path: ["spotifyImportJobId"],
                    equals: jobId,
                },
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Import cancelled by user",
                completedAt: new Date(),
            },
        });

        // Mark job as cancelled - do NOT create a playlist
        job.status = "cancelled";
        job.updatedAt = new Date();
        await saveImportJob(job);
        logger?.info(`Import cancelled by user - no playlist created`);

        return {
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        };
    }
}
