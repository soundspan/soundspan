import { spawn } from "child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { logger } from "../../utils/logger";
import {
    segmentedStreamingCacheService,
    type SegmentedDashQuality,
} from "./cacheService";

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

const DASH_QUALITY_BITRATES: Record<SegmentedDashQuality, number> = {
    original: 320,
    high: 320,
    medium: 192,
    low: 128,
};

export interface EnsureLocalDashSegmentsInput {
    trackId: string;
    sourcePath: string;
    sourceModified: Date;
    quality: SegmentedDashQuality;
    cacheIdentity?: string;
}

export interface LocalDashSegmentAsset {
    cacheKey: string;
    outputDir: string;
    manifestPath: string;
    quality: SegmentedDashQuality;
}

class SegmentedSegmentService {
    private readonly inFlightBuilds = new Map<string, Promise<LocalDashSegmentAsset>>();

    async ensureLocalDashSegments(
        input: EnsureLocalDashSegmentsInput,
    ): Promise<LocalDashSegmentAsset> {
        const cacheKey = segmentedStreamingCacheService.buildDashCacheKey({
            trackId: input.trackId,
            sourcePath: input.sourcePath,
            sourceModifiedIso: input.sourceModified.toISOString(),
            quality: input.quality,
            cacheIdentity: input.cacheIdentity,
        });
        const paths = segmentedStreamingCacheService.getDashAssetPaths(cacheKey);

        if (await segmentedStreamingCacheService.hasDashManifest(cacheKey)) {
            return {
                ...paths,
                quality: input.quality,
            };
        }

        const existingBuild = this.inFlightBuilds.get(cacheKey);
        if (existingBuild) {
            return existingBuild;
        }

        const buildPromise = this.generateDashAsset({
            ...input,
            cacheKey,
            outputDir: paths.outputDir,
            manifestPath: paths.manifestPath,
        }).finally(() => {
            this.inFlightBuilds.delete(cacheKey);
        });

        this.inFlightBuilds.set(cacheKey, buildPromise);
        return buildPromise;
    }

    private async generateDashAsset(params: {
        trackId: string;
        sourcePath: string;
        quality: SegmentedDashQuality;
        cacheKey: string;
        outputDir: string;
        manifestPath: string;
    }): Promise<LocalDashSegmentAsset> {
        await segmentedStreamingCacheService.ensureDashAssetDirectory(params.cacheKey);

        const bitrate = DASH_QUALITY_BITRATES[params.quality];
        const ffmpegArgs = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            params.sourcePath,
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "aac",
            "-b:a",
            `${bitrate}k`,
            "-f",
            "dash",
            "-seg_duration",
            "4",
            "-use_template",
            "1",
            "-use_timeline",
            "1",
            "-init_seg_name",
            "init-$RepresentationID$.m4s",
            "-media_seg_name",
            "chunk-$RepresentationID$-$Number%05d$.m4s",
            "manifest.mpd",
        ];

        logger.debug(
            `[SegmentedStreaming] Generating local DASH segments for track ${params.trackId} (${params.quality})`,
        );

        await new Promise<void>((resolve, reject) => {
            const ffmpegProc = spawn(ffmpegPath.path, ffmpegArgs, {
                cwd: params.outputDir,
                stdio: ["ignore", "ignore", "pipe"],
            });

            let stderrBuffer = "";
            const timeoutId = setTimeout(() => {
                ffmpegProc.kill("SIGKILL");
                reject(
                    new Error(
                        `DASH segment generation timed out after ${FFMPEG_TIMEOUT_MS}ms`,
                    ),
                );
            }, FFMPEG_TIMEOUT_MS);

            ffmpegProc.stderr.on("data", (chunk: Buffer) => {
                stderrBuffer += chunk.toString("utf8");
            });

            ffmpegProc.on("error", (error) => {
                clearTimeout(timeoutId);
                reject(error);
            });

            ffmpegProc.on("close", async (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    resolve();
                    return;
                }

                reject(
                    new Error(
                        `DASH segment generation failed with exit code ${code}: ${stderrBuffer.trim() || "no stderr output"}`,
                    ),
                );
            });
        });

        if (!(await segmentedStreamingCacheService.hasDashManifest(params.cacheKey))) {
            throw new Error("DASH segment generation completed without manifest");
        }

        return {
            cacheKey: params.cacheKey,
            outputDir: params.outputDir,
            manifestPath: params.manifestPath,
            quality: params.quality,
        };
    }
}

export const segmentedSegmentService = new SegmentedSegmentService();
