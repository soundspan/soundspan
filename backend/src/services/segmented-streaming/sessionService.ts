import { promises as fsPromises } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import {
    segmentedManifestService,
    type SegmentedManifestQuality,
    type SegmentedManifestProfile,
} from "./manifestService";
import { segmentedStreamingCacheService } from "./cacheService";
import {
    LOSSLESS_FILE_EXTENSION_REGEX,
    segmentedSegmentService,
} from "./segmentService";
import {
    logSegmentedStreamingTrace,
    segmentedTraceDurationMs,
    toSegmentedTraceErrorFields,
} from "./trace";
import type { SegmentedStreamingSourceType } from "@soundspan/media-metadata-contract";

const SESSION_KEY_PREFIX = "streaming:session:v1:";
const SESSION_TTL_SECONDS = 5 * 60;
const SEGMENT_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.(m4s|webm)$/;
const SESSION_TOKEN_TYPE = "segmented-streaming-session-v1";
const SESSION_TOKEN_SECRET =
    process.env.JWT_SECRET || process.env.SESSION_SECRET || config.sessionSecret;
export const SEGMENTED_SESSION_TOKEN_QUERY_PARAM = "st";
const ASSET_READY_POLL_INITIAL_INTERVAL_MS = 25;
const ASSET_READY_POLL_MAX_INTERVAL_MS = 200;
const ASSET_READY_POLL_BACKOFF_MULTIPLIER = 1.5;
const ASSET_READY_POLL_JITTER_FACTOR = 0.2;
const ASSET_READY_POLL_MIN_REMAINING_WINDOW_SAMPLES = 6;
const ASSET_READY_TIMEOUT_MS = 20_000;
const ASSET_CROSS_POD_GRACE_MS = 5_000;
const READINESS_MICROCACHE_TTL_MS = 1_500;
const STARTUP_MIN_TIMELINE_SEGMENTS = 3;
const STARTUP_SEGMENT_EXTENSIONS = ["m4s", "webm"] as const;

const SEGMENTED_QUALITY_VALUES = [
    "original",
    "high",
    "medium",
    "low",
] as const;
const SEGMENTED_SESSION_MANIFEST_PROFILE_VALUES = [
    "startup_single",
    "steady_state_dual",
] as const;
const SEGMENTED_SOURCE_TYPE_VALUES: ReadonlyArray<SegmentedStreamingSourceType> = [
    "local",
];
const DEFAULT_SEGMENTED_SESSION_MANIFEST_PROFILE: SegmentedSessionManifestProfile =
    "steady_state_dual";

export type SegmentedSessionQuality = (typeof SEGMENTED_QUALITY_VALUES)[number];
export type SegmentedSessionManifestProfile =
    (typeof SEGMENTED_SESSION_MANIFEST_PROFILE_VALUES)[number];
export type SegmentedSessionSourceType = SegmentedStreamingSourceType;

export interface CreateLocalSegmentedSessionInput {
    userId: string;
    trackId: string;
    desiredQuality?: SegmentedSessionQuality;
    manifestProfile?: SegmentedSessionManifestProfile;
}

export interface SegmentedSessionRecord {
    sessionId: string;
    userId: string;
    trackId: string;
    cacheKey: string;
    quality: SegmentedSessionQuality;
    manifestProfile: SegmentedSessionManifestProfile;
    sourceType: SegmentedSessionSourceType;
    playbackCodec?: "aac" | "flac";
    playbackBitrateKbps?: number | null;
    manifestPath: string;
    assetDir: string;
    createdAt: string;
    expiresAt: string;
    lastHeartbeatAt?: string;
    lastKnownPositionSec?: number;
    lastKnownIsPlaying?: boolean;
}

export interface SegmentedSessionResponse {
    sessionId: string;
    manifestUrl: string;
    sessionToken: string;
    expiresAt: string;
    playbackProfile: {
        protocol: "dash";
        sourceType: SegmentedSessionSourceType;
        quality: SegmentedSessionQuality;
        manifestProfile: SegmentedSessionManifestProfile;
        codec: "aac" | "flac";
        bitrateKbps: number | null;
    };
    engineHints: {
        protocol: "dash";
        sourceType: SegmentedSessionSourceType;
        recommendedEngine: "videojs";
        assetBuildInFlight?: boolean;
    };
}

export interface SegmentedSessionSnapshotInput {
    positionSec?: number;
    isPlaying?: boolean;
    bufferedUntilSec?: number;
}

export interface SegmentedSessionHeartbeatResponse {
    sessionId: string;
    sessionToken: string;
    expiresAt: string;
}

export interface SegmentedSessionHandoffResponse extends SegmentedSessionResponse {
    previousSessionId: string;
    resumeAtSec: number;
    shouldPlay: boolean;
}

export class SegmentedSessionError extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, statusCode: number, code: string) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

interface SegmentedSessionTokenPayload extends JwtPayload {
    type: typeof SESSION_TOKEN_TYPE;
    sessionId: string;
    userId: string;
    trackId: string;
    quality: SegmentedSessionQuality;
    sourceType: SegmentedSessionSourceType;
}

interface ValidateSessionTokenOptions {
    allowSessionIdMismatch?: boolean;
}

interface ReadinessPollBackoffState {
    nextBaseDelayMs: number;
}

class SegmentedSessionService {
    private readonly inMemorySessions = new Map<string, SegmentedSessionRecord>();
    private readonly manifestReadyInFlight = new Map<string, Promise<void>>();
    private readonly segmentReadyInFlight = new Map<string, Promise<void>>();
    private readonly segmentReadyMicrocache = new Map<string, number>();
    private readonly playbackErrorRepairInFlight = new Map<string, Promise<void>>();
    private readonly playbackErrorRepairQueued = new Set<string>();

