import { spawn } from "child_process";
import fs from "fs";
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
const DASH_CAPABILITY_PROBE_TIMEOUT_MS = 4_000;
const REMOTE_INPUT_CAPABILITY_PROBE_TIMEOUT_MS = 4_000;
const BUILD_FAILURE_RETENTION_MS = 60_000;
const SYSTEM_FFMPEG_PATH = "/usr/bin/ffmpeg";
const SEGMENTED_LOCAL_SEG_DURATION_SEC_ENV =
    "SEGMENTED_LOCAL_SEG_DURATION_SEC";
const DEFAULT_LOCAL_SEGMENT_DURATION_SEC = 1;
const DEFAULT_REMOTE_SEGMENT_DURATION_SEC = 2;

const DASH_QUALITY_BITRATES: Record<SegmentedDashQuality, number> = {
    original: 320,
    high: 320,
    medium: 192,
    low: 128,
};

const SOURCE_URL_REGEX = /^https?:\/\//i;
const LOSSLESS_FILE_EXTENSION_REGEX =
    /\.(flac|wav|aiff|aif|alac|ape|wv|tta|dff|dsf)$/i;

const DASH_COMPATIBILITY_FLAGS = ["-ldash", "-streaming"] as const;
const DASH_UNRECOGNIZED_OPTION_PATTERNS = {
    "-ldash": /Unrecognized option 'ldash'\./i,
    "-streaming": /Unrecognized option 'streaming'\./i,
} as const;
const DASH_HELP_OPTION_PATTERNS = {
    "-ldash": /(^|\n)\s*-ldash\b/im,
    "-streaming": /(^|\n)\s*-streaming\b/im,
} as const;

const REMOTE_INPUT_COMPATIBILITY_FLAGS = [
    "-reconnect",
    "-reconnect_streamed",
    "-reconnect_on_network_error",
    "-reconnect_on_http_error",
    "-reconnect_delay_max",
    "-rw_timeout",
] as const;
const REMOTE_INPUT_UNRECOGNIZED_OPTION_PATTERNS = {
    "-reconnect": /Unrecognized option 'reconnect'\./i,
    "-reconnect_streamed": /Unrecognized option 'reconnect_streamed'\./i,
    "-reconnect_on_network_error":
        /Unrecognized option 'reconnect_on_network_error'\./i,
    "-reconnect_on_http_error":
        /Unrecognized option 'reconnect_on_http_error'\./i,
    "-reconnect_delay_max":
        /Unrecognized option 'reconnect_delay_max'\./i,
    "-rw_timeout": /Unrecognized option 'rw_timeout'\./i,
} as const;
const REMOTE_INPUT_HELP_OPTION_PATTERNS = {
    "-reconnect": /(^|\n)\s*-?reconnect\b/im,
    "-reconnect_streamed": /(^|\n)\s*-?reconnect_streamed\b/im,
    "-reconnect_on_network_error":
        /(^|\n)\s*-?reconnect_on_network_error\b/im,
    "-reconnect_on_http_error":
        /(^|\n)\s*-?reconnect_on_http_error\b/im,
    "-reconnect_delay_max": /(^|\n)\s*-?reconnect_delay_max\b/im,
    "-rw_timeout": /(^|\n)\s*-?rw_timeout\b/im,
} as const;
const REMOTE_FFMPEG_INPUT_ARGS = [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_on_http_error",
    "4xx,5xx",
    "-reconnect_delay_max",
    "2",
    "-rw_timeout",
    "15000000",
] as const;

type DashSegmentContainer = "fmp4" | "webm";
type DashCompatibilityFlag = keyof typeof DASH_UNRECOGNIZED_OPTION_PATTERNS;
type RemoteInputCompatibilityFlag =
    keyof typeof REMOTE_INPUT_UNRECOGNIZED_OPTION_PATTERNS;
type FfmpegCompatibilityFlag =
    | DashCompatibilityFlag
    | RemoteInputCompatibilityFlag;

