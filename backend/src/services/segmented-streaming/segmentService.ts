import { spawn } from "child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { logger } from "../../utils/logger";
import {
    segmentedStreamingCacheService,
    type SegmentedDashQuality,
} from "./cacheService";
import {
    logSegmentedStreamingTrace,
    segmentedTraceDurationMs,
    toSegmentedTraceErrorFields,
} from "./trace";

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

const DASH_QUALITY_BITRATES: Record<SegmentedDashQuality, number> = {
    original: 320,
    high: 320,
    medium: 192,
    low: 128,
};

const SOURCE_URL_REGEX = /^https?:\/\//i;

const resolveSourceKind = (sourcePath: string): "local" | "remote" =>
    SOURCE_URL_REGEX.test(sourcePath) ? "remote" : "local";

const summarizeStderr = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.length <= 300) {
        return trimmed;
    }
    return `${trimmed.slice(0, 297)}...`;
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
        const ensureStartedAtMs = Date.now();
        const cacheKey = segmentedStreamingCacheService.buildDashCacheKey({
            trackId: input.trackId,
            sourcePath: input.sourcePath,
            sourceModifiedIso: input.sourceModified.toISOString(),
            quality: input.quality,
            cacheIdentity: input.cacheIdentity,
        });
        const paths = segmentedStreamingCacheService.getDashAssetPaths(cacheKey);
        const sourceKind = resolveSourceKind(input.sourcePath);
        const manifestCheckStartedAtMs = Date.now();

        if (await segmentedStreamingCacheService.hasDashManifest(cacheKey)) {
            logSegmentedStreamingTrace("asset.ensure.cache_hit", {
                trackId: input.trackId,
                quality: input.quality,
                sourceKind,
                cacheKey,
                manifestCheckMs: segmentedTraceDurationMs(manifestCheckStartedAtMs),
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
            });
            return {
                ...paths,
                quality: input.quality,
            };
        }

        const existingBuild = this.inFlightBuilds.get(cacheKey);
        if (existingBuild) {
            const waitStartedAtMs = Date.now();
            try {
                const waitedAsset = await existingBuild;
                logSegmentedStreamingTrace("asset.ensure.inflight_wait_success", {
                    trackId: input.trackId,
                    quality: input.quality,
                    sourceKind,
                    cacheKey,
                    waitMs: segmentedTraceDurationMs(waitStartedAtMs),
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                });
                return waitedAsset;
            } catch (error) {
                logSegmentedStreamingTrace("asset.ensure.inflight_wait_error", {
                    trackId: input.trackId,
                    quality: input.quality,
                    sourceKind,
                    cacheKey,
                    waitMs: segmentedTraceDurationMs(waitStartedAtMs),
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                    ...toSegmentedTraceErrorFields(error),
                });
                throw error;
            }
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
        try {
            const builtAsset = await buildPromise;
            logSegmentedStreamingTrace("asset.ensure.generated", {
                trackId: input.trackId,
                quality: input.quality,
                sourceKind,
                cacheKey,
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
            });
            return builtAsset;
        } catch (error) {
            logSegmentedStreamingTrace("asset.ensure.generate_error", {
                trackId: input.trackId,
                quality: input.quality,
                sourceKind,
                cacheKey,
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                ...toSegmentedTraceErrorFields(error),
            });
            throw error;
        }
    }

    private async generateDashAsset(params: {
        trackId: string;
        sourcePath: string;
        quality: SegmentedDashQuality;
        cacheKey: string;
        outputDir: string;
        manifestPath: string;
    }): Promise<LocalDashSegmentAsset> {
        const generationStartedAtMs = Date.now();
        const sourceKind = resolveSourceKind(params.sourcePath);
        const ensureDirStartedAtMs = Date.now();
        await segmentedStreamingCacheService.ensureDashAssetDirectory(params.cacheKey);
        const ensureDirMs = segmentedTraceDurationMs(ensureDirStartedAtMs);

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
        logSegmentedStreamingTrace("asset.generate.start", {
            trackId: params.trackId,
            quality: params.quality,
            sourceKind,
            cacheKey: params.cacheKey,
            bitrateKbps: bitrate,
            ensureDirMs,
        });

        const ffmpegStartedAtMs = Date.now();
        await new Promise<void>((resolve, reject) => {
            const ffmpegProc = spawn(ffmpegPath.path, ffmpegArgs, {
                cwd: params.outputDir,
                stdio: ["ignore", "ignore", "pipe"],
            });

            let stderrBuffer = "";
            const timeoutId = setTimeout(() => {
                ffmpegProc.kill("SIGKILL");
                const timeoutError = new Error(
                    `DASH segment generation timed out after ${FFMPEG_TIMEOUT_MS}ms`,
                );
                logSegmentedStreamingTrace("asset.generate.ffmpeg_timeout", {
                    trackId: params.trackId,
                    quality: params.quality,
                    sourceKind,
                    cacheKey: params.cacheKey,
                    ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                });
                reject(timeoutError);
            }, FFMPEG_TIMEOUT_MS);

            ffmpegProc.stderr.on("data", (chunk: Buffer) => {
                stderrBuffer += chunk.toString("utf8");
            });

            ffmpegProc.on("error", (error) => {
                clearTimeout(timeoutId);
                logSegmentedStreamingTrace("asset.generate.ffmpeg_spawn_error", {
                    trackId: params.trackId,
                    quality: params.quality,
                    sourceKind,
                    cacheKey: params.cacheKey,
                    ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    ...toSegmentedTraceErrorFields(error),
                });
                reject(error);
            });

            ffmpegProc.on("close", async (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    logSegmentedStreamingTrace("asset.generate.ffmpeg_success", {
                        trackId: params.trackId,
                        quality: params.quality,
                        sourceKind,
                        cacheKey: params.cacheKey,
                        ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    });
                    resolve();
                    return;
                }

                logSegmentedStreamingTrace("asset.generate.ffmpeg_exit_error", {
                    trackId: params.trackId,
                    quality: params.quality,
                    sourceKind,
                    cacheKey: params.cacheKey,
                    exitCode: code,
                    ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    stderr: summarizeStderr(stderrBuffer),
                });
                reject(
                    new Error(
                        `DASH segment generation failed with exit code ${code}: ${stderrBuffer.trim() || "no stderr output"}`,
                    ),
                );
            });
        });

        if (!(await segmentedStreamingCacheService.hasDashManifest(params.cacheKey))) {
            logSegmentedStreamingTrace("asset.generate.missing_manifest", {
                trackId: params.trackId,
                quality: params.quality,
                sourceKind,
                cacheKey: params.cacheKey,
                totalMs: segmentedTraceDurationMs(generationStartedAtMs),
            });
            throw new Error("DASH segment generation completed without manifest");
        }

        logSegmentedStreamingTrace("asset.generate.done", {
            trackId: params.trackId,
            quality: params.quality,
            sourceKind,
            cacheKey: params.cacheKey,
            totalMs: segmentedTraceDurationMs(generationStartedAtMs),
        });

        return {
            cacheKey: params.cacheKey,
            outputDir: params.outputDir,
            manifestPath: params.manifestPath,
            quality: params.quality,
        };
    }
}

export const segmentedSegmentService = new SegmentedSegmentService();
