import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs, { promises as fsPromises } from "fs";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { logger } from "../../utils/logger";
import { createIORedisClient } from "../../utils/ioredis";
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
const STARTUP_CACHE_VALIDATION_SUCCESS_TTL_MS = 5_000;
const FULL_CACHE_VALIDATION_SUCCESS_TTL_MS = 60_000;
const SYSTEM_FFMPEG_PATH = "/usr/bin/ffmpeg";
const SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED =
    process.env.SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED !== "false";
const DEFAULT_SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS =
    FFMPEG_TIMEOUT_MS + 30_000;
const SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX =
    process.env.SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX ||
    "segmented-streaming:dash-build-lock";
const SEGMENTED_LOCAL_SEG_DURATION_SEC_ENV =
    "SEGMENTED_LOCAL_SEG_DURATION_SEC";
const SEGMENTED_DASH_BUILD_LOCK_TTL_MS_ENV =
    "SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS";
const DEFAULT_LOCAL_SEGMENT_DURATION_SEC = 1;
const DEFAULT_REMOTE_SEGMENT_DURATION_SEC = 2;
const DASH_SEGMENT_VALIDATION_SCAN_BYTES = 4_096;
const DASH_MIN_SEGMENT_FILE_BYTES = 32;
const STARTUP_CRITICAL_SEGMENT_MAX_INDEX = 2;
const RECOVERABLE_VALIDATION_REPAIR_COOLDOWN_MS = 15_000;
const DASH_BUILD_LOCK_RELEASE_LUA_SCRIPT =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const DASH_QUALITY_BITRATES: Record<SegmentedDashQuality, number> = {
    original: 320,
    high: 320,
    medium: 192,
    low: 128,
};
const DASH_LOWEST_FALLBACK_REPRESENTATION_BITRATE_KBPS = 96;

const SOURCE_URL_REGEX = /^https?:\/\//i;
export const LOSSLESS_FILE_EXTENSION_REGEX =
    /\.(flac|wav|aiff|aif|alac|ape|wv|tta|dff|dsf)$/i;
const DASH_CODEC_ATTRIBUTE_FLAC = 'codecs="flac"';
const DASH_CODEC_ATTRIBUTE_FLAC_CANONICAL = 'codecs="fLaC"';
const FORCE_REGENERATE_STAGING_SUFFIX = "regen";
const FORCE_REGENERATE_BACKUP_SUFFIX = "previous";

const DASH_COMPATIBILITY_FLAGS = [
    "-streaming",
    "-ldash",
    "-window_size",
    "-extra_window_size",
    "-remove_at_exit",
    "-start_number",
] as const;
const DASH_UNRECOGNIZED_OPTION_PATTERNS = {
    "-streaming": /Unrecognized option 'streaming'\./i,
    "-ldash": /Unrecognized option 'ldash'\./i,
    "-window_size": /Unrecognized option 'window_size'\./i,
    "-extra_window_size": /Unrecognized option 'extra_window_size'\./i,
    "-remove_at_exit": /Unrecognized option 'remove_at_exit'\./i,
    "-start_number": /Unrecognized option 'start_number'\./i,
} as const;
const DASH_HELP_OPTION_PATTERNS = {
    "-streaming": /(^|\n)\s*-streaming\b/im,
    "-ldash": /(^|\n)\s*-ldash\b/im,
    "-window_size": /(^|\n)\s*-window_size\b/im,
    "-extra_window_size": /(^|\n)\s*-extra_window_size\b/im,
    "-remove_at_exit": /(^|\n)\s*-remove_at_exit\b/im,
    "-start_number": /(^|\n)\s*-start_number\b/im,
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
type DashSegmentFileExtension = "m4s" | "webm";
export type SegmentedDashManifestProfile =
    | "startup_single"
    | "steady_state_dual";
type DashCompatibilityFlag = keyof typeof DASH_UNRECOGNIZED_OPTION_PATTERNS;
type RemoteInputCompatibilityFlag =
    keyof typeof REMOTE_INPUT_UNRECOGNIZED_OPTION_PATTERNS;
type FfmpegCompatibilityFlag =
    | DashCompatibilityFlag
    | RemoteInputCompatibilityFlag;

type DashBuildLockOperation = "ensure" | "force_regenerate";
type DashAssetValidationMode = "startup" | "full";
type DashAssetValidationPhase = "foreground" | "background";
interface DashBuildLock {
    lockKey: string;
    lockToken: string;
}
interface RecoverableCacheValidationFailure {
    reason: string;
    segmentName?: string;
    segmentCount: number;
    detectedAtMs: number;
}
interface DashBuildLockClient {
    set(
        key: string,
        value: string,
        mode: "EX",
        ttlSeconds: number,
        condition: "NX",
    ): Promise<"OK" | null>;
    exists(key: string): Promise<number>;
    eval(
        script: string,
        numKeys: number,
        key: string,
        token: string,
    ): Promise<unknown>;
}
interface DashAssetValidationResult {
    valid: boolean;
    reason?: string;
    segmentName?: string;
    segmentCount: number;
}
type DashBuildLockAcquireResult =
    | { acquired: true; lock: DashBuildLock }
    | { acquired: false; unavailable: true }
    | { acquired: false; unavailable: false };

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
    fallbackRepresentation: DashAudioRepresentation | null;
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

const parsePositiveIntegerEnv = (envName: string): number | null => {
    const rawValue = process.env[envName]?.trim();
    if (!rawValue) {
        return null;
    }

    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return null;
    }

    return parsedValue;
};

const resolveLocalSegmentDurationSec = (): number =>
    parsePositiveNumberEnv(SEGMENTED_LOCAL_SEG_DURATION_SEC_ENV) ??
    DEFAULT_LOCAL_SEGMENT_DURATION_SEC;

const resolveDashBuildLockTtlMs = (): number =>
    parsePositiveIntegerEnv(SEGMENTED_DASH_BUILD_LOCK_TTL_MS_ENV) ??
    DEFAULT_SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS;

const LOCAL_SEGMENT_DURATION_SEC = resolveLocalSegmentDurationSec();
const DASH_BUILD_LOCK_TTL_MS = resolveDashBuildLockTtlMs();
const dashBuildLockNodeId = randomUUID();
const dashBuildLockRedisClient: DashBuildLockClient | null =
    SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED
        ? (createIORedisClient(
            "segmented-streaming-dash-build-locks",
        ) as unknown as DashBuildLockClient)
        : null;

const resolveSourceKind = (sourcePath: string): "local" | "remote" =>
    SOURCE_URL_REGEX.test(sourcePath) ? "remote" : "local";

const DEFAULT_SEGMENTED_DASH_MANIFEST_PROFILE: SegmentedDashManifestProfile =
    "steady_state_dual";