const resolveSegmentedFfmpegBinaryPath = (): string => {
    const configuredPath = process.env.FFMPEG_PATH?.trim();
    if (configuredPath) {
        return configuredPath;
    }
    if (fs.existsSync(SYSTEM_FFMPEG_PATH)) {
        return SYSTEM_FFMPEG_PATH;
    }
    return ffmpegPath.path;
};
const SEGMENTED_FFMPEG_BINARY_PATH = resolveSegmentedFfmpegBinaryPath();

interface DashEncodingPlan {
    targetRepresentation: DashAudioRepresentation;
    startupRepresentation: DashAudioRepresentation | null;
    representations: DashAudioRepresentation[];
    segmentContainer: DashSegmentContainer;
    initSegmentName: string;
    mediaSegmentName: string;
}

interface DashAudioRepresentation {
    audioCodec: "aac" | "flac";
    bitrateKbps: number | null;
    useExperimentalMuxing: boolean;
}

const parsePositiveNumberEnv = (envName: string): number | null => {
    const rawValue = process.env[envName]?.trim();
    if (!rawValue) {
        return null;
    }

    const parsedValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return null;
    }

    return parsedValue;
};

const resolveLocalSegmentDurationSec = (): number =>
    parsePositiveNumberEnv(SEGMENTED_LOCAL_SEG_DURATION_SEC_ENV) ??
    DEFAULT_LOCAL_SEGMENT_DURATION_SEC;

const LOCAL_SEGMENT_DURATION_SEC = resolveLocalSegmentDurationSec();

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

const removeFfmpegFlagWithValue = (
    ffmpegArgs: string[],
    flag: FfmpegCompatibilityFlag,
): string[] => {
    const nextArgs: string[] = [];
    for (let index = 0; index < ffmpegArgs.length; index += 1) {
        const arg = ffmpegArgs[index];
        if (arg !== flag) {
            nextArgs.push(arg);
            continue;
        }

        const nextArg = ffmpegArgs[index + 1];
        if (typeof nextArg === "string" && !nextArg.startsWith("-")) {
            index += 1;
        }
    }
    return nextArgs;
};

class DashSegmentGenerationError extends Error {
    readonly exitCode: number | null;
    readonly stderr: string;

    constructor(exitCode: number | null, stderr: string) {
        super(
            `DASH segment generation failed with exit code ${exitCode}: ${stderr.trim() || "no stderr output"}`,
        );
        this.name = "DashSegmentGenerationError";
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

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
    private readonly failedBuilds = new Map<
        string,
        { error: Error; failedAtMs: number }
    >();
    private readonly unsupportedDashFlags = new Set<DashCompatibilityFlag>();
    private readonly unsupportedRemoteInputFlags =
        new Set<RemoteInputCompatibilityFlag>();
    private dashCapabilityProbePromise: Promise<void> | null = null;

    async initializeDashCapabilityProbe(): Promise<void> {
        if (!this.dashCapabilityProbePromise) {
            this.dashCapabilityProbePromise = Promise.all([
                this.probeDashMuxerCapabilities(),
                this.probeRemoteInputCapabilities(),
            ]).then(() => undefined);
        }

        await this.dashCapabilityProbePromise;
    }

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
        segmentedStreamingCacheService.scheduleDashCachePrune();
        const manifestCheckStartedAtMs = Date.now();

        if (await segmentedStreamingCacheService.hasDashManifest(cacheKey)) {
            this.failedBuilds.delete(cacheKey);
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
            logSegmentedStreamingTrace("asset.ensure.inflight_active", {
                trackId: input.trackId,
                quality: input.quality,
                sourceKind,
                cacheKey,
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
            });
            return {
                ...paths,
                quality: input.quality,
            };
        }

        this.failedBuilds.delete(cacheKey);
        const buildPromise = this.generateDashAsset({
            ...input,
            cacheKey,
            outputDir: paths.outputDir,
            manifestPath: paths.manifestPath,
        }).finally(() => {
            this.inFlightBuilds.delete(cacheKey);
        });

        this.inFlightBuilds.set(cacheKey, buildPromise);
        void buildPromise
            .then(() => {
                this.failedBuilds.delete(cacheKey);
                logSegmentedStreamingTrace("asset.ensure.generated", {
                    trackId: input.trackId,
                    quality: input.quality,
                    sourceKind,
                    cacheKey,
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                });
            })
            .catch((error) => {
                const resolvedError =
                    error instanceof Error ? error : new Error(String(error));
                this.failedBuilds.set(cacheKey, {
                    error: resolvedError,
                    failedAtMs: Date.now(),
                });
                logSegmentedStreamingTrace("asset.ensure.generate_error", {
                    trackId: input.trackId,
                    quality: input.quality,
                    sourceKind,
                    cacheKey,
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                    ...toSegmentedTraceErrorFields(error),
                });
            })
            .finally(() => {
                this.pruneFailedBuilds();
            });

        logSegmentedStreamingTrace("asset.ensure.build_started", {
            trackId: input.trackId,
            quality: input.quality,
            sourceKind,
            cacheKey,
            totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
        });

        return {
            ...paths,
            quality: input.quality,
        };
    }