    async createLocalSession(
        input: CreateLocalSegmentedSessionInput,
    ): Promise<SegmentedSessionResponse> {
        const startedAtMs = Date.now();
        let phase = "track_lookup";
        let trackLookupMs: number | undefined;
        let sourceAccessMs: number | undefined;
        let assetBuildMs: number | undefined;
        let persistMs: number | undefined;
        const quality = await this.resolveQualityForUser(
            input.userId,
            input.desiredQuality,
        );
        const manifestProfile = this.resolveManifestProfileForRequest(
            input.manifestProfile,
        );

        try {
            const trackLookupStartedAtMs = Date.now();
            const track = await prisma.track.findUnique({
                where: { id: input.trackId },
                select: {
                    id: true,
                    filePath: true,
                    fileModified: true,
                },
            });
            trackLookupMs = segmentedTraceDurationMs(trackLookupStartedAtMs);

            if (!track) {
                throw new SegmentedSessionError("Track not found", 404, "TRACK_NOT_FOUND");
            }

            if (!track.filePath || !track.fileModified) {
                throw new SegmentedSessionError(
                    "Track is not available for segmented local playback",
                    404,
                    "TRACK_NOT_LOCALLY_AVAILABLE",
                );
            }

            const normalizedFilePath = track.filePath.replace(/\\/g, "/");
            const sourcePath = path.join(config.music.musicPath, normalizedFilePath);
            phase = "source_access";
            const sourceAccessStartedAtMs = Date.now();

            try {
                await fsPromises.access(sourcePath);
                sourceAccessMs = segmentedTraceDurationMs(sourceAccessStartedAtMs);
            } catch {
                sourceAccessMs = segmentedTraceDurationMs(sourceAccessStartedAtMs);
                throw new SegmentedSessionError(
                    "Track source file was not found on disk",
                    404,
                    "TRACK_SOURCE_MISSING",
                );
            }

            phase = "asset_build";
            const assetBuildStartedAtMs = Date.now();
            const asset = await segmentedManifestService.getOrCreateLocalDashAsset({
                trackId: track.id,
                sourcePath,
                sourceModified: track.fileModified,
                quality: quality as SegmentedManifestQuality,
                manifestProfile: manifestProfile as SegmentedManifestProfile,
            });
            assetBuildMs = segmentedTraceDurationMs(assetBuildStartedAtMs);

            const sessionId = randomUUID();
            const createdAt = new Date();
            const expiresAt = new Date(
                createdAt.getTime() + SESSION_TTL_SECONDS * 1000,
            );

            const sessionRecord: SegmentedSessionRecord = {
                sessionId,
                userId: input.userId,
                trackId: track.id,
                cacheKey: asset.cacheKey,
                quality,
                manifestProfile,
                sourceType: "local",
                ...resolveSessionPlaybackProfile({
                    quality,
                    sourceType: "local",
                    sourceFilePath: track.filePath,
                }),
                manifestPath: asset.manifestPath,
                assetDir: asset.outputDir,
                createdAt: createdAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
            };

            phase = "persist_session";
            const persistStartedAtMs = Date.now();
            await this.persistSession(sessionRecord);
            persistMs = segmentedTraceDurationMs(persistStartedAtMs);
            segmentedStreamingCacheService.registerSessionReference(
                sessionRecord.cacheKey,
                sessionRecord.sessionId,
            );
            const assetBuildInFlight = await this.hasAssetBuildInFlight(
                sessionRecord.cacheKey,
            );

            logSegmentedStreamingTrace("session.local.create_success", {
                trackId: track.id,
                quality,
                manifestProfile,
                cacheKey: sessionRecord.cacheKey,
                trackLookupMs,
                sourceAccessMs,
                assetBuildMs,
                persistMs,
                assetBuildInFlight,
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });
            return this.toSessionResponse(sessionRecord, {
                assetBuildInFlight,
            });
        } catch (error) {
            logSegmentedStreamingTrace("session.local.create_error", {
                trackId: input.trackId,
                quality,
                manifestProfile,
                phase,
                trackLookupMs,
                sourceAccessMs,
                assetBuildMs,
                persistMs,
                totalMs: segmentedTraceDurationMs(startedAtMs),
                ...toSegmentedTraceErrorFields(error),
            });
            throw error;
        }
    }

    async getAuthorizedSession(
        sessionId: string,
        userId: string,
    ): Promise<SegmentedSessionRecord | null> {
        const session = await this.readSession(sessionId);
        if (!session) {
            return null;
        }

        if (session.userId !== userId) {
            return null;
        }

        const expiresAtMs = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
            await this.deleteSession(sessionId);
            return null;
        }