const resolveSegmentedDashManifestProfile = (
    profile: SegmentedDashManifestProfile | null | undefined,
): SegmentedDashManifestProfile =>
    profile === "startup_single" || profile === "steady_state_dual"
        ? profile
        : DEFAULT_SEGMENTED_DASH_MANIFEST_PROFILE;

const buildForceRegenerateOperationId = (): string =>
    randomUUID().replace(/-/g, "").slice(0, 12);

const pathExists = async (targetPath: string): Promise<boolean> => {
    try {
        await fsPromises.access(targetPath);
        return true;
    } catch {
        return false;
    }
};

const isFileNotFoundError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT";

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
    manifestProfile?: SegmentedDashManifestProfile;
    cacheIdentity?: string;
}

export interface LocalDashSegmentAsset {
    cacheKey: string;
    outputDir: string;
    manifestPath: string;
    quality: SegmentedDashQuality;
    manifestProfile: SegmentedDashManifestProfile;
}

export interface DashBuildInFlightStatus {
    localInFlight: boolean;
    distributedInFlight: boolean;
    inFlight: boolean;
}

export class SegmentedSegmentService {
    private readonly inFlightBuilds = new Map<string, Promise<LocalDashSegmentAsset>>();
    private readonly inFlightValidations = new Map<string, Promise<boolean>>();
    private readonly failedBuilds = new Map<
        string,
        { error: Error; failedAtMs: number }
    >();
    private readonly invalidCacheKeys = new Set<string>();
    private readonly validCacheValidationMicrocache = new Map<string, number>();
    private readonly recoverableValidationFailures = new Map<
        string,
        RecoverableCacheValidationFailure
    >();
    private readonly recoverableValidationRepairCooldownUntilMs = new Map<
        string,
        number
    >();
    private readonly invalidValidationRepairCooldownUntilMs = new Map<
        string,
        number
    >();
    private readonly unsupportedDashFlags = new Set<DashCompatibilityFlag>();
    private readonly unsupportedRemoteInputFlags =
        new Set<RemoteInputCompatibilityFlag>();
    private dashCapabilityProbePromise: Promise<void> | null = null;

    constructor(
        private readonly buildLockRedisClient: DashBuildLockClient | null = dashBuildLockRedisClient,
    ) {}

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
        const normalizedInput = {
            ...input,
            manifestProfile: resolveSegmentedDashManifestProfile(
                input.manifestProfile,
            ),
        };
        const ensureStartedAtMs = Date.now();
        const cacheKey = this.buildDashCacheKey(normalizedInput);
        const paths = segmentedStreamingCacheService.getDashAssetPaths(cacheKey);
        const sourceKind = resolveSourceKind(input.sourcePath);
        segmentedStreamingCacheService.scheduleDashCachePrune();
        const existingBuild = this.inFlightBuilds.get(cacheKey);
        if (existingBuild) {
            logSegmentedStreamingTrace("asset.ensure.inflight_active", {
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
                cacheKey,
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
            });
            return {
                ...paths,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
            };
        }

        const manifestCheckStartedAtMs = Date.now();
        const hasManifest = await segmentedStreamingCacheService.hasDashManifest(
            cacheKey,
        );
        const cacheKeyMarkedInvalid = this.invalidCacheKeys.has(cacheKey);

        if (hasManifest && !cacheKeyMarkedInvalid) {
            const cacheValidationPassed = await this.validateCachedDashAssetIfNeeded({
                cacheKey,
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
                mode: "startup",
                phase: "foreground",
            });
            const recoverableValidationFailure =
                this.recoverableValidationFailures.get(cacheKey);
            if (cacheValidationPassed) {
                this.failedBuilds.delete(cacheKey);
                this.queueBackgroundCacheValidation({
                    input: normalizedInput,
                    cacheKey,
                    sourceKind,
                });
                if (recoverableValidationFailure) {
                    this.queueRecoverableValidationRepair({
                        input: normalizedInput,
                        cacheKey,
                        sourceKind,
                        failure: recoverableValidationFailure,
                    });
                }
                logSegmentedStreamingTrace("asset.ensure.cache_hit", {
                    trackId: input.trackId,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                    sourceKind,
                    cacheKey,
                    validationMode: "startup",
                    manifestCheckMs: segmentedTraceDurationMs(manifestCheckStartedAtMs),
                    ...(recoverableValidationFailure
                        ? {
                            validationReason: recoverableValidationFailure.reason,
                            validationSegmentName:
                                recoverableValidationFailure.segmentName,
                        }
                        : {}),
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                });
                return {
                    ...paths,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                };
            }
        }

        let acquiredBuildLock: DashBuildLock | null = null;
        let releaseBuildLockWithTrackedPromise = false;

