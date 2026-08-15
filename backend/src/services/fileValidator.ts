import * as fs from "fs";
import type { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { config } from "../config";
import { safeResolvePath } from "../utils/safeResolvePath";
import PQueue from "p-queue";
import { processBatched } from "../utils/async";

// Cap health writes at the worker database pool's four connections.
const HEALTH_WRITE_BATCH_SIZE = 4;

type LibraryHealthRecordDelegate = {
    upsert(args: Prisma.LibraryHealthRecordUpsertArgs): Promise<unknown>;
    deleteMany(
        args: Prisma.LibraryHealthRecordDeleteManyArgs,
    ): Promise<unknown>;
};

function getLibraryHealthRecordDelegate(): LibraryHealthRecordDelegate {
    return (
        prisma as typeof prisma & {
            libraryHealthRecord: LibraryHealthRecordDelegate;
        }
    ).libraryHealthRecord;
}

export interface ValidationResult {
    tracksChecked: number;
    tracksRemoved: number;
    tracksMissing: string[]; // IDs of missing tracks
    duration: number;
}

/**
 * Represents the FileValidatorService class.
 */
export class FileValidatorService {
    private validationQueue = new PQueue({ concurrency: 50 });

    private async markTrackMissing(
        trackId: string,
        filePath: string,
        detail?: string,
    ): Promise<void> {
        await getLibraryHealthRecordDelegate().upsert({
            where: { trackId },
            update: {
                status: "MISSING_FROM_DISK",
                filePath,
                detail: detail ?? null,
            },
            create: {
                trackId,
                status: "MISSING_FROM_DISK",
                filePath,
                detail: detail ?? null,
            },
        });
    }

    private async clearTrackHealthRecord(trackId: string): Promise<void> {
        await getLibraryHealthRecordDelegate().deleteMany({
            where: {
                trackId,
                status: "MISSING_FROM_DISK",
            },
        });
    }

    /**
     * Validate all tracks in the library and record health issues for missing files.
     */
    async validateLibrary(): Promise<ValidationResult> {
        const startTime = Date.now();
        const result: ValidationResult = {
            tracksChecked: 0,
            tracksRemoved: 0,
            tracksMissing: [],
            duration: 0,
        };

        logger.debug("[FileValidator] Starting library validation...");

        // Get all tracks from the database
        const tracks = await prisma.track.findMany({
            where: { origin: "LOCAL", filePath: { not: null } },
            select: {
                id: true,
                filePath: true,
                title: true,
            },
        });

        logger.debug(
            `[FileValidator] Found ${tracks.length} tracks to validate`,
        );

        // Check each track's file existence
        const missingTrackIds: string[] = [];
        const healthyTrackIds: string[] = [];

        for (const track of tracks) {
            await this.validationQueue.add(async () => {
                if (track.filePath === null) return;
                try {
                    const absolutePath = safeResolvePath(
                        config.music.musicPath,
                        track.filePath,
                    );

                    // Prevent path traversal attacks
                    if (!absolutePath) {
                        logger.warn(
                            `[FileValidator] Path traversal attempt detected: ${track.filePath}`,
                        );
                        missingTrackIds.push(track.id);
                        result.tracksChecked++;
                        return;
                    }

                    const exists = await this.fileExists(absolutePath);

                    if (!exists) {
                        logger.debug(
                            `[FileValidator] Missing file: ${track.filePath} (${track.title})`,
                        );
                        missingTrackIds.push(track.id);
                    } else {
                        healthyTrackIds.push(track.id);
                    }

                    result.tracksChecked++;

                    // Log progress every 100 tracks
                    if (result.tracksChecked % 100 === 0) {
                        logger.debug(
                            `[FileValidator] Progress: ${result.tracksChecked}/${tracks.length} tracks checked, ${missingTrackIds.length} missing`,
                        );
                    }
                } catch (err: any) {
                    logger.error(
                        `[FileValidator] Error checking ${track.filePath}:`,
                        err.message,
                    );
                }
            });
        }

        await this.validationQueue.onIdle();

        result.tracksMissing = missingTrackIds;

        if (healthyTrackIds.length > 0) {
            await getLibraryHealthRecordDelegate().deleteMany({
                where: {
                    trackId: { in: healthyTrackIds },
                    status: "MISSING_FROM_DISK",
                },
            });
        }

        if (missingTrackIds.length > 0) {
            logger.debug(
                `[FileValidator] Recording ${missingTrackIds.length} missing tracks in library health...`,
            );

            const missingTracks = tracks.filter(
                (track): track is typeof track & { filePath: string } =>
                    track.filePath !== null &&
                    missingTrackIds.includes(track.id),
            );
            await processBatched(
                missingTracks,
                HEALTH_WRITE_BATCH_SIZE,
                (batch) =>
                    Promise.all(
                        batch.map((track) =>
                            this.markTrackMissing(track.id, track.filePath),
                        ),
                    ),
            );
        }

        result.duration = Date.now() - startTime;

        logger.debug(
            `[FileValidator] Validation complete: ${result.tracksChecked} checked, ${result.tracksMissing.length} unhealthy (${result.duration}ms)`,
        );

        return result;
    }

    /**
     * Check if a file exists (async)
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validate a single track and record or clear health issues as needed.
     */
    async validateTrack(trackId: string): Promise<boolean> {
        const track = await prisma.track.findUnique({
            where: { id: trackId, origin: "LOCAL" },
            select: {
                id: true,
                filePath: true,
                title: true,
            },
        });

        if (!track || track.filePath === null) {
            return false;
        }

        const absolutePath = safeResolvePath(
            config.music.musicPath,
            track.filePath,
        );

        // Prevent path traversal attacks
        if (!absolutePath) {
            logger.warn(
                `[FileValidator] Path traversal attempt detected: ${track.filePath}`,
            );
            await this.markTrackMissing(
                track.id,
                track.filePath,
                "Path traversal attempt detected during validation",
            );
            return false;
        }

        const exists = await this.fileExists(absolutePath);

        if (!exists) {
            logger.debug(
                `[FileValidator] Track file missing, recording health issue: ${track.title}`,
            );
            await this.markTrackMissing(track.id, track.filePath);
            return false;
        }

        await this.clearTrackHealthRecord(track.id);
        return true;
    }
}

export const fileValidator = new FileValidatorService();