        return session;
    }

    validateSessionToken(
        session: SegmentedSessionRecord,
        sessionToken: string | null | undefined,
        options: ValidateSessionTokenOptions = {},
    ): void {
        const normalizedToken = sessionToken?.trim();
        if (!normalizedToken) {
            throw new SegmentedSessionError(
                "Session token is required",
                401,
                "STREAMING_SESSION_TOKEN_REQUIRED",
            );
        }

        let payload: SegmentedSessionTokenPayload;
        try {
            payload = this.decodeSessionToken(normalizedToken);
        } catch (error) {
            if (
                !(error instanceof SegmentedSessionError) ||
                error.code !== "STREAMING_SESSION_TOKEN_EXPIRED"
            ) {
                throw error;
            }

            // Allow expired token claims for active sessions so in-flight segment
            // requests can continue while heartbeat-issued tokens rotate.
            payload = this.decodeSessionTokenIgnoringExpiration(normalizedToken);
        }

        const scopeMatches =
            payload.userId === session.userId &&
            payload.trackId === session.trackId &&
            payload.quality === session.quality &&
            payload.sourceType === session.sourceType;
        const sessionIdMatches = payload.sessionId === session.sessionId;

        if (!scopeMatches) {
            throw new SegmentedSessionError(
                "Session token scope mismatch",
                403,
                "STREAMING_SESSION_TOKEN_SCOPE_MISMATCH",
            );
        }

        if (!sessionIdMatches && !options.allowSessionIdMismatch) {
            throw new SegmentedSessionError(
                "Session token scope mismatch",
                403,
                "STREAMING_SESSION_TOKEN_SCOPE_MISMATCH",
            );
        }
    }

    private decodeSessionTokenIgnoringExpiration(
        sessionToken: string,
    ): SegmentedSessionTokenPayload {
        try {
            const decoded = jwt.verify(sessionToken, SESSION_TOKEN_SECRET, {
                ignoreExpiration: true,
            });
            if (!isSegmentedSessionTokenPayload(decoded)) {
                throw new SegmentedSessionError(
                    "Invalid session token payload",
                    401,
                    "STREAMING_SESSION_TOKEN_INVALID",
                );
            }
            return decoded;
        } catch (error) {
            if (error instanceof SegmentedSessionError) {
                throw error;
            }

            throw new SegmentedSessionError(
                "Invalid session token",
                401,
                "STREAMING_SESSION_TOKEN_INVALID",
            );
        }
    }

    async heartbeatSession(
        session: SegmentedSessionRecord,
        snapshot: SegmentedSessionSnapshotInput = {},
    ): Promise<SegmentedSessionHeartbeatResponse> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
        const normalizedPositionSec = normalizePositionSec(snapshot.positionSec);
        const normalizedIsPlaying = normalizeIsPlaying(snapshot.isPlaying);

        const updatedSession: SegmentedSessionRecord = {
            ...session,
            expiresAt: expiresAt.toISOString(),
            lastHeartbeatAt: now.toISOString(),
            lastKnownPositionSec:
                normalizedPositionSec ?? session.lastKnownPositionSec,
            lastKnownIsPlaying: normalizedIsPlaying ?? session.lastKnownIsPlaying,
        };

        await this.persistSession(updatedSession);

        return {
            sessionId: updatedSession.sessionId,
            sessionToken: this.issueSessionToken(updatedSession),
            expiresAt: updatedSession.expiresAt,
        };
    }

    async createHandoffSession(
        session: SegmentedSessionRecord,
        snapshot: SegmentedSessionSnapshotInput = {},
    ): Promise<SegmentedSessionHandoffResponse> {
        const resumeAtSec =
            normalizePositionSec(snapshot.positionSec) ??
            normalizePositionSec(session.lastKnownPositionSec) ??
            0;
        const shouldPlay =
            normalizeIsPlaying(snapshot.isPlaying) ??
            session.lastKnownIsPlaying ??
            true;

        await this.heartbeatSession(session, {
            positionSec: resumeAtSec,
            isPlaying: shouldPlay,
            bufferedUntilSec: snapshot.bufferedUntilSec,
        });

        const nextSession = await this.createLocalSession({
            userId: session.userId,
            trackId: session.trackId,
            desiredQuality: session.quality,
            manifestProfile: "steady_state_dual",
        });

        return {
            ...nextSession,
            previousSessionId: session.sessionId,
            resumeAtSec,
            shouldPlay,
        };
    }

    schedulePlaybackErrorRepair(input: {
        userId: string;
        sessionId: string | null | undefined;
        trackId?: string | null | undefined;
        sourceType?: string | null | undefined;
    }): void {
        const sessionId = input.sessionId?.trim();
        if (!sessionId) {
            return;
        }
        if (input.sourceType && input.sourceType !== "local") {
            return;
        }

        const existingRepair = this.playbackErrorRepairInFlight.get(sessionId);
        if (existingRepair) {
            if (this.playbackErrorRepairQueued.has(sessionId)) {
                return;
            }
            this.playbackErrorRepairQueued.add(sessionId);
            const chainedRepair = existingRepair.finally(() => {
                this.playbackErrorRepairQueued.delete(sessionId);
                this.playbackErrorRepairInFlight.delete(sessionId);
                this.schedulePlaybackErrorRepair(input);
            });
            this.playbackErrorRepairInFlight.set(sessionId, chainedRepair);
            return;
        }

        const repairPromise = this.repairPlaybackErrorSessionCache({
            userId: input.userId,
            sessionId,
            trackId: input.trackId?.trim() || undefined,
        }).finally(() => {
            if (this.playbackErrorRepairInFlight.get(sessionId) === repairPromise) {
                this.playbackErrorRepairInFlight.delete(sessionId);
            }
        });
        this.playbackErrorRepairInFlight.set(sessionId, repairPromise);
    }

    resolveSegmentPath(
        session: SegmentedSessionRecord,
        segmentName: string,
    ): string {
        if (!SEGMENT_FILE_PATTERN.test(segmentName)) {
            throw new SegmentedSessionError(
                "Invalid segment file name",
                400,
                "INVALID_SEGMENT_NAME",
            );
        }

        const resolved = path.resolve(session.assetDir, segmentName);
        const assetDirResolved = path.resolve(session.assetDir);
        if (!resolved.startsWith(`${assetDirResolved}${path.sep}`)) {
            throw new SegmentedSessionError(
                "Invalid segment path",
                400,
                "INVALID_SEGMENT_PATH",
            );
        }

        return resolved;
    }

    async waitForManifestReady(session: SegmentedSessionRecord): Promise<void> {
        await this.coalesceInFlightByKey(
            this.manifestReadyInFlight,
            session.sessionId,
            async () => {
                // Each readiness phase gets its own explicit timeout window.
                // This avoids squeezing startup-window polling behind a late
                // manifest while keeping per-phase behavior deterministic.
                const manifestReadinessDeadlineAtMs =
                    Date.now() + ASSET_READY_TIMEOUT_MS;
                await this.waitForAssetFile(
                    session,
                    session.manifestPath,
                    "manifest",
                    manifestReadinessDeadlineAtMs,
                );
                const startupWindowReadinessDeadlineAtMs =
                    Date.now() + ASSET_READY_TIMEOUT_MS;
                await this.waitForStartupWindowReady(
                    session,
                    startupWindowReadinessDeadlineAtMs,
                );
            },
            {
                sessionId: session.sessionId,
                cacheKey: session.cacheKey,
                readinessType: "manifest",
            },
        );
    }

    async waitForSegmentReady(
        session: SegmentedSessionRecord,
        segmentName: string,
    ): Promise<string> {
        const segmentPath = this.resolveSegmentPath(session, segmentName);
        const segmentReadinessKey = `${session.sessionId}:${segmentName}`;

        if (
            this.hasReadinessMicrocacheHit(
                this.segmentReadyMicrocache,
                segmentReadinessKey,
            )
        ) {
            logSegmentedStreamingTrace("session.readiness.microcache_hit", {
                sessionId: session.sessionId,
                cacheKey: session.cacheKey,
                readinessType: "segment",
                segmentName,
            });
            return segmentPath;
        }

        await this.coalesceInFlightByKey(
            this.segmentReadyInFlight,
            segmentReadinessKey,
            async () => {
                if (
                    this.hasReadinessMicrocacheHit(
                        this.segmentReadyMicrocache,
                        segmentReadinessKey,
                    )
                ) {
                    return;
                }

                await this.waitForAssetFile(session, segmentPath, "segment");
                this.markReadinessMicrocacheHit(
                    this.segmentReadyMicrocache,
                    segmentReadinessKey,
                );
            },
            {
                sessionId: session.sessionId,
                cacheKey: session.cacheKey,
                readinessType: "segment",
                segmentName,
            },
        );
        return segmentPath;
    }

    private async coalesceInFlightByKey(
        inFlightMap: Map<string, Promise<void>>,
        key: string,
        waitFactory: () => Promise<void>,
        traceFields: Record<string, unknown> = {},
    ): Promise<void> {
        const existingPromise = inFlightMap.get(key);
        if (existingPromise) {
            logSegmentedStreamingTrace("session.readiness.coalesced_wait", {
                ...traceFields,
            });
            await existingPromise;
            return;
        }

        const inFlightPromise = Promise.resolve()
            .then(waitFactory)
            .finally(() => {
                if (inFlightMap.get(key) === inFlightPromise) {
                    inFlightMap.delete(key);
                }
            });

        inFlightMap.set(key, inFlightPromise);
        await inFlightPromise;
    }

    private hasReadinessMicrocacheHit(
        microcache: Map<string, number>,
        key: string,
    ): boolean {
        const expiresAtMs = microcache.get(key);
        if (expiresAtMs === undefined) {
            return false;
        }

        if (expiresAtMs <= Date.now()) {
            microcache.delete(key);
            return false;
        }

        return true;
    }

    private markReadinessMicrocacheHit(
        microcache: Map<string, number>,
        key: string,
    ): void {
        microcache.set(key, Date.now() + READINESS_MICROCACHE_TTL_MS);
    }

    private async persistSession(session: SegmentedSessionRecord): Promise<void> {
        const key = this.getSessionKey(session.sessionId);
        this.inMemorySessions.set(session.sessionId, session);

        try {
            await redisClient.setEx(
                key,
                SESSION_TTL_SECONDS,
                JSON.stringify(session),
            );
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to persist streaming session to Redis, using process memory fallback",
                error,
            );
        }
    }

    private async readSession(
        sessionId: string,
    ): Promise<SegmentedSessionRecord | null> {
        const key = this.getSessionKey(sessionId);

        try {
            const payload = await redisClient.get(key);
            if (payload) {
                const parsed = parseSessionRecord(payload);
                if (parsed) {
                    this.inMemorySessions.set(sessionId, parsed);
                    return parsed;
                }
            }
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to read streaming session from Redis, falling back to process memory",
                error,
            );
        }

        return this.inMemorySessions.get(sessionId) ?? null;
    }

    private async deleteSession(sessionId: string): Promise<void> {
        const existingSession = this.inMemorySessions.get(sessionId);
        this.inMemorySessions.delete(sessionId);
        if (existingSession) {
            segmentedStreamingCacheService.clearSessionReference(
                existingSession.cacheKey,
                existingSession.sessionId,
            );
        }
        const key = this.getSessionKey(sessionId);
        try {
            await redisClient.del(key);
        } catch {
            // Intentionally ignored: key expiry fallback still applies.
        }
    }

    private getSessionKey(sessionId: string): string {
        return `${SESSION_KEY_PREFIX}${sessionId}`;
    }

    private toSessionResponse(
        session: SegmentedSessionRecord,
        options: {
            assetBuildInFlight?: boolean;
        } = {},
    ): SegmentedSessionResponse {
        const sessionToken = this.issueSessionToken(session);
        const encodedSessionToken = encodeURIComponent(sessionToken);

        return {
            sessionId: session.sessionId,
            manifestUrl: `/api/streaming/v1/sessions/${session.sessionId}/manifest.mpd?${SEGMENTED_SESSION_TOKEN_QUERY_PARAM}=${encodedSessionToken}`,
            sessionToken,
            expiresAt: session.expiresAt,
            playbackProfile: {
                protocol: "dash",
                sourceType: session.sourceType,
                quality: session.quality,
                manifestProfile: session.manifestProfile,
                codec:
                    session.playbackCodec ??
                    qualityToPlaybackCodec(session.quality, session.sourceType),
                bitrateKbps:
                    session.playbackBitrateKbps !== undefined
                        ? session.playbackBitrateKbps
                        : qualityToBitrateKbps(session.quality),
            },
            engineHints: {
                protocol: "dash",
                sourceType: session.sourceType,
                recommendedEngine: "videojs",
                ...(options.assetBuildInFlight
                    ? { assetBuildInFlight: true }
                    : {}),
            },
        };
    }

    private issueSessionToken(session: SegmentedSessionRecord): string {
        const payload: SegmentedSessionTokenPayload = {
            type: SESSION_TOKEN_TYPE,
            sessionId: session.sessionId,
            userId: session.userId,
            trackId: session.trackId,
            quality: session.quality,
            sourceType: session.sourceType,
        };

        return jwt.sign(payload, SESSION_TOKEN_SECRET, {
            expiresIn: SESSION_TTL_SECONDS,
            subject: session.sessionId,
        });
    }

    private decodeSessionToken(sessionToken: string): SegmentedSessionTokenPayload {
        try {
            const decoded = jwt.verify(sessionToken, SESSION_TOKEN_SECRET);
            if (!isSegmentedSessionTokenPayload(decoded)) {
                throw new SegmentedSessionError(
                    "Invalid session token payload",
                    401,
                    "STREAMING_SESSION_TOKEN_INVALID",
                );
            }
            return decoded;
        } catch (error) {
            if (error instanceof SegmentedSessionError) {
                throw error;
            }

            if (error instanceof Error && error.name === "TokenExpiredError") {
                throw new SegmentedSessionError(
                    "Session token has expired",
                    401,
                    "STREAMING_SESSION_TOKEN_EXPIRED",
                );
            }

            throw new SegmentedSessionError(
                "Invalid session token",
                401,
                "STREAMING_SESSION_TOKEN_INVALID",
            );
        }
    }

    private async resolveQualityForUser(
        userId: string,
        desiredQuality: string | null | undefined,
    ): Promise<SegmentedSessionQuality> {
        const explicitQuality = normalizeQuality(desiredQuality);
        if (explicitQuality) {
            return explicitQuality;
        }

        try {
            const userSettings = await prisma.userSettings.findUnique({
                where: { userId },
                select: {
                    playbackQuality: true,
                },
            });
            const settingsQuality = normalizeQuality(userSettings?.playbackQuality);
            if (settingsQuality) {
                return settingsQuality;
            }
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to read playback quality from user settings, using fallback",
                error,
            );
        }

        return "medium";
    }

    private resolveManifestProfileForRequest(
        manifestProfile: string | null | undefined,
    ): SegmentedSessionManifestProfile {
        return (
            normalizeManifestProfile(manifestProfile) ??
            DEFAULT_SEGMENTED_SESSION_MANIFEST_PROFILE
        );
    }

    private async hasAssetBuildInFlight(cacheKey: string): Promise<boolean> {
        try {
            const buildStatus =
                await segmentedSegmentService.getBuildInFlightStatus(cacheKey);
            return buildStatus.inFlight;
        } catch (error) {
            logger.warn(
                "[SegmentedStreaming] Failed to read distributed build in-flight status; falling back to local guard",
                {
                    cacheKey,
                    error,
                },
            );
            return segmentedSegmentService.hasInFlightBuild(cacheKey);
        }
    }

    private isCacheKnownInvalid(cacheKey: string): boolean {
        return segmentedSegmentService.isCacheMarkedInvalid(cacheKey);
    }

    private async waitForAssetFile(
        session: SegmentedSessionRecord,
        assetPath: string,
        assetType: "manifest" | "segment",
        deadlineAtMsInput?: number,
    ): Promise<void> {
        if (await pathExists(assetPath)) {
            return;
        }

        const deadlineAtMs = resolveReadinessDeadlineAtMs(deadlineAtMsInput);
        const crossPodGraceDeadlineAtMs = Math.min(
            deadlineAtMs,
            Date.now() + ASSET_CROSS_POD_GRACE_MS,
        );
        const pollBackoffState = createReadinessPollBackoffState();
        let selfHealAttempted = false;
        let lastInFlightBuild = false;

        while (true) {
            const buildFailure = segmentedSegmentService.getBuildFailure(
                session.cacheKey,
            );
            if (buildFailure) {
                throw new SegmentedSessionError(
                    `Streaming ${assetType} build failed: ${buildFailure.message}`,
                    502,
                    "STREAMING_ASSET_BUILD_FAILED",
                );
            }

            if (await pathExists(assetPath)) {
                return;
            }

            if (Date.now() >= deadlineAtMs) {
                break;
            }

            const hasInFlightBuild = await this.hasAssetBuildInFlight(
                session.cacheKey,
            );
            if (hasInFlightBuild !== lastInFlightBuild) {
                resetReadinessPollBackoffState(pollBackoffState);
                lastInFlightBuild = hasInFlightBuild;
            }

            if (!hasInFlightBuild) {
                if (!selfHealAttempted) {
                    selfHealAttempted = true;
                    const selfHealTriggered = await this.trySelfHealMissingAsset(
                        session,
                        assetType,
                    );
                    if (selfHealTriggered) {
                        resetReadinessPollBackoffState(pollBackoffState);
                        await waitForNextReadinessPoll(
                            pollBackoffState,
                            deadlineAtMs,
                        );
                        continue;
                    }
                }

                if (Date.now() < crossPodGraceDeadlineAtMs) {
                    await waitForNextReadinessPoll(
                        pollBackoffState,
                        deadlineAtMs,
                    );
                    continue;
                }

                throw new SegmentedSessionError(
                    assetType === "manifest"
                        ? "Manifest not found"
                        : "Segment not found",
                    404,
                    assetType === "manifest"
                        ? "STREAMING_MANIFEST_NOT_FOUND"
                        : "STREAMING_SEGMENT_NOT_FOUND",
                );
            }

            await waitForNextReadinessPoll(pollBackoffState, deadlineAtMs);
        }

        throw new SegmentedSessionError(
            assetType === "manifest"
                ? "Manifest is still being prepared"
                : "Segment is still being prepared",
            503,
            "STREAMING_ASSET_NOT_READY",
        );
    }

    private async waitForStartupWindowReady(
        session: SegmentedSessionRecord,
        deadlineAtMsInput?: number,
    ): Promise<void> {
        if (await this.hasStartupWindowReady(session)) {
            return;
        }

        const deadlineAtMs = resolveReadinessDeadlineAtMs(deadlineAtMsInput);
        const crossPodGraceDeadlineAtMs = Math.min(
            deadlineAtMs,
            Date.now() + ASSET_CROSS_POD_GRACE_MS,
        );
        const pollBackoffState = createReadinessPollBackoffState();
        let selfHealAttempted = false;
        let lastInFlightBuild = false;
        while (true) {
            const buildFailure = segmentedSegmentService.getBuildFailure(
                session.cacheKey,
            );
            if (buildFailure) {
                throw new SegmentedSessionError(
                    `Streaming startup window build failed: ${buildFailure.message}`,
                    502,
                    "STREAMING_ASSET_BUILD_FAILED",
                );
            }

            if (await this.hasStartupWindowReady(session)) {
                return;
            }

            if (Date.now() >= deadlineAtMs) {
                break;
            }

            const hasInFlightBuild = await this.hasAssetBuildInFlight(
                session.cacheKey,
            );
            if (hasInFlightBuild !== lastInFlightBuild) {
                resetReadinessPollBackoffState(pollBackoffState);
                lastInFlightBuild = hasInFlightBuild;
            }

            if (!hasInFlightBuild) {
                if (!selfHealAttempted) {
                    selfHealAttempted = true;
                    const selfHealTriggered = await this.trySelfHealMissingAsset(
                        session,
                        "startup_window",
                    );
                    if (selfHealTriggered) {
                        resetReadinessPollBackoffState(pollBackoffState);
                        await waitForNextReadinessPoll(
                            pollBackoffState,
                            deadlineAtMs,
                        );
                        continue;
                    }
                }

                if (Date.now() < crossPodGraceDeadlineAtMs) {
                    await waitForNextReadinessPoll(
                        pollBackoffState,
                        deadlineAtMs,
                    );
                    continue;
                }
            }

            await waitForNextReadinessPoll(pollBackoffState, deadlineAtMs);
        }

        throw new SegmentedSessionError(
            "Manifest startup window is still being prepared",
            503,
            "STREAMING_ASSET_NOT_READY",
        );
    }

    private async hasStartupWindowReady(
        session: SegmentedSessionRecord,
    ): Promise<boolean> {
        const startupReadiness = await this.readManifestStartupReadiness(session);
        if (!startupReadiness) {
            return false;
        }

        if (
            startupReadiness.startupSegmentCount <
            STARTUP_MIN_TIMELINE_SEGMENTS
        ) {
            return false;
        }

        return this.hasStartupSegmentFilesReady(
            session,
            startupReadiness.startupRepresentationId,
        );
    }

    private async hasStartupSegmentFilesReady(
        session: SegmentedSessionRecord,
        startupRepresentationId: string,
    ): Promise<boolean> {
        const startupSegmentCandidates =
            buildStartupSegmentCandidatesForRepresentation(
                session.assetDir,
                startupRepresentationId,
            );
        const hasInit = await this.anyPathExists(
            startupSegmentCandidates.initSegmentPaths,
        );
        if (!hasInit) {
            return false;
        }

        const hasFirstChunk = await this.anyPathExists(
            startupSegmentCandidates.firstChunkPaths,
        );
        if (!hasFirstChunk) {
            return false;
        }

        const hasSecondChunk = await this.anyPathExists(
            startupSegmentCandidates.secondChunkPaths,
        );
        if (!hasSecondChunk) {
            return false;
        }

        const hasThirdChunk = await this.anyPathExists(
            startupSegmentCandidates.thirdChunkPaths,
        );
        if (!hasThirdChunk) {
            return false;
        }

        return true;
    }

    private async readManifestStartupReadiness(
        session: SegmentedSessionRecord,
    ): Promise<{
        startupRepresentationId: string;
        startupSegmentCount: number;
    } | null> {
        try {
            const manifestContents = await fsPromises.readFile(
                session.manifestPath,
                "utf8",
            );
            return extractManifestStartupReadiness(manifestContents);
        } catch {
            return null;
        }
    }

    private async anyPathExists(candidatePaths: readonly string[]): Promise<boolean> {
        for (const candidatePath of candidatePaths) {
            if (await pathExists(candidatePath)) {
                return true;
            }
        }
        return false;
    }

    private async trySelfHealMissingAsset(
        session: SegmentedSessionRecord,
        reason: "manifest" | "segment" | "startup_window",
    ): Promise<boolean> {
        try {
            const track = await prisma.track.findUnique({
                where: { id: session.trackId },
                select: {
                    id: true,
                    filePath: true,
                    fileModified: true,
                },
            });

            if (!track?.filePath || !track.fileModified) {
                return false;
            }

            const normalizedFilePath = track.filePath.replace(/\\/g, "/");
            const sourcePath = path.join(config.music.musicPath, normalizedFilePath);
            await fsPromises.access(sourcePath);

            await segmentedManifestService.getOrCreateLocalDashAsset({
                trackId: track.id,
                sourcePath,
                sourceModified: track.fileModified,
                quality: session.quality as SegmentedManifestQuality,
                manifestProfile:
                    session.manifestProfile as SegmentedManifestProfile,
            });

            logSegmentedStreamingTrace("session.asset.self_heal_triggered", {
                sessionId: session.sessionId,
                trackId: session.trackId,
                cacheKey: session.cacheKey,
                reason,
            });
            return true;
        } catch (error) {
            logSegmentedStreamingTrace("session.asset.self_heal_failed", {
                sessionId: session.sessionId,
                trackId: session.trackId,
                cacheKey: session.cacheKey,
                reason,
                ...toSegmentedTraceErrorFields(error),
            });
            return false;
        }
    }

    private async repairPlaybackErrorSessionCache(params: {
        userId: string;
        sessionId: string;
        trackId?: string;
    }): Promise<void> {
        const startedAtMs = Date.now();
        try {
            const session = await this.getAuthorizedSession(
                params.sessionId,
                params.userId,
            );
            if (!session) {
                logSegmentedStreamingTrace("session.asset.playback_error_repair_skipped", {
                    sessionId: params.sessionId,
                    reason: "session_not_found",
                    totalMs: segmentedTraceDurationMs(startedAtMs),
                });
                return;
            }

            if (params.trackId && params.trackId !== session.trackId) {
                logSegmentedStreamingTrace("session.asset.playback_error_repair_skipped", {
                    sessionId: session.sessionId,
                    trackId: session.trackId,
                    requestedTrackId: params.trackId,
                    cacheKey: session.cacheKey,
                    reason: "track_id_mismatch",
                    totalMs: segmentedTraceDurationMs(startedAtMs),
                });
                return;
            }

            const track = await prisma.track.findUnique({
                where: { id: session.trackId },
                select: {
                    id: true,
                    filePath: true,
                    fileModified: true,
                },
            });
            if (!track?.filePath || !track.fileModified) {
                logSegmentedStreamingTrace("session.asset.playback_error_repair_skipped", {
                    sessionId: session.sessionId,
                    trackId: session.trackId,
                    cacheKey: session.cacheKey,
                    reason: "track_source_unavailable",
                    totalMs: segmentedTraceDurationMs(startedAtMs),
                });
                return;
            }

            const normalizedFilePath = track.filePath.replace(/\\/g, "/");
            const sourcePath = path.join(config.music.musicPath, normalizedFilePath);
            await fsPromises.access(sourcePath);
            await segmentedSegmentService.forceRegenerateDashSegments({
                trackId: track.id,
                sourcePath,
                sourceModified: track.fileModified,
                quality: session.quality as SegmentedManifestQuality,
                manifestProfile:
                    session.manifestProfile as SegmentedManifestProfile,
            });

            logSegmentedStreamingTrace("session.asset.playback_error_repair_queued", {
                sessionId: session.sessionId,
                trackId: session.trackId,
                cacheKey: session.cacheKey,
                quality: session.quality,
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });
        } catch (error) {
            logSegmentedStreamingTrace("session.asset.playback_error_repair_error", {
                sessionId: params.sessionId,
                trackId: params.trackId,
                ...toSegmentedTraceErrorFields(error),
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });
        }
    }
}