        try {
            const lockAcquireResult = await this.acquireDashBuildLock({
                operation: "ensure",
                cacheKey,
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
            });

            if (!lockAcquireResult.acquired) {
                if (!lockAcquireResult.unavailable) {
                    logSegmentedStreamingTrace(
                        "asset.ensure.distributed_lock_conflict",
                        {
                            trackId: input.trackId,
                            quality: input.quality,
                            manifestProfile: normalizedInput.manifestProfile,
                            sourceKind,
                            cacheKey,
                            manifestCheckMs: segmentedTraceDurationMs(
                                manifestCheckStartedAtMs,
                            ),
                            fallbackToLocalBuild: true,
                            totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                        },
                    );
                }
            } else {
                acquiredBuildLock = lockAcquireResult.lock;
            }

            const existingBuildAfterLockCheck = this.inFlightBuilds.get(cacheKey);
            if (existingBuildAfterLockCheck) {
                logSegmentedStreamingTrace("asset.ensure.inflight_active", {
                    trackId: input.trackId,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                    sourceKind,
                    cacheKey,
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                });
                return {
                    ...paths,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                };
            }

            if (this.invalidCacheKeys.has(cacheKey)) {
                this.invalidCacheKeys.delete(cacheKey);
                this.clearValidationMicrocacheForCacheKey(cacheKey);
                this.recoverableValidationFailures.delete(cacheKey);
                this.recoverableValidationRepairCooldownUntilMs.delete(cacheKey);
                this.invalidValidationRepairCooldownUntilMs.delete(cacheKey);
                await segmentedStreamingCacheService.removeDashAsset(cacheKey);
                logSegmentedStreamingTrace("asset.ensure.cache_invalidated", {
                    trackId: input.trackId,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                    sourceKind,
                    cacheKey,
                    totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                });
            }

            this.failedBuilds.delete(cacheKey);
            const buildPromise = this.generateDashAsset({
                ...normalizedInput,
                cacheKey,
                outputDir: paths.outputDir,
                manifestPath: paths.manifestPath,
            });
            const trackedBuildPromise = buildPromise
                .then((asset) => {
                    this.failedBuilds.delete(cacheKey);
                    this.invalidCacheKeys.delete(cacheKey);
                    this.clearValidationMicrocacheForCacheKey(cacheKey);
                    this.recoverableValidationFailures.delete(cacheKey);
                    this.recoverableValidationRepairCooldownUntilMs.delete(cacheKey);
                    this.invalidValidationRepairCooldownUntilMs.delete(cacheKey);
                    logSegmentedStreamingTrace("asset.ensure.generated", {
                        trackId: input.trackId,
                        quality: input.quality,
                        manifestProfile: normalizedInput.manifestProfile,
                        sourceKind,
                        cacheKey,
                        totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                    });
                    return asset;
                })
                .catch((error) => {
                    const resolvedError =
                        error instanceof Error ? error : new Error(String(error));
                    this.clearValidationMicrocacheForCacheKey(cacheKey);
                    this.failedBuilds.set(cacheKey, {
                        error: resolvedError,
                        failedAtMs: Date.now(),
                    });
                    logSegmentedStreamingTrace("asset.ensure.generate_error", {
                        trackId: input.trackId,
                        quality: input.quality,
                        manifestProfile: normalizedInput.manifestProfile,
                        sourceKind,
                        cacheKey,
                        totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
                        ...toSegmentedTraceErrorFields(error),
                    });
                    throw resolvedError;
                })
                .finally(async () => {
                    this.inFlightBuilds.delete(cacheKey);
                    this.pruneFailedBuilds();
                    if (acquiredBuildLock) {
                        await this.releaseDashBuildLock({
                            operation: "ensure",
                            cacheKey,
                            lock: acquiredBuildLock,
                        });
                    }
                });

            this.inFlightBuilds.set(cacheKey, trackedBuildPromise);
            releaseBuildLockWithTrackedPromise = Boolean(acquiredBuildLock);
            void trackedBuildPromise.catch(() => undefined);

            logSegmentedStreamingTrace("asset.ensure.build_started", {
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
                cacheKey,
                totalMs: segmentedTraceDurationMs(ensureStartedAtMs),
            });

            return {
                ...paths,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
            };
        } finally {
            if (acquiredBuildLock && !releaseBuildLockWithTrackedPromise) {
                await this.releaseDashBuildLock({
                    operation: "ensure",
                    cacheKey,
                    lock: acquiredBuildLock,
                });
            }
        }
    }

    hasInFlightBuild(cacheKey: string): boolean {
        return this.inFlightBuilds.has(cacheKey);
    }

    isCacheMarkedInvalid(cacheKey: string): boolean {
        return this.invalidCacheKeys.has(cacheKey);
    }

    async getBuildInFlightStatus(
        cacheKey: string,
    ): Promise<DashBuildInFlightStatus> {
        const localInFlight = this.hasInFlightBuild(cacheKey);
        if (localInFlight) {
            return {
                localInFlight: true,
                distributedInFlight: false,
                inFlight: true,
            };
        }

        const distributedInFlight =
            await this.hasDistributedDashBuildLock(cacheKey);

        return {
            localInFlight,
            distributedInFlight,
            inFlight: localInFlight || distributedInFlight,
        };
    }

    getBuildFailure(cacheKey: string): Error | null {
        this.pruneFailedBuilds();
        const failedBuild = this.failedBuilds.get(cacheKey);
        return failedBuild?.error ?? null;
    }

    async forceRegenerateDashSegments(
        input: EnsureLocalDashSegmentsInput,
    ): Promise<void> {
        const normalizedInput = {
            ...input,
            manifestProfile: resolveSegmentedDashManifestProfile(
                input.manifestProfile,
            ),
        };
        const cacheKey = this.buildDashCacheKey(normalizedInput);
        const existingBuild = this.inFlightBuilds.get(cacheKey);
        if (existingBuild) {
            logSegmentedStreamingTrace("asset.force_regenerate.inflight_skipped", {
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                cacheKey,
            });
            return;
        }

        const sourceKind = resolveSourceKind(input.sourcePath);
        const paths = segmentedStreamingCacheService.getDashAssetPaths(cacheKey);
        let acquiredBuildLock: DashBuildLock | null = null;
        let releaseBuildLockWithTrackedPromise = false;

        try {
            const lockAcquireResult = await this.acquireDashBuildLock({
                operation: "force_regenerate",
                cacheKey,
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
            });

            if (!lockAcquireResult.acquired) {
                if (!lockAcquireResult.unavailable) {
                    logSegmentedStreamingTrace(
                        "asset.force_regenerate.distributed_lock_conflict",
                        {
                            trackId: input.trackId,
                            quality: input.quality,
                            manifestProfile: normalizedInput.manifestProfile,
                            sourceKind,
                            cacheKey,
                        },
                    );
                    return;
                }
            } else {
                acquiredBuildLock = lockAcquireResult.lock;
            }

            const existingBuildAfterLockCheck = this.inFlightBuilds.get(cacheKey);
            if (existingBuildAfterLockCheck) {
                logSegmentedStreamingTrace("asset.force_regenerate.inflight_skipped", {
                    trackId: input.trackId,
                    quality: input.quality,
                    manifestProfile: normalizedInput.manifestProfile,
                    cacheKey,
                });
                return;
            }

            this.failedBuilds.delete(cacheKey);
            this.invalidCacheKeys.delete(cacheKey);
            this.clearValidationMicrocacheForCacheKey(cacheKey);
            this.recoverableValidationFailures.delete(cacheKey);
            this.recoverableValidationRepairCooldownUntilMs.delete(cacheKey);
            this.invalidValidationRepairCooldownUntilMs.delete(cacheKey);
            const buildPromise = this.generateForceRegeneratedDashAsset({
                ...normalizedInput,
                cacheKey,
                outputDir: paths.outputDir,
                manifestPath: paths.manifestPath,
            });
            const trackedBuildPromise = buildPromise
                .then((asset) => {
                    this.failedBuilds.delete(cacheKey);
                    this.invalidCacheKeys.delete(cacheKey);
                    this.markCacheValidationMicrocacheHit(cacheKey, "full");
                    this.recoverableValidationFailures.delete(cacheKey);
                    this.recoverableValidationRepairCooldownUntilMs.delete(cacheKey);
                    this.invalidValidationRepairCooldownUntilMs.delete(cacheKey);
                    logSegmentedStreamingTrace("asset.force_regenerate.completed", {
                        trackId: input.trackId,
                        quality: input.quality,
                        manifestProfile: normalizedInput.manifestProfile,
                        sourceKind,
                        cacheKey,
                    });
                    return asset;
                })
                .catch((error) => {
                    const resolvedError =
                        error instanceof Error ? error : new Error(String(error));
                    this.clearValidationMicrocacheForCacheKey(cacheKey);
                    this.failedBuilds.set(cacheKey, {
                        error: resolvedError,
                        failedAtMs: Date.now(),
                    });
                    logSegmentedStreamingTrace("asset.force_regenerate.error", {
                        trackId: input.trackId,
                        quality: input.quality,
                        manifestProfile: normalizedInput.manifestProfile,
                        sourceKind,
                        cacheKey,
                        ...toSegmentedTraceErrorFields(error),
                    });
                    throw resolvedError;
                })
                .finally(async () => {
                    this.inFlightBuilds.delete(cacheKey);
                    this.pruneFailedBuilds();
                    if (acquiredBuildLock) {
                        await this.releaseDashBuildLock({
                            operation: "force_regenerate",
                            cacheKey,
                            lock: acquiredBuildLock,
                        });
                    }
                });
            this.inFlightBuilds.set(cacheKey, trackedBuildPromise);
            releaseBuildLockWithTrackedPromise = Boolean(acquiredBuildLock);
            logSegmentedStreamingTrace("asset.force_regenerate.started", {
                trackId: input.trackId,
                quality: input.quality,
                manifestProfile: normalizedInput.manifestProfile,
                sourceKind,
                cacheKey,
            });
            void trackedBuildPromise.catch(() => undefined);
        } finally {
            if (acquiredBuildLock && !releaseBuildLockWithTrackedPromise) {
                await this.releaseDashBuildLock({
                    operation: "force_regenerate",
                    cacheKey,
                    lock: acquiredBuildLock,
                });
            }
        }
    }

    private buildDashCacheKey(input: EnsureLocalDashSegmentsInput): string {
        const manifestProfile = resolveSegmentedDashManifestProfile(
            input.manifestProfile,
        );
        const cacheIdentity = input.cacheIdentity?.trim() ||
            `${input.trackId}:${input.sourcePath}:${input.sourceModified.toISOString()}:manifest_profile:${manifestProfile}`;
        return segmentedStreamingCacheService.buildDashCacheKey({
            trackId: input.trackId,
            sourcePath: input.sourcePath,
            sourceModifiedIso: input.sourceModified.toISOString(),
            quality: input.quality,
            cacheIdentity,
        });
    }

    private buildDashBuildLockKey(cacheKey: string): string {
        return `${SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX}:${cacheKey}`;
    }

    private async hasDistributedDashBuildLock(cacheKey: string): Promise<boolean> {
        if (!this.buildLockRedisClient) {
            return false;
        }

        try {
            const exists = await this.buildLockRedisClient.exists(
                this.buildDashBuildLockKey(cacheKey),
            );
            return Number(exists) > 0;
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to check distributed DASH build lock; using local in-flight guard only",
                {
                    cacheKey,
                    error,
                },
            );
            return false;
        }
    }

    private async acquireDashBuildLock(params: {
        operation: DashBuildLockOperation;
        cacheKey: string;
        trackId: string;
        quality: SegmentedDashQuality;
        manifestProfile: SegmentedDashManifestProfile;
        sourceKind: "local" | "remote";
    }): Promise<DashBuildLockAcquireResult> {
        if (!this.buildLockRedisClient) {
            return {
                acquired: false,
                unavailable: true,
            };
        }

        const lockKey = this.buildDashBuildLockKey(params.cacheKey);
        const lockToken = `${dashBuildLockNodeId}:${Date.now()}:${Math.random()}`;
        const lockTtlSeconds = Math.max(1, Math.ceil(DASH_BUILD_LOCK_TTL_MS / 1000));

        try {
            const acquired = await this.buildLockRedisClient.set(
                lockKey,
                lockToken,
                "EX",
                lockTtlSeconds,
                "NX",
            );

            if (acquired !== "OK") {
                return {
                    acquired: false,
                    unavailable: false,
                };
            }

            return {
                acquired: true,
                lock: {
                    lockKey,
                    lockToken,
                },
            };
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to acquire distributed DASH build lock; using local in-flight guard only",
                {
                    operation: params.operation,
                    cacheKey: params.cacheKey,
                    error,
                },
            );
            logSegmentedStreamingTrace(
                `asset.${params.operation}.distributed_lock_error`,
                {
                    trackId: params.trackId,
                    quality: params.quality,
                    manifestProfile: params.manifestProfile,
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    ...toSegmentedTraceErrorFields(error),
                },
            );
            return {
                acquired: false,
                unavailable: true,
            };
        }
    }

    private async releaseDashBuildLock(params: {
        operation: DashBuildLockOperation;
        cacheKey: string;
        lock: DashBuildLock;
    }): Promise<void> {
        if (!this.buildLockRedisClient) {
            return;
        }

        try {
            await this.buildLockRedisClient.eval(
                DASH_BUILD_LOCK_RELEASE_LUA_SCRIPT,
                1,
                params.lock.lockKey,
                params.lock.lockToken,
            );
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to release distributed DASH build lock",
                {
                    operation: params.operation,
                    cacheKey: params.cacheKey,
                    error,
                },
            );
        }
    }

    private async generateForceRegeneratedDashAsset(params: {
        trackId: string;
        sourcePath: string;
        quality: SegmentedDashQuality;
        manifestProfile: SegmentedDashManifestProfile;
        cacheKey: string;
        outputDir: string;
        manifestPath: string;
    }): Promise<LocalDashSegmentAsset> {
        const sourceKind = resolveSourceKind(params.sourcePath);
        const operationId = buildForceRegenerateOperationId();
        const stagingCacheKey = `${params.cacheKey}.${FORCE_REGENERATE_STAGING_SUFFIX}.${operationId}`;
        const backupOutputDir = `${params.outputDir}.${FORCE_REGENERATE_BACKUP_SUFFIX}.${operationId}`;
        const stagingPaths = segmentedStreamingCacheService.getDashAssetPaths(
            stagingCacheKey,
        );
        let promoted = false;
        let liveMovedToBackup = false;

        try {
            await this.generateDashAsset({
                trackId: params.trackId,
                sourcePath: params.sourcePath,
                quality: params.quality,
                manifestProfile: params.manifestProfile,
                cacheKey: stagingCacheKey,
                outputDir: stagingPaths.outputDir,
                manifestPath: stagingPaths.manifestPath,
            });

            const stagedValidationResult = await this.validateDashAssetFiles(
                stagingCacheKey,
            );
            if (!stagedValidationResult.valid) {
                throw new Error(
                    `DASH staged regeneration validation failed (${stagedValidationResult.reason ?? "unknown"})`,
                );
            }

            const liveAssetExists = await pathExists(params.outputDir);
            if (liveAssetExists) {
                await fsPromises.rename(params.outputDir, backupOutputDir);
                liveMovedToBackup = true;
            }

            try {
                await fsPromises.rename(stagingPaths.outputDir, params.outputDir);
                promoted = true;
            } catch (error) {
                if (liveMovedToBackup) {
                    await this.tryRestoreForceRegenerateBackup({
                        backupOutputDir,
                        liveOutputDir: params.outputDir,
                        trackId: params.trackId,
                        quality: params.quality,
                        sourceKind,
                        cacheKey: params.cacheKey,
                    });
                }
                throw error;
            }

            if (liveMovedToBackup) {
                try {
                    await fsPromises.rm(backupOutputDir, {
                        recursive: true,
                        force: true,
                    });
                } catch (cleanupError) {
                    logger.warn(
                        "[SegmentedStreaming] Failed to remove prior DASH asset backup after regeneration",
                        {
                            cacheKey: params.cacheKey,
                            backupOutputDir,
                            error: cleanupError,
                        },
                    );
                }
            }

            return {
                cacheKey: params.cacheKey,
                outputDir: params.outputDir,
                manifestPath: params.manifestPath,
                quality: params.quality,
                manifestProfile: params.manifestProfile,
            };
        } finally {
            if (!promoted) {
                try {
                    await segmentedStreamingCacheService.removeDashAsset(
                        stagingCacheKey,
                    );
                } catch (cleanupError) {
                    logger.warn(
                        "[SegmentedStreaming] Failed to clean staged DASH regeneration assets",
                        {
                            cacheKey: params.cacheKey,
                            stagingCacheKey,
                            stagingOutputDir: stagingPaths.outputDir,
                            error: cleanupError,
                        },
                    );
                }
            }
        }
    }

    private async tryRestoreForceRegenerateBackup(params: {
        backupOutputDir: string;
        liveOutputDir: string;
        trackId: string;
        quality: SegmentedDashQuality;
        sourceKind: "local" | "remote";
        cacheKey: string;
    }): Promise<void> {
        try {
            await fsPromises.rename(params.backupOutputDir, params.liveOutputDir);
            logSegmentedStreamingTrace("asset.force_regenerate.rollback_restored", {
                trackId: params.trackId,
                quality: params.quality,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
            });
        } catch (restoreError) {
            logSegmentedStreamingTrace("asset.force_regenerate.rollback_error", {
                trackId: params.trackId,
                quality: params.quality,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
                ...toSegmentedTraceErrorFields(restoreError),
            });
            logger.error(
                "[SegmentedStreaming] Failed to restore prior DASH assets after regeneration promote error",
                {
                    cacheKey: params.cacheKey,
                    backupOutputDir: params.backupOutputDir,
                    liveOutputDir: params.liveOutputDir,
                    error: restoreError,
                },
            );
        }
    }

    private pruneFailedBuilds(): void {
        const now = Date.now();
        for (const [cacheKey, failure] of this.failedBuilds.entries()) {
            if (now - failure.failedAtMs > BUILD_FAILURE_RETENTION_MS) {
                this.failedBuilds.delete(cacheKey);
            }
        }
    }

    private resolveValidationSuccessTtlMs(mode: DashAssetValidationMode): number {
        if (mode === "full") {
            return FULL_CACHE_VALIDATION_SUCCESS_TTL_MS;
        }
        return STARTUP_CACHE_VALIDATION_SUCCESS_TTL_MS;
    }

    private buildValidationMicrocacheKey(
        cacheKey: string,
        mode: DashAssetValidationMode,
    ): string {
        return `${mode}:${cacheKey}`;
    }

    private buildValidationInFlightKey(
        cacheKey: string,
        mode: DashAssetValidationMode,
    ): string {
        return `${mode}:${cacheKey}`;
    }

    private clearValidationMicrocacheForCacheKey(cacheKey: string): void {
        this.validCacheValidationMicrocache.delete(
            this.buildValidationMicrocacheKey(cacheKey, "startup"),
        );
        this.validCacheValidationMicrocache.delete(
            this.buildValidationMicrocacheKey(cacheKey, "full"),
        );
    }

    private hasValidCacheValidationMicrocacheHit(
        cacheKey: string,
        mode: DashAssetValidationMode,
    ): boolean {
        const microcacheKey = this.buildValidationMicrocacheKey(cacheKey, mode);
        const expiresAtMs = this.validCacheValidationMicrocache.get(microcacheKey);
        if (expiresAtMs === undefined) {
            return false;
        }

        if (expiresAtMs <= Date.now()) {
            this.validCacheValidationMicrocache.delete(microcacheKey);
            return false;
        }

        return true;
    }

    private markCacheValidationMicrocacheHit(
        cacheKey: string,
        mode: DashAssetValidationMode,
    ): void {
        this.validCacheValidationMicrocache.set(
            this.buildValidationMicrocacheKey(cacheKey, mode),
            Date.now() + this.resolveValidationSuccessTtlMs(mode),
        );
        if (mode === "full") {
            this.validCacheValidationMicrocache.set(
                this.buildValidationMicrocacheKey(cacheKey, "startup"),
                Date.now() + this.resolveValidationSuccessTtlMs("startup"),
            );
        }
    }

    private async validateCachedDashAssetIfNeeded(params: {
        cacheKey: string;
        trackId: string;
        quality: SegmentedDashQuality;
        manifestProfile?: SegmentedDashManifestProfile;
        sourceKind: "local" | "remote";
        mode?: DashAssetValidationMode;
        phase?: DashAssetValidationPhase;
    }): Promise<boolean> {
        const mode = params.mode ?? "full";
        const phase = params.phase ?? "foreground";
        if (this.invalidCacheKeys.has(params.cacheKey)) {
            return false;
        }

        if (this.hasValidCacheValidationMicrocacheHit(params.cacheKey, mode)) {
            return true;
        }

        const inFlightValidationKey = this.buildValidationInFlightKey(
            params.cacheKey,
            mode,
        );
        const existingValidation = this.inFlightValidations.get(inFlightValidationKey);
        if (existingValidation) {
            return await existingValidation;
        }

        const validationPromise = this.validateCachedDashAsset({
            ...params,
            mode,
            phase,
        })
            .catch((error) => {
                this.invalidCacheKeys.add(params.cacheKey);
                this.clearValidationMicrocacheForCacheKey(params.cacheKey);
                this.recoverableValidationFailures.delete(params.cacheKey);
                this.recoverableValidationRepairCooldownUntilMs.delete(
                    params.cacheKey,
                );
                this.invalidValidationRepairCooldownUntilMs.delete(params.cacheKey);
                logSegmentedStreamingTrace("asset.validate.cache_error", {
                    trackId: params.trackId,
                    quality: params.quality,
                    manifestProfile: params.manifestProfile,
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    validationMode: mode,
                    validationPhase: phase,
                    ...toSegmentedTraceErrorFields(error),
                });
                return false;
            })
            .finally(() => {
                if (
                    this.inFlightValidations.get(inFlightValidationKey) ===
                    validationPromise
                ) {
                    this.inFlightValidations.delete(inFlightValidationKey);
                }
            });

        this.inFlightValidations.set(inFlightValidationKey, validationPromise);
        return await validationPromise;
    }

    private async validateCachedDashAsset(params: {
        cacheKey: string;
        trackId: string;
        quality: SegmentedDashQuality;
        manifestProfile?: SegmentedDashManifestProfile;
        sourceKind: "local" | "remote";
        mode?: DashAssetValidationMode;
        phase?: DashAssetValidationPhase;
    }): Promise<boolean> {
        const mode = params.mode ?? "full";
        const phase = params.phase ?? "foreground";
        const startedAtMs = Date.now();
        const result = await this.validateDashAssetFiles(params.cacheKey, mode);
        if (result.valid) {
            this.invalidCacheKeys.delete(params.cacheKey);
            this.markCacheValidationMicrocacheHit(params.cacheKey, mode);
            this.recoverableValidationFailures.delete(params.cacheKey);
            this.recoverableValidationRepairCooldownUntilMs.delete(params.cacheKey);
            this.invalidValidationRepairCooldownUntilMs.delete(params.cacheKey);
            logSegmentedStreamingTrace("asset.validate.cache_ok", {
                trackId: params.trackId,
                quality: params.quality,
                manifestProfile: params.manifestProfile,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
                validationMode: mode,
                validationPhase: phase,
                segmentCount: result.segmentCount,
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });
            return true;
        }

        if (this.shouldTreatValidationFailureAsRecoverable(result)) {
            this.invalidCacheKeys.delete(params.cacheKey);
            this.markCacheValidationMicrocacheHit(params.cacheKey, mode);
            this.recoverableValidationFailures.set(params.cacheKey, {
                reason: result.reason ?? "unknown",
                segmentName: result.segmentName,
                segmentCount: result.segmentCount,
                detectedAtMs: Date.now(),
            });
            logSegmentedStreamingTrace("asset.validate.cache_degraded", {
                trackId: params.trackId,
                quality: params.quality,
                manifestProfile: params.manifestProfile,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
                validationMode: mode,
                validationPhase: phase,
                reason: result.reason,
                segmentName: result.segmentName,
                segmentCount: result.segmentCount,
                startupCriticalSegment: this.isStartupCriticalSegmentName(
                    result.segmentName,
                ),
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });
            return true;
        }

        this.clearValidationMicrocacheForCacheKey(params.cacheKey);
        this.invalidCacheKeys.add(params.cacheKey);
        this.recoverableValidationFailures.delete(params.cacheKey);
        this.recoverableValidationRepairCooldownUntilMs.delete(params.cacheKey);
        this.invalidValidationRepairCooldownUntilMs.delete(params.cacheKey);
        logSegmentedStreamingTrace("asset.validate.cache_invalid", {
            trackId: params.trackId,
            quality: params.quality,
            manifestProfile: params.manifestProfile,
            sourceKind: params.sourceKind,
            cacheKey: params.cacheKey,
            validationMode: mode,
            validationPhase: phase,
            reason: result.reason,
            segmentName: result.segmentName,
            segmentCount: result.segmentCount,
            totalMs: segmentedTraceDurationMs(startedAtMs),
        });
        return false;
    }

    private shouldTreatValidationFailureAsRecoverable(result: {
        reason?: string;
        segmentName?: string;
    }): boolean {
        return (
            result.reason === "segment_too_small" &&
            !this.isStartupCriticalSegmentName(result.segmentName)
        );
    }

    private isStartupCriticalSegmentName(segmentName?: string): boolean {
        if (!segmentName) {
            return true;
        }

        const normalizedSegmentName = segmentName.trim().toLowerCase();
        if (!normalizedSegmentName || normalizedSegmentName.startsWith("init-")) {
            return true;
        }

        const segmentMatch = normalizedSegmentName.match(
            /^chunk-[^-]+-(\d+)\.(?:m4s|webm)$/,
        );
        if (!segmentMatch) {
            return true;
        }

        const parsedIndex = Number.parseInt(segmentMatch[1], 10);
        if (!Number.isFinite(parsedIndex)) {
            return true;
        }

        return parsedIndex <= STARTUP_CRITICAL_SEGMENT_MAX_INDEX;
    }

    private queueBackgroundCacheValidation(params: {
        input: EnsureLocalDashSegmentsInput;
        cacheKey: string;
        sourceKind: "local" | "remote";
    }): void {
        if (
            this.invalidCacheKeys.has(params.cacheKey) ||
            this.hasValidCacheValidationMicrocacheHit(params.cacheKey, "full")
        ) {
            return;
        }

        logSegmentedStreamingTrace("asset.ensure.cache_validation_queued", {
            trackId: params.input.trackId,
            quality: params.input.quality,
            manifestProfile: params.input.manifestProfile,
            sourceKind: params.sourceKind,
            cacheKey: params.cacheKey,
            validationMode: "full",
            validationPhase: "background",
        });

        void this.validateCachedDashAssetIfNeeded({
            cacheKey: params.cacheKey,
            trackId: params.input.trackId,
            quality: params.input.quality,
            manifestProfile: params.input.manifestProfile,
            sourceKind: params.sourceKind,
            mode: "full",
            phase: "background",
        })
            .then((cacheValidationPassed) => {
                if (!cacheValidationPassed) {
                    this.queueInvalidValidationRepair(params);
                    return;
                }

                const recoverableValidationFailure =
                    this.recoverableValidationFailures.get(params.cacheKey);
                if (recoverableValidationFailure) {
                    this.queueRecoverableValidationRepair({
                        input: params.input,
                        cacheKey: params.cacheKey,
                        sourceKind: params.sourceKind,
                        failure: recoverableValidationFailure,
                    });
                }
            })
            .catch((error) => {
                logSegmentedStreamingTrace("asset.ensure.cache_validation_error", {
                    trackId: params.input.trackId,
                    quality: params.input.quality,
                    manifestProfile: params.input.manifestProfile,
                    sourceKind: params.sourceKind,
                    cacheKey: params.cacheKey,
                    validationMode: "full",
                    validationPhase: "background",
                    ...toSegmentedTraceErrorFields(error),
                });
            });
    }

    private queueInvalidValidationRepair(params: {
        input: EnsureLocalDashSegmentsInput;
        cacheKey: string;
        sourceKind: "local" | "remote";
    }): void {
        const now = Date.now();
        const cooldownUntilMs =
            this.invalidValidationRepairCooldownUntilMs.get(params.cacheKey) ?? 0;
        if (cooldownUntilMs > now) {
            return;
        }

        this.invalidValidationRepairCooldownUntilMs.set(
            params.cacheKey,
            now + RECOVERABLE_VALIDATION_REPAIR_COOLDOWN_MS,
        );
        logSegmentedStreamingTrace("asset.ensure.cache_invalid_repair_queued", {
            trackId: params.input.trackId,
            quality: params.input.quality,
            manifestProfile: params.input.manifestProfile,
            sourceKind: params.sourceKind,
            cacheKey: params.cacheKey,
        });

        void this.forceRegenerateDashSegments(params.input).catch((error) => {
            logSegmentedStreamingTrace("asset.ensure.cache_invalid_repair_error", {
                trackId: params.input.trackId,
                quality: params.input.quality,
                manifestProfile: params.input.manifestProfile,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
                ...toSegmentedTraceErrorFields(error),
            });
        });
    }

    private queueRecoverableValidationRepair(params: {
        input: EnsureLocalDashSegmentsInput;
        cacheKey: string;
        sourceKind: "local" | "remote";
        failure: RecoverableCacheValidationFailure;
    }): void {
        const now = Date.now();
        const cooldownUntilMs =
            this.recoverableValidationRepairCooldownUntilMs.get(params.cacheKey) ?? 0;
        if (cooldownUntilMs > now) {
            return;
        }

        this.recoverableValidationRepairCooldownUntilMs.set(
            params.cacheKey,
            now + RECOVERABLE_VALIDATION_REPAIR_COOLDOWN_MS,
        );
        logSegmentedStreamingTrace("asset.ensure.cache_repair_queued", {
            trackId: params.input.trackId,
            quality: params.input.quality,
            manifestProfile: params.input.manifestProfile,
            sourceKind: params.sourceKind,
            cacheKey: params.cacheKey,
            reason: params.failure.reason,
            segmentName: params.failure.segmentName,
            segmentCount: params.failure.segmentCount,
            validationAgeMs: now - params.failure.detectedAtMs,
        });

        void this.forceRegenerateDashSegments(params.input).catch((error) => {
            logSegmentedStreamingTrace("asset.ensure.cache_repair_error", {
                trackId: params.input.trackId,
                quality: params.input.quality,
                manifestProfile: params.input.manifestProfile,
                sourceKind: params.sourceKind,
                cacheKey: params.cacheKey,
                reason: params.failure.reason,
                segmentName: params.failure.segmentName,
                segmentCount: params.failure.segmentCount,
                ...toSegmentedTraceErrorFields(error),
            });
        });
    }

    private resolveStartupSegmentTarget(segmentNames: string[]): {
        representationId: string;
        extension: DashSegmentFileExtension;
    } | null {
        let fallbackTarget:
            | {
                representationId: string;
                extension: DashSegmentFileExtension;
            }
            | null = null;

        for (const segmentName of segmentNames) {
            const match = segmentName.match(/^init-([A-Za-z0-9_-]+)\.(m4s|webm)$/i);
            if (!match) {
                continue;
            }

            const target = {
                representationId: match[1],
                extension: match[2].toLowerCase() as DashSegmentFileExtension,
            };
            if (target.representationId === "0") {
                return target;
            }
            if (!fallbackTarget) {
                fallbackTarget = target;
            }
        }

        return fallbackTarget;
    }

    private async validateDashSegmentFile(params: {
        outputDir: string;
        segmentName: string;
        segmentCount: number;
    }): Promise<DashAssetValidationResult | null> {
        const segmentPath = `${params.outputDir}/${params.segmentName}`;
        let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
        try {
            stat = await fsPromises.stat(segmentPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return {
                    valid: false,
                    reason: "segment_missing",
                    segmentName: params.segmentName,
                    segmentCount: params.segmentCount,
                };
            }
            throw error;
        }
        if (!stat.isFile()) {
            return {
                valid: false,
                reason: "segment_not_file",
                segmentName: params.segmentName,
                segmentCount: params.segmentCount,
            };
        }
        if (stat.size < DASH_MIN_SEGMENT_FILE_BYTES) {
            return {
                valid: false,
                reason: "segment_too_small",
                segmentName: params.segmentName,
                segmentCount: params.segmentCount,
            };
        }

        const lowerName = params.segmentName.toLowerCase();
        if (!lowerName.endsWith(".m4s") || lowerName.startsWith("init-")) {
            return null;
        }

        const probeBytes = await this.readSegmentProbeBytes(segmentPath);
        if (!probeBytes.includes(Buffer.from("moof"))) {
            return {
                valid: false,
                reason: "segment_missing_moof",
                segmentName: params.segmentName,
                segmentCount: params.segmentCount,
            };
        }
        if (!probeBytes.includes(Buffer.from("mdat"))) {
            return {
                valid: false,
                reason: "segment_missing_mdat",
                segmentName: params.segmentName,
                segmentCount: params.segmentCount,
            };
        }

        return null;
    }

    private async validateDashAssetFiles(
        cacheKey: string,
        mode: DashAssetValidationMode = "full",
    ): Promise<DashAssetValidationResult> {
        const manifestExists = await segmentedStreamingCacheService.hasDashManifest(
            cacheKey,
        );
        if (!manifestExists) {
            return {
                valid: false,
                reason: "manifest_missing",
                segmentCount: 0,
            };
        }

        const segmentNames = await segmentedStreamingCacheService.listDashSegments(
            cacheKey,
        );
        if (segmentNames.length === 0) {
            return {
                valid: false,
                reason: "segments_missing",
                segmentCount: 0,
            };
        }

        const outputDir = segmentedStreamingCacheService.getDashAssetPaths(
            cacheKey,
        ).outputDir;

        if (mode === "startup") {
            const startupTarget = this.resolveStartupSegmentTarget(segmentNames);
            if (!startupTarget) {
                return {
                    valid: false,
                    reason: "startup_representation_missing",
                    segmentCount: segmentNames.length,
                };
            }

            const requiredStartupSegments = [
                `init-${startupTarget.representationId}.${startupTarget.extension}`,
                ...Array.from(
                    { length: STARTUP_CRITICAL_SEGMENT_MAX_INDEX },
                    (_, offset) =>
                        `chunk-${startupTarget.representationId}-${String(
                            offset + 1,
                        ).padStart(5, "0")}.${startupTarget.extension}`,
                ),
            ];
            const availableSegmentNames = new Set(segmentNames);
            for (const requiredSegmentName of requiredStartupSegments) {
                if (!availableSegmentNames.has(requiredSegmentName)) {
                    return {
                        valid: false,
                        reason: "startup_segment_missing",
                        segmentName: requiredSegmentName,
                        segmentCount: segmentNames.length,
                    };
                }
            }

            for (const requiredSegmentName of requiredStartupSegments) {
                const validationFailure = await this.validateDashSegmentFile({
                    outputDir,
                    segmentName: requiredSegmentName,
                    segmentCount: segmentNames.length,
                });
                if (validationFailure) {
                    return validationFailure;
                }
            }

            return {
                valid: true,
                segmentCount: segmentNames.length,
            };
        }

        for (const segmentName of segmentNames) {
            const validationFailure = await this.validateDashSegmentFile({
                outputDir,
                segmentName,
                segmentCount: segmentNames.length,
            });
            if (validationFailure) {
                return validationFailure;
            }
        }

        return {
            valid: true,
            segmentCount: segmentNames.length,
        };
    }

    private async readSegmentProbeBytes(segmentPath: string): Promise<Buffer> {
        const fileHandle = await fsPromises.open(segmentPath, "r");
        try {
            const probeBuffer = Buffer.alloc(DASH_SEGMENT_VALIDATION_SCAN_BYTES);
            const { bytesRead } = await fileHandle.read(
                probeBuffer,
                0,
                probeBuffer.length,
                0,
            );
            return probeBuffer.subarray(0, bytesRead);
        } finally {
            await fileHandle.close();
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

    private resolveDashMuxerArgs(params: {
        segmentContainer: DashSegmentContainer;
    }): string[] {
        const { segmentContainer } = params;
        if (segmentContainer === "webm") {
            return ["-dash_segment_type", "webm"];
        }

        let dashArgs = [
            "-streaming",
            "1",
            "-ldash",
            "1",
            "-window_size",
            "0",
            "-extra_window_size",
            "0",
            "-remove_at_exit",
            "0",
            "-start_number",
            "1",
        ];
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

    private async normalizeDashManifestCodecCasing(
        manifestPath: string,
    ): Promise<void> {
        if (!(await pathExists(manifestPath))) {
            return;
        }

        try {
            const manifest = await fsPromises.readFile(manifestPath, "utf8");
            if (!manifest.includes(DASH_CODEC_ATTRIBUTE_FLAC)) {
                return;
            }

            const normalizedManifest = manifest.replace(
                /codecs="flac"/g,
                DASH_CODEC_ATTRIBUTE_FLAC_CANONICAL,
            );
            if (normalizedManifest !== manifest) {
                await fsPromises.writeFile(manifestPath, normalizedManifest, "utf8");
            }
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to normalize DASH manifest FLAC codec casing",
                {
                    manifestPath,
                    ...toSegmentedTraceErrorFields(error),
                },
            );
        }
    }

    private async generateDashAsset(params: {
        trackId: string;
        sourcePath: string;
        quality: SegmentedDashQuality;
        manifestProfile: SegmentedDashManifestProfile;
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
            manifestProfile: params.manifestProfile,
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
            "-fflags",
            "+genpts",
            "-i",
            params.sourcePath,
            "-vn",
            ...ffmpegMapArgs,
            ...ffmpegRepresentationArgs,
            ...(requiresExperimentalMuxing ? ["-strict", "-2"] : []),
            "-f",
            "dash",
            ...this.resolveDashMuxerArgs({
                segmentContainer: encodingPlan.segmentContainer,
            }),
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
            manifestProfile: params.manifestProfile,
            sourceKind,
            cacheKey: params.cacheKey,
            bitrateKbps: encodingPlan.targetRepresentation.bitrateKbps,
            transcodeMode: encodingPlan.targetRepresentation.audioCodec,
            segmentContainer: encodingPlan.segmentContainer,
            segmentDurationSec,
            representationCount: encodingPlan.representations.length,
            fallbackBitrateKbps: encodingPlan.fallbackRepresentation?.bitrateKbps,
            fallbackCodec: encodingPlan.fallbackRepresentation?.audioCodec,
            ensureDirMs,
        });

        await this.runFfmpegWithCompatibilityFallback({
            trackId: params.trackId,
            quality: params.quality,
            manifestProfile: params.manifestProfile,
            sourceKind,
            cacheKey: params.cacheKey,
            outputDir: params.outputDir,
            ffmpegArgs,
        });

        if (!(await segmentedStreamingCacheService.hasDashManifest(params.cacheKey))) {
            logSegmentedStreamingTrace("asset.generate.missing_manifest", {
                trackId: params.trackId,
                quality: params.quality,
                manifestProfile: params.manifestProfile,
                sourceKind,
                cacheKey: params.cacheKey,
                totalMs: segmentedTraceDurationMs(generationStartedAtMs),
            });
            throw new Error("DASH segment generation completed without manifest");
        }

        await this.normalizeDashManifestCodecCasing(params.manifestPath);

        logSegmentedStreamingTrace("asset.generate.done", {
            trackId: params.trackId,
            quality: params.quality,
            manifestProfile: params.manifestProfile,
            sourceKind,
            cacheKey: params.cacheKey,
            totalMs: segmentedTraceDurationMs(generationStartedAtMs),
        });

        return {
            cacheKey: params.cacheKey,
            outputDir: params.outputDir,
            manifestPath: params.manifestPath,
            quality: params.quality,
            manifestProfile: params.manifestProfile,
        };
    }

    private async runFfmpegWithCompatibilityFallback(params: {
        trackId: string;
        quality: SegmentedDashQuality;
        manifestProfile: SegmentedDashManifestProfile;
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
                    manifestProfile: params.manifestProfile,
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
        manifestProfile: SegmentedDashManifestProfile;
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
                    manifestProfile: params.manifestProfile,
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
                    manifestProfile: params.manifestProfile,
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
                        manifestProfile: params.manifestProfile,
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
                    manifestProfile: params.manifestProfile,
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
        manifestProfile: SegmentedDashManifestProfile;
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
        const fallbackRepresentation =
            params.manifestProfile === "startup_single"
                ? null
                : this.resolveSteadyStateFallbackRepresentation(
                    params.quality,
                    targetRepresentation,
                );
        const representations = fallbackRepresentation
            ? [targetRepresentation, fallbackRepresentation]
            : [targetRepresentation];

        return {
            targetRepresentation,
            fallbackRepresentation,
            representations,
            segmentContainer: "fmp4",
            initSegmentName: "init-$RepresentationID$.m4s",
            mediaSegmentName: "chunk-$RepresentationID$-$Number%05d$.m4s",
        };
    }

    private resolveSteadyStateFallbackRepresentation(
        quality: SegmentedDashQuality,
        targetRepresentation: DashAudioRepresentation,
    ): DashAudioRepresentation {
        if (quality === "original" && targetRepresentation.audioCodec === "flac") {
            return {
                audioCodec: "aac",
                bitrateKbps: DASH_QUALITY_BITRATES.high,
                useExperimentalMuxing: false,
            };
        }

        if (quality === "original" || quality === "high") {
            return {
                audioCodec: "aac",
                bitrateKbps: DASH_QUALITY_BITRATES.medium,
                useExperimentalMuxing: false,
            };
        }

        if (quality === "medium") {
            return {
                audioCodec: "aac",
                bitrateKbps: DASH_QUALITY_BITRATES.low,
                useExperimentalMuxing: false,
            };
        }

        return {
            audioCodec: "aac",
            bitrateKbps: DASH_LOWEST_FALLBACK_REPRESENTATION_BITRATE_KBPS,
            useExperimentalMuxing: false,
        };
    }
}

export const segmentedSegmentService = new SegmentedSegmentService();