    hasInFlightBuild(cacheKey: string): boolean {
        return this.inFlightBuilds.has(cacheKey);
    }

    getBuildFailure(cacheKey: string): Error | null {
        this.pruneFailedBuilds();
        const failedBuild = this.failedBuilds.get(cacheKey);
        return failedBuild?.error ?? null;
    }

    private pruneFailedBuilds(): void {
        const now = Date.now();
        for (const [cacheKey, failure] of this.failedBuilds.entries()) {
            if (now - failure.failedAtMs > BUILD_FAILURE_RETENTION_MS) {
                this.failedBuilds.delete(cacheKey);
            }
        }
    }

    private async probeDashMuxerCapabilities(): Promise<void> {
        const probeStartedAtMs = Date.now();
        try {
            const probeOutput = await this.runDashCapabilityProbeCommand();
            const discoveredUnsupported: DashCompatibilityFlag[] = [];
            const flags = Object.keys(
                DASH_HELP_OPTION_PATTERNS,
            ) as DashCompatibilityFlag[];
            for (const flag of flags) {
                if (!DASH_HELP_OPTION_PATTERNS[flag].test(probeOutput)) {
                    this.unsupportedDashFlags.add(flag);
                    discoveredUnsupported.push(flag);
                }
            }

            logger.info(
                "[SegmentedStreaming] FFmpeg DASH capability probe completed",
                {
                    ffmpegPath: SEGMENTED_FFMPEG_BINARY_PATH,
                    unsupportedFlags: discoveredUnsupported,
                    supportedFlags: flags.filter(
                        (flag) => !discoveredUnsupported.includes(flag),
                    ),
                    probeMs: segmentedTraceDurationMs(probeStartedAtMs),
                },
            );
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] FFmpeg DASH capability probe failed; runtime fallback will be used",
                error,
            );
        }
    }

    private async probeRemoteInputCapabilities(): Promise<void> {
        const probeStartedAtMs = Date.now();
        try {
            const probeOutput = await this.runRemoteInputCapabilityProbeCommand();
            const discoveredUnsupported: RemoteInputCompatibilityFlag[] = [];
            const flags = Object.keys(
                REMOTE_INPUT_HELP_OPTION_PATTERNS,
            ) as RemoteInputCompatibilityFlag[];
            for (const flag of flags) {
                if (!REMOTE_INPUT_HELP_OPTION_PATTERNS[flag].test(probeOutput)) {
                    this.unsupportedRemoteInputFlags.add(flag);
                    discoveredUnsupported.push(flag);
                }
            }

            logger.info(
                "[SegmentedStreaming] FFmpeg remote-input capability probe completed",
                {
                    ffmpegPath: SEGMENTED_FFMPEG_BINARY_PATH,
                    unsupportedRemoteInputFlags: discoveredUnsupported,
                    supportedRemoteInputFlags: flags.filter(
                        (flag) => !discoveredUnsupported.includes(flag),
                    ),
                    probeMs: segmentedTraceDurationMs(probeStartedAtMs),
                },
            );
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] FFmpeg remote-input capability probe failed; runtime fallback will be used",
                error,
            );
        }
    }

    private async runDashCapabilityProbeCommand(): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            const ffmpegProc = spawn(
                SEGMENTED_FFMPEG_BINARY_PATH,
                ["-hide_banner", "-h", "muxer=dash"],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );

            let combinedOutput = "";
            const timeoutId = setTimeout(() => {
                ffmpegProc.kill("SIGKILL");
                reject(
                    new Error(
                        `FFmpeg DASH capability probe timed out after ${DASH_CAPABILITY_PROBE_TIMEOUT_MS}ms`,
                    ),
                );
            }, DASH_CAPABILITY_PROBE_TIMEOUT_MS);

            ffmpegProc.stdout.on("data", (chunk: Buffer) => {
                combinedOutput += chunk.toString("utf8");
            });
            ffmpegProc.stderr.on("data", (chunk: Buffer) => {
                combinedOutput += chunk.toString("utf8");
            });

            ffmpegProc.on("error", (error) => {
                clearTimeout(timeoutId);
                reject(error);
            });

            ffmpegProc.on("close", (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    resolve(combinedOutput);
                    return;
                }

                reject(
                    new Error(
                        `FFmpeg DASH capability probe failed with exit code ${code}: ${combinedOutput.trim() || "no output"}`,
                    ),
                );
            });
        });
    }

    private async runRemoteInputCapabilityProbeCommand(): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            const ffmpegProc = spawn(
                SEGMENTED_FFMPEG_BINARY_PATH,
                ["-hide_banner", "-h", "protocol=http"],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );

            let combinedOutput = "";
            const timeoutId = setTimeout(() => {
                ffmpegProc.kill("SIGKILL");
                reject(
                    new Error(
                        `FFmpeg remote-input capability probe timed out after ${REMOTE_INPUT_CAPABILITY_PROBE_TIMEOUT_MS}ms`,
                    ),
                );
            }, REMOTE_INPUT_CAPABILITY_PROBE_TIMEOUT_MS);

            ffmpegProc.stdout.on("data", (chunk: Buffer) => {
                combinedOutput += chunk.toString("utf8");
            });
            ffmpegProc.stderr.on("data", (chunk: Buffer) => {
                combinedOutput += chunk.toString("utf8");
            });

            ffmpegProc.on("error", (error) => {
                clearTimeout(timeoutId);
                reject(error);
            });

            ffmpegProc.on("close", (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    resolve(combinedOutput);
                    return;
                }

                reject(
                    new Error(
                        `FFmpeg remote-input capability probe failed with exit code ${code}: ${combinedOutput.trim() || "no output"}`,
                    ),
                );
            });
        });
    }

    private resolveDashMuxerArgs(
        segmentContainer: DashSegmentContainer,
    ): string[] {
        if (segmentContainer === "webm") {
            return ["-dash_segment_type", "webm"];
        }

        let dashArgs = ["-streaming", "1", "-ldash", "1"];
        const unsupportedFlags = Array.from(this.unsupportedDashFlags.values());
        for (const flag of unsupportedFlags) {
            dashArgs = removeFfmpegFlagWithValue(dashArgs, flag);
        }

        return dashArgs;
    }

    private resolveRemoteInputArgs(): string[] {
        let remoteArgs: string[] = Array.from(REMOTE_FFMPEG_INPUT_ARGS);
        const unsupportedFlags = Array.from(
            this.unsupportedRemoteInputFlags.values(),
        );
        for (const flag of unsupportedFlags) {
            remoteArgs = removeFfmpegFlagWithValue(remoteArgs, flag);
        }
        return remoteArgs;
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
        const encodingPlan = this.resolveDashEncodingPlan({
            quality: params.quality,
            sourcePath: params.sourcePath,
            bitrateKbps: bitrate,
            sourceKind,
        });
        const requiresExperimentalMuxing = encodingPlan.representations.some(
            (representation) => representation.useExperimentalMuxing,
        );
        const segmentDurationSec =
            sourceKind === "local"
                ? LOCAL_SEGMENT_DURATION_SEC
                : DEFAULT_REMOTE_SEGMENT_DURATION_SEC;
        const ffmpegInputArgs =
            sourceKind === "remote" ? this.resolveRemoteInputArgs() : [];
        const ffmpegMapArgs = encodingPlan.representations.flatMap(() => [
            "-map",
            "0:a:0",
        ]);
        const ffmpegRepresentationArgs = encodingPlan.representations.flatMap(
            (representation, index) => [
                "-c:a:" + index,
                representation.audioCodec,
                ...(representation.bitrateKbps !== null
                    ? ["-b:a:" + index, `${representation.bitrateKbps}k`]
                    : []),
            ],
        );
        const ffmpegArgs = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            ...ffmpegInputArgs,
            "-i",
            params.sourcePath,
            "-vn",
            ...ffmpegMapArgs,
            ...ffmpegRepresentationArgs,
            ...(requiresExperimentalMuxing ? ["-strict", "-2"] : []),
            "-f",
            "dash",
            ...this.resolveDashMuxerArgs(encodingPlan.segmentContainer),
            "-seg_duration",
            `${segmentDurationSec}`,
            "-use_template",
            "1",
            "-use_timeline",
            "1",
            "-adaptation_sets",
            "id=0,streams=a",
            "-init_seg_name",
            encodingPlan.initSegmentName,
            "-media_seg_name",
            encodingPlan.mediaSegmentName,
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
            bitrateKbps: encodingPlan.targetRepresentation.bitrateKbps,
            transcodeMode: encodingPlan.targetRepresentation.audioCodec,
            segmentContainer: encodingPlan.segmentContainer,
            segmentDurationSec,
            representationCount: encodingPlan.representations.length,
            startupBitrateKbps: encodingPlan.startupRepresentation?.bitrateKbps,
            startupCodec: encodingPlan.startupRepresentation?.audioCodec,
            ensureDirMs,
        });

        await this.runFfmpegWithCompatibilityFallback({
            trackId: params.trackId,
            quality: params.quality,
            sourceKind,
            cacheKey: params.cacheKey,
            outputDir: params.outputDir,
            ffmpegArgs,
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

    private async runFfmpegWithCompatibilityFallback(params: {
        trackId: string;
        quality: SegmentedDashQuality;
        sourceKind: "local" | "remote";
        cacheKey: string;
        outputDir: string;
        ffmpegArgs: string[];
    }): Promise<void> {
        const attemptedFallbackFlags = new Set<FfmpegCompatibilityFlag>();
        let ffmpegArgs = params.ffmpegArgs;

        while (true) {
            try {
                await this.runDashFfmpegProcess({
                    ...params,
                    ffmpegArgs,
                });
                return;
            } catch (error) {
                const unsupportedFlag = this.resolveUnsupportedFfmpegFlag({
                    error,
                    ffmpegArgs,
                    attemptedFallbackFlags,
                });

                if (!unsupportedFlag) {
                    throw error;
                }

                attemptedFallbackFlags.add(unsupportedFlag);
                if (this.isDashCompatibilityFlag(unsupportedFlag)) {
                    this.unsupportedDashFlags.add(unsupportedFlag);
                }
                if (this.isRemoteInputCompatibilityFlag(unsupportedFlag)) {
                    this.unsupportedRemoteInputFlags.add(unsupportedFlag);
                }
                ffmpegArgs = removeFfmpegFlagWithValue(ffmpegArgs, unsupportedFlag);
                logSegmentedStreamingTrace("asset.generate.ffmpeg_retry_without_flag", {
                    trackId: params.trackId,
                    quality: params.quality,
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    removedFlag: unsupportedFlag,
                    fallbackAttempt: attemptedFallbackFlags.size,
                });
            }
        }
    }

    private isDashCompatibilityFlag(
        flag: FfmpegCompatibilityFlag,
    ): flag is DashCompatibilityFlag {
        return (DASH_COMPATIBILITY_FLAGS as readonly string[]).includes(flag);
    }

    private isRemoteInputCompatibilityFlag(
        flag: FfmpegCompatibilityFlag,
    ): flag is RemoteInputCompatibilityFlag {
        return (REMOTE_INPUT_COMPATIBILITY_FLAGS as readonly string[]).includes(
            flag,
        );
    }

    private async runDashFfmpegProcess(params: {
        trackId: string;
        quality: SegmentedDashQuality;
        sourceKind: "local" | "remote";
        cacheKey: string;
        outputDir: string;
        ffmpegArgs: string[];
    }): Promise<void> {
        const ffmpegStartedAtMs = Date.now();
        await new Promise<void>((resolve, reject) => {
            const ffmpegProc = spawn(SEGMENTED_FFMPEG_BINARY_PATH, params.ffmpegArgs, {
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
                    sourceKind: params.sourceKind,
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
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    ...toSegmentedTraceErrorFields(error),
                });
                reject(error);
            });

            ffmpegProc.on("close", (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    logSegmentedStreamingTrace("asset.generate.ffmpeg_success", {
                        trackId: params.trackId,
                        quality: params.quality,
                        sourceKind: params.sourceKind,
                        cacheKey: params.cacheKey,
                        ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    });
                    resolve();
                    return;
                }

                logSegmentedStreamingTrace("asset.generate.ffmpeg_exit_error", {
                    trackId: params.trackId,
                    quality: params.quality,
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    exitCode: code,
                    ffmpegMs: segmentedTraceDurationMs(ffmpegStartedAtMs),
                    stderr: summarizeStderr(stderrBuffer),
                });
                reject(new DashSegmentGenerationError(code, stderrBuffer));
            });
        });
    }

    private resolveUnsupportedFfmpegFlag(params: {
        error: unknown;
        ffmpegArgs: string[];
        attemptedFallbackFlags: Set<FfmpegCompatibilityFlag>;
    }): FfmpegCompatibilityFlag | null {
        if (!(params.error instanceof DashSegmentGenerationError)) {
            return null;
        }

        const stderr = params.error.stderr;
        const unrecognizedOptionPatterns: Record<
            FfmpegCompatibilityFlag,
            RegExp
        > = {
            ...DASH_UNRECOGNIZED_OPTION_PATTERNS,
            ...REMOTE_INPUT_UNRECOGNIZED_OPTION_PATTERNS,
        };
        const orderedFlags = Object.keys(
            unrecognizedOptionPatterns,
        ) as FfmpegCompatibilityFlag[];
        for (const flag of orderedFlags) {
            if (!params.ffmpegArgs.includes(flag)) {
                continue;
            }
            if (params.attemptedFallbackFlags.has(flag)) {
                continue;
            }
            if (unrecognizedOptionPatterns[flag].test(stderr)) {
                return flag;
            }
        }

        return null;
    }

    private resolveDashEncodingPlan(params: {
        quality: SegmentedDashQuality;
        sourcePath: string;
        bitrateKbps: number;
        sourceKind: "local" | "remote";
    }): DashEncodingPlan {
        const isOriginalLocalLosslessTarget =
            params.quality === "original" &&
            params.sourceKind === "local" &&
            LOSSLESS_FILE_EXTENSION_REGEX.test(params.sourcePath);

        const targetRepresentation: DashAudioRepresentation =
            isOriginalLocalLosslessTarget
                ? {
                    audioCodec: "flac",
                    bitrateKbps: null,
                    useExperimentalMuxing: true,
                }
                : {
                    audioCodec: "aac",
                    bitrateKbps: params.bitrateKbps,
                    useExperimentalMuxing: false,
                };
        const startupRepresentation: DashAudioRepresentation | null = null;
        const representations = [targetRepresentation];

        return {
            targetRepresentation,
            startupRepresentation,
            representations,
            segmentContainer: "fmp4",
            initSegmentName: "init-$RepresentationID$.m4s",
            mediaSegmentName: "chunk-$RepresentationID$-$Number%05d$.m4s",
        };
    }
}

export const segmentedSegmentService = new SegmentedSegmentService();