const normalizeQuality = (
    quality: string | null | undefined,
): SegmentedSessionQuality | null => {
    const normalized = quality?.trim().toLowerCase();
    if (
        normalized === "original" ||
        normalized === "high" ||
        normalized === "medium" ||
        normalized === "low"
    ) {
        return normalized;
    }
    return null;
};

const normalizeManifestProfile = (
    manifestProfile: string | null | undefined,
): SegmentedSessionManifestProfile | null => {
    const normalized = manifestProfile?.trim().toLowerCase();
    if (normalized === "startup_single" || normalized === "steady_state_dual") {
        return normalized;
    }
    return null;
};

const qualityToPlaybackCodec = (
    quality: SegmentedSessionQuality,
    _sourceType: SegmentedSessionSourceType,
): "aac" | "flac" => (quality === "original" ? "flac" : "aac");

const qualityToBitrateKbps = (
    quality: SegmentedSessionQuality,
): number | null => {
    if (quality === "original" || quality === "high") {
        return 320;
    }
    if (quality === "low") {
        return 128;
    }
    return 192;
};

const resolveSessionPlaybackProfile = (input: {
    quality: SegmentedSessionQuality;
    sourceType: SegmentedSessionSourceType;
    sourceFilePath: string;
}): Pick<SegmentedSessionRecord, "playbackCodec" | "playbackBitrateKbps"> => {
    const isLosslessOriginal =
        input.quality === "original" &&
        input.sourceType === "local" &&
        LOSSLESS_FILE_EXTENSION_REGEX.test(input.sourceFilePath);

    if (isLosslessOriginal) {
        return {
            playbackCodec: "flac",
            playbackBitrateKbps: null,
        };
    }

    return {
        playbackCodec: "aac",
        playbackBitrateKbps: qualityToBitrateKbps(input.quality),
    };
};

