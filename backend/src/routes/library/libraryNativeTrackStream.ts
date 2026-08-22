import type { Request, Response } from "express";
import type { Track } from "@prisma/client";
import {
    AudioStreamingService,
    type Quality,
} from "../../services/audioStreaming";
import { config } from "../../config";
import { safeResolvePath } from "../../utils/safeResolvePath";
import { logger } from "../../utils/logger";
import { sendInternalRouteError, sendRouteError } from "../routeErrorResponse";

const log = logger.child("LibraryNativeTrackStream");

async function streamNativeFile(input: {
    req: Request;
    res: Response;
    track: Track;
    quality: Quality;
    absolutePath: string;
    service: AudioStreamingService;
}): Promise<void> {
    try {
        const streamFile = await input.service.getStreamFilePath(
            input.track.id,
            input.quality,
            input.track.fileModified,
            input.absolutePath,
        );
        await input.service.streamFileWithRangeSupport(
            input.req,
            input.res,
            streamFile.filePath,
            streamFile.mimeType,
        );
    } catch (error: any) {
        if (error.code !== "FFMPEG_NOT_FOUND" || input.quality === "original") {
            throw error;
        }
        const original = await input.service.getStreamFilePath(
            input.track.id,
            "original",
            input.track.fileModified,
            input.absolutePath,
        );
        await input.service.streamFileWithRangeSupport(
            input.req,
            input.res,
            original.filePath,
            original.mimeType,
        );
    }
}

/** Streams a local library file with bounded transcode fallback. */
export async function serveNativeLibraryTrack(input: {
    req: Request;
    res: Response;
    track: Track;
    requestedQuality: string;
}): Promise<Response | void> {
    if (!input.track.filePath) {
        return sendRouteError(input.res, 404, "Track not available");
    }
    const normalizedPath = input.track.filePath.replace(/\\/g, "/");
    const absolutePath = safeResolvePath(
        config.music.musicPath,
        normalizedPath,
    );
    if (!absolutePath) {
        log.warn("Rejected out-of-root stream path", {
            trackId: input.track.id,
        });
        return sendRouteError(input.res, 404, "Track not available");
    }
    const service = new AudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );
    try {
        await streamNativeFile({
            ...input,
            quality: input.requestedQuality as Quality,
            absolutePath,
            service,
        });
    } catch (error) {
        log.error("Native streaming failed", { error });
        return sendInternalRouteError(input.res, "Failed to stream track");
    } finally {
        service.destroy();
    }
}
