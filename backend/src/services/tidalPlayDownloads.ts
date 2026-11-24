/**
 * TIDAL download-as-you-play.
 *
 * When an admin turns on `SystemSettings.tidalDownloadBeforePlay`, every TIDAL
 * song plays from its download: the sidecar downloads it once into the music
 * library with the admin account at the highest quality and streams those same
 * bytes to the listener as they arrive. Nothing plays without ending up in the
 * library. When the download is installed it is recorded in
 * `TidalPlayDownload` and a scan of just that file adds it to the library;
 * later plays serve the local file at the listener's Playback quality. Its
 * `lastPlayedAt` lets a future cleanup drop songs nobody plays.
 */

import type { Request, Response } from "express";
import { promises as fs } from "node:fs";
import { parseFile } from "music-metadata";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { safeResolvePath } from "../utils/safeResolvePath";
import { normalizeStreamingQuality } from "../utils/libraryAudioInfo";
import { requestLibraryFileScan } from "./libraryFileScan";
import { AudioStreamingService, type Quality } from "./audioStreaming";
import {
    tidalService,
    type TidalDownloadResult,
    type TidalPlayDownloadInfo,
} from "./tidal";

const log = logger.child("TidalPlayDownloads");

/** TIDAL's best tier; the sidecar falls back when a song is not offered in it. */
export const TIDAL_PLAY_DOWNLOAD_QUALITY = "HI_RES_LOSSLESS";

/** A downloaded TIDAL song ready to be served from the music folder. */
export interface TidalPlayDownloadFile {
    tidalId: number;
    absolutePath: string;
    fileModified: Date;
    quality: string;
    codec: string | null;
    bitDepth: number | null;
    sampleRate: number | null;
}

/** Stream metadata in the shape of `GET /api/tidal-streaming/stream-info`. */
export interface TidalPlayDownloadStreamInfo {
    trackId: number;
    quality: string;
    acodec: string;
    content_type: string;
    bit_depth?: number;
    sample_rate?: number;
}

/** A download that is streaming now; settles once it is recorded. */
interface RunningPlayDownload {
    info: TidalPlayDownloadInfo;
    completion: Promise<TidalPlayDownloadFile | null>;
}

const runningDownloads = new Map<number, RunningPlayDownload>();

/** Whether the admin has turned on download-before-play for TIDAL. */
export async function isTidalPlayDownloadEnabled(): Promise<boolean> {
    const settings = await getSystemSettings();
    return (
        settings?.tidalEnabled === true &&
        settings?.tidalDownloadBeforePlay === true
    );
}

/**
 * The downloaded copy of a TIDAL song, marked as played, or null when it has
 * not been downloaded (or its file is gone).
 */
export async function findTidalPlayDownload(
    tidalId: number,
): Promise<TidalPlayDownloadFile | null> {
    return loadRecordedDownload(tidalId);
}

/**
 * Start (or join) the download of a TIDAL song and return the stream of its
 * bytes as they arrive. The download finishes, and is recorded, whether or
 * not anyone keeps reading the stream. Throws when it cannot start.
 */
export async function openTidalPlayDownload(
    tidalId: number,
    userId: string,
): Promise<{ stream: NodeJS.ReadableStream; info: TidalPlayDownloadInfo }> {
    const start = await tidalService.startPlayDownload(
        tidalId,
        TIDAL_PLAY_DOWNLOAD_QUALITY,
    );
    if (!runningDownloads.has(tidalId)) {
        const completion = collectPlayDownload(
            tidalId,
            userId,
            start.downloadId,
        ).finally(() => runningDownloads.delete(tidalId));
        runningDownloads.set(tidalId, { info: start.info, completion });
    }
    return { stream: start.stream, info: start.info };
}

/**
 * What a song not yet downloaded will stream, starting its download if needed
 * (without reading it here).
 */
export async function tidalPlayDownloadInfo(
    tidalId: number,
    userId: string,
): Promise<TidalPlayDownloadInfo> {
    const running = runningDownloads.get(tidalId);
    if (running) return running.info;
    const { stream, info } = await openTidalPlayDownload(tidalId, userId);
    closeStream(stream);
    return info;
}

/**
 * Download a song completely and return its local copy, e.g. when a player
 * seeks past what has streamed. Null when the download failed.
 */
export async function awaitTidalPlayDownload(
    tidalId: number,
    userId: string,
): Promise<TidalPlayDownloadFile | null> {
    const running = runningDownloads.get(tidalId);
    if (running) return running.completion;
    const { stream } = await openTidalPlayDownload(tidalId, userId);
    closeStream(stream);
    return runningDownloads.get(tidalId)?.completion ?? null;
}

/** Stream-info for a song that is still downloading. */
export function tidalPlayDownloadStartInfo(
    tidalId: number,
    info: TidalPlayDownloadInfo,
): TidalPlayDownloadStreamInfo {
    return {
        trackId: tidalId,
        quality: info.quality,
        acodec: info.codec ?? "aac",
        content_type: info.contentType,
        ...(info.bitDepth ? { bit_depth: info.bitDepth } : {}),
        ...(info.sampleRate ? { sample_rate: info.sampleRate } : {}),
    };
}

/** Stop reading our copy of a download; the sidecar keeps downloading. */
function closeStream(stream: NodeJS.ReadableStream): void {
    const destroyable = stream as NodeJS.ReadableStream & {
        destroy?: () => void;
    };
    if (typeof destroyable.destroy === "function") destroyable.destroy();
}