const parseSessionRecord = (payload: string): SegmentedSessionRecord | null => {
    try {
        const parsed = JSON.parse(payload) as SegmentedSessionRecord;
        if (
            !parsed ||
            typeof parsed !== "object" ||
            typeof parsed.sessionId !== "string" ||
            typeof parsed.userId !== "string" ||
            typeof parsed.trackId !== "string" ||
            typeof parsed.cacheKey !== "string" ||
            !isSegmentedSessionQuality(parsed.quality) ||
            (parsed.manifestProfile !== undefined &&
                !isSegmentedSessionManifestProfile(parsed.manifestProfile)) ||
            !isSegmentedSessionSourceType(parsed.sourceType) ||
            (parsed.playbackCodec !== undefined &&
                parsed.playbackCodec !== "aac" &&
                parsed.playbackCodec !== "flac") ||
            (parsed.playbackBitrateKbps !== undefined &&
                parsed.playbackBitrateKbps !== null &&
                !isNonNegativeFiniteNumber(parsed.playbackBitrateKbps)) ||
            typeof parsed.manifestPath !== "string" ||
            typeof parsed.assetDir !== "string" ||
            typeof parsed.expiresAt !== "string" ||
            (parsed.lastHeartbeatAt !== undefined &&
                typeof parsed.lastHeartbeatAt !== "string") ||
            (parsed.lastKnownPositionSec !== undefined &&
                !isNonNegativeFiniteNumber(parsed.lastKnownPositionSec)) ||
            (parsed.lastKnownIsPlaying !== undefined &&
                typeof parsed.lastKnownIsPlaying !== "boolean")
        ) {
            return null;
        }
        return {
            ...parsed,
            manifestProfile:
                parsed.manifestProfile ??
                DEFAULT_SEGMENTED_SESSION_MANIFEST_PROFILE,
        };
    } catch {
        return null;
    }
};

const isSegmentedSessionQuality = (
    value: unknown,
): value is SegmentedSessionQuality =>
    value === "original" ||
    value === "high" ||
    value === "medium" ||
    value === "low";

const isSegmentedSessionSourceType = (
    value: unknown,
): value is SegmentedSessionSourceType =>
    value === "local";

const isSegmentedSessionManifestProfile = (
    value: unknown,
): value is SegmentedSessionManifestProfile =>
    value === "startup_single" || value === "steady_state_dual";

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

const normalizePositionSec = (value: unknown): number | undefined =>
    isNonNegativeFiniteNumber(value) ? value : undefined;

const normalizeIsPlaying = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : undefined;

const isSegmentedSessionTokenPayload = (
    payload: unknown,
): payload is SegmentedSessionTokenPayload => {
    if (!payload || typeof payload !== "object") {
        return false;
    }

    const candidate = payload as Partial<SegmentedSessionTokenPayload>;
    return (
        candidate.type === SESSION_TOKEN_TYPE &&
        typeof candidate.sessionId === "string" &&
        typeof candidate.userId === "string" &&
        typeof candidate.trackId === "string" &&
        isSegmentedSessionQuality(candidate.quality) &&
        isSegmentedSessionSourceType(candidate.sourceType)
    );
};

const countManifestTimelineSegments = (manifest: string): number[] => {
    const timelineSectionRegex = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/gi;
    const segmentCounts: number[] = [];

    let timelineMatch: RegExpExecArray | null = timelineSectionRegex.exec(manifest);
    while (timelineMatch) {
        const timelineBody = timelineMatch[1];
        let segmentCount = 0;
        const segmentEntryRegex = /<S\b([^>]*)\/?>/gi;
        let entryMatch: RegExpExecArray | null = segmentEntryRegex.exec(timelineBody);
        while (entryMatch) {
            const attributes = entryMatch[1] ?? "";
            const repeatMatch = /\br="(-?\d+)"/i.exec(attributes);
            const repeatCount = repeatMatch
                ? Number.parseInt(repeatMatch[1], 10)
                : 0;
            segmentCount += Number.isFinite(repeatCount) && repeatCount >= 0
                ? repeatCount + 1
                : 1;
            entryMatch = segmentEntryRegex.exec(timelineBody);
        }

        segmentCounts.push(segmentCount);
        timelineMatch = timelineSectionRegex.exec(manifest);
    }

    return segmentCounts;
};