/** The listener's Playback quality, defaulting like library streams do. */
export async function resolveTidalPlayDownloadQuality(
    userId: string,
): Promise<Quality> {
    const settings = await prisma.userSettings.findUnique({
        where: { userId },
        select: { playbackQuality: true },
    });
    return normalizeStreamingQuality(settings?.playbackQuality) ?? "medium";
}

/** Describe what `streamTidalPlayDownload` serves at this quality. */
export function tidalPlayDownloadStreamInfo(
    file: TidalPlayDownloadFile,
    quality: Quality,
): TidalPlayDownloadStreamInfo {
    if (quality !== "original") {
        return {
            trackId: file.tidalId,
            quality: quality.toUpperCase(),
            acodec: "MP3",
            content_type: "audio/mpeg",
        };
    }
    const codec = file.codec ?? "FLAC";
    return {
        trackId: file.tidalId,
        quality: file.quality,
        acodec: codec,
        content_type: codec === "FLAC" ? "audio/flac" : "audio/mp4",
        ...(file.bitDepth ? { bit_depth: file.bitDepth } : {}),
        ...(file.sampleRate ? { sample_rate: file.sampleRate } : {}),
    };
}

/**
 * Serve a downloaded song with Range support, transcoding to the listener's
 * quality and falling back to the original file when ffmpeg is missing.
 */
export async function streamTidalPlayDownload(
    req: Request,
    res: Response,
    file: TidalPlayDownloadFile,
    quality: Quality,
): Promise<void> {
    const service = new AudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );
    const cacheKey = `tidal-play-${file.tidalId}`;
    try {
        let streamFile;
        try {
            streamFile = await service.getStreamFilePath(
                cacheKey,
                quality,
                file.fileModified,
                file.absolutePath,
            );
        } catch (error: any) {
            if (error?.code !== "FFMPEG_NOT_FOUND" || quality === "original") {
                throw error;
            }
            streamFile = await service.getStreamFilePath(
                cacheKey,
                "original",
                file.fileModified,
                file.absolutePath,
            );
        }
        await service.streamFileWithRangeSupport(
            req,
            res,
            streamFile.filePath,
            streamFile.mimeType,
        );
    } finally {
        service.destroy();
    }
}

async function loadRecordedDownload(
    tidalId: number,
): Promise<TidalPlayDownloadFile | null> {
    try {
        const row = await prisma.tidalPlayDownload.findUnique({
            where: { tidalId },
        });
        if (!row) return null;
        const absolutePath = safeResolvePath(
            config.music.musicPath,
            row.relativePath,
        );
        if (!absolutePath) return null;
        const stat = await fs.stat(absolutePath);
        await prisma.tidalPlayDownload.update({
            where: { tidalId },
            data: { lastPlayedAt: new Date() },
        });
        return {
            tidalId,
            absolutePath,
            fileModified: stat.mtime,
            quality: row.quality,
            codec: row.codec,
            bitDepth: row.bitDepth,
            sampleRate: row.sampleRate,
        };
    } catch (error) {
        // A missing file or unreadable row means downloading it again.
        log.debug("Recorded TIDAL play download unavailable", {
            tidalId,
            error,
        });
        return null;
    }
}

/** Wait for the sidecar to install a play download, then record it. */
async function collectPlayDownload(
    tidalId: number,
    userId: string,
    downloadId: string,
): Promise<TidalPlayDownloadFile | null> {
    try {
        const result = await tidalService.getPlayDownloadResult(downloadId);
        return await recordPlayDownload(tidalId, userId, result);
    } catch (error) {
        log.warn("TIDAL play download failed", { tidalId, error });
        return null;
    }
}

/** Record an installed play download and add its file to the library. */
async function recordPlayDownload(
    tidalId: number,
    userId: string,
    result: TidalDownloadResult,
): Promise<TidalPlayDownloadFile | null> {
    const absolutePath = safeResolvePath(
        config.music.musicPath,
        result.relative_path,
    );
    if (!absolutePath) {
        log.warn("TIDAL download landed outside the music folder", {
            tidalId,
        });
        return null;
    }
    const stat = await fs.stat(absolutePath);
    const format = await readAudioFormat(absolutePath);
    const record = {
        relativePath: result.relative_path,
        quality: result.quality,
        codec: format.codec,
        bitDepth: format.bitDepth,
        sampleRate: format.sampleRate,
        lastPlayedAt: new Date(),
    };
    await prisma.tidalPlayDownload.upsert({
        where: { tidalId },
        create: { tidalId, ...record },
        update: record,
    });
    requestScan(userId, tidalId, result.relative_path);
    log.info("Downloaded TIDAL song while playing", {
        tidalId,
        quality: result.quality,
    });
    return {
        tidalId,
        absolutePath,
        fileModified: stat.mtime,
        quality: result.quality,
        ...format,
    };
}

async function readAudioFormat(absolutePath: string): Promise<{
    codec: string | null;
    bitDepth: number | null;
    sampleRate: number | null;
}> {
    const extensionCodec = absolutePath.toLowerCase().endsWith(".flac")
        ? "FLAC"
        : null;
    try {
        const { format } = await parseFile(absolutePath);
        return {
            codec: format.codec ?? extensionCodec,
            bitDepth: format.bitsPerSample ?? null,
            sampleRate: format.sampleRate ?? null,
        };
    } catch {
        return { codec: extensionCodec, bitDepth: null, sampleRate: null };
    }
}

function requestScan(
    userId: string,
    tidalId: number,
    relativePath: string,
): void {
    // Only this file is new, so the library needs no full rescan.
    requestLibraryFileScan(userId, [relativePath], "tidal-play-download").catch(
        (error) => {
            log.warn("Library scan request after TIDAL play download failed", {
                tidalId,
                error,
            });
        },
    );
}