const extractManifestStartupReadiness = (manifest: string): {
    startupRepresentationId: string;
    startupSegmentCount: number;
} | null => {
    const startupTimelineSegmentCounts = countManifestTimelineSegments(manifest);
    if (startupTimelineSegmentCounts.length === 0) {
        return null;
    }

    const startupRepresentationMatch = manifest.match(
        /<Representation\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')/i,
    );
    const matchedRepresentationId = startupRepresentationMatch
        ? (startupRepresentationMatch[1] ?? startupRepresentationMatch[2] ?? "")
            .trim()
        : "";

    return {
        startupRepresentationId: matchedRepresentationId || "0",
        startupSegmentCount: startupTimelineSegmentCounts[0] ?? 0,
    };
};

const buildStartupSegmentCandidatesForRepresentation = (
    assetDir: string,
    representationId: string,
): {
    initSegmentPaths: string[];
    firstChunkPaths: string[];
    secondChunkPaths: string[];
    thirdChunkPaths: string[];
} => {
    const representationToken = representationId.trim() || "0";
    return {
        initSegmentPaths: STARTUP_SEGMENT_EXTENSIONS.map((extension) =>
            path.resolve(assetDir, `init-${representationToken}.${extension}`),
        ),
        firstChunkPaths: STARTUP_SEGMENT_EXTENSIONS.map((extension) =>
            path.resolve(assetDir, `chunk-${representationToken}-00001.${extension}`),
        ),
        secondChunkPaths: STARTUP_SEGMENT_EXTENSIONS.map((extension) =>
            path.resolve(assetDir, `chunk-${representationToken}-00002.${extension}`),
        ),
        thirdChunkPaths: STARTUP_SEGMENT_EXTENSIONS.map((extension) =>
            path.resolve(assetDir, `chunk-${representationToken}-00003.${extension}`),
        ),
    };
};

const wait = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
    });
};

const resolveReadinessDeadlineAtMs = (
    deadlineAtMsInput?: number,
): number => {
    if (
        typeof deadlineAtMsInput === "number" &&
        Number.isFinite(deadlineAtMsInput)
    ) {
        return deadlineAtMsInput;
    }
    return Date.now() + ASSET_READY_TIMEOUT_MS;
};

const createReadinessPollBackoffState = (): ReadinessPollBackoffState => ({
    nextBaseDelayMs: ASSET_READY_POLL_INITIAL_INTERVAL_MS,
});

const resetReadinessPollBackoffState = (
    state: ReadinessPollBackoffState,
): void => {
    state.nextBaseDelayMs = ASSET_READY_POLL_INITIAL_INTERVAL_MS;
};

const computeNextReadinessPollDelayMs = (
    state: ReadinessPollBackoffState,
): number => {
    const jitterScale =
        1 + (Math.random() * 2 - 1) * ASSET_READY_POLL_JITTER_FACTOR;
    const jitteredDelayMs = Math.round(state.nextBaseDelayMs * jitterScale);
    const nextDelayMs = Math.max(
        1,
        Math.min(ASSET_READY_POLL_MAX_INTERVAL_MS, jitteredDelayMs),
    );

    state.nextBaseDelayMs = Math.min(
        ASSET_READY_POLL_MAX_INTERVAL_MS,
        Math.ceil(
            state.nextBaseDelayMs * ASSET_READY_POLL_BACKOFF_MULTIPLIER,
        ),
    );
    return nextDelayMs;
};

const waitForNextReadinessPoll = async (
    state: ReadinessPollBackoffState,
    deadlineAtMs: number,
): Promise<void> => {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        return;
    }

    const maxDelayForRemainingBudgetMs = Math.max(
        1,
        Math.ceil(remainingMs / ASSET_READY_POLL_MIN_REMAINING_WINDOW_SAMPLES),
    );
    const nextDelayMs = Math.min(
        computeNextReadinessPollDelayMs(state),
        maxDelayForRemainingBudgetMs,
        remainingMs,
    );
    await wait(nextDelayMs);
};

const pathExists = async (candidatePath: string): Promise<boolean> => {
    try {
        await fsPromises.access(candidatePath);
        return true;
    } catch {
        return false;
    }
};

export const segmentedStreamingSessionService = new SegmentedSessionService();
