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
} from "./manifestService";
import { segmentedStreamingCacheService } from "./cacheService";
import { segmentedSegmentService } from "./segmentService";
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
const ASSET_READY_POLL_INTERVAL_MS = 75;
const ASSET_READY_TIMEOUT_MS = 20_000;
const ASSET_CROSS_POD_GRACE_MS = 2_500;
const STARTUP_MIN_TIMELINE_SEGMENTS = 2;
const STARTUP_INIT_SEGMENT_CANDIDATES = ["init-0.m4s", "init-0.webm"] as const;
const STARTUP_FIRST_CHUNK_CANDIDATES = [
    "chunk-0-00001.m4s",
    "chunk-0-00001.webm",
] as const;
const STARTUP_SECOND_CHUNK_CANDIDATES = [
    "chunk-0-00002.m4s",
    "chunk-0-00002.webm",
] as const;
const LOSSLESS_FILE_EXTENSION_REGEX =
    /\.(flac|wav|aiff|aif|alac|ape|wv|tta|dff|dsf)$/i;

const SEGMENTED_QUALITY_VALUES = [
    "original",
    "high",
    "medium",
    "low",
] as const;
const SEGMENTED_SOURCE_TYPE_VALUES: ReadonlyArray<SegmentedStreamingSourceType> = [
    "local",
];

export type SegmentedSessionQuality = (typeof SEGMENTED_QUALITY_VALUES)[number];
export type SegmentedSessionSourceType = SegmentedStreamingSourceType;

export interface CreateLocalSegmentedSessionInput {
    userId: string;
    trackId: string;
    desiredQuality?: SegmentedSessionQuality;
}

export interface SegmentedSessionRecord {
    sessionId: string;
    userId: string;
    trackId: string;
    cacheKey: string;
    quality: SegmentedSessionQuality;
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

class SegmentedSessionService {
    private readonly inMemorySessions = new Map<string, SegmentedSessionRecord>();

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
            const assetBuildInFlight = segmentedSegmentService.hasInFlightBuild(
                sessionRecord.cacheKey,
            );

            logSegmentedStreamingTrace("session.local.create_success", {
                trackId: track.id,
                quality,
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
        });

        return {
            ...nextSession,
            previousSessionId: session.sessionId,
            resumeAtSec,
            shouldPlay,
        };
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
        await this.waitForAssetFile(session, session.manifestPath, "manifest");
        await this.waitForStartupWindowReady(session);
    }

    async waitForSegmentReady(
        session: SegmentedSessionRecord,
        segmentName: string,
    ): Promise<string> {
        const segmentPath = this.resolveSegmentPath(session, segmentName);
        await this.waitForAssetFile(session, segmentPath, "segment");
        return segmentPath;
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

    private async waitForAssetFile(
        session: SegmentedSessionRecord,
        assetPath: string,
        assetType: "manifest" | "segment",
    ): Promise<void> {
        if (await pathExists(assetPath)) {
            return;
        }

        const deadlineAtMs = Date.now() + ASSET_READY_TIMEOUT_MS;
        const crossPodGraceDeadlineAtMs = Date.now() + ASSET_CROSS_POD_GRACE_MS;
        let selfHealAttempted = false;

        while (Date.now() < deadlineAtMs) {
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

            if (!segmentedSegmentService.hasInFlightBuild(session.cacheKey)) {
                if (!selfHealAttempted) {
                    selfHealAttempted = true;
                    const selfHealTriggered = await this.trySelfHealMissingAsset(
                        session,
                        assetType,
                    );
                    if (selfHealTriggered) {
                        await wait(ASSET_READY_POLL_INTERVAL_MS);
                        continue;
                    }
                }

                if (Date.now() < crossPodGraceDeadlineAtMs) {
                    await wait(ASSET_READY_POLL_INTERVAL_MS);
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

            await wait(ASSET_READY_POLL_INTERVAL_MS);
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
    ): Promise<void> {
        if (await this.hasStartupWindowReady(session)) {
            return;
        }

        const deadlineAtMs = Date.now() + ASSET_READY_TIMEOUT_MS;
        const crossPodGraceDeadlineAtMs = Date.now() + ASSET_CROSS_POD_GRACE_MS;
        let selfHealAttempted = false;
        while (Date.now() < deadlineAtMs) {
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

            if (!segmentedSegmentService.hasInFlightBuild(session.cacheKey)) {
                if (!selfHealAttempted) {
                    selfHealAttempted = true;
                    const selfHealTriggered = await this.trySelfHealMissingAsset(
                        session,
                        "startup_window",
                    );
                    if (selfHealTriggered) {
                        await wait(ASSET_READY_POLL_INTERVAL_MS);
                        continue;
                    }
                }

                if (Date.now() < crossPodGraceDeadlineAtMs) {
                    await wait(ASSET_READY_POLL_INTERVAL_MS);
                    continue;
                }

                // Compatibility fallback for pre-existing cache layouts where
                // startup segment naming differs from current templates.
                return;
            }

            await wait(ASSET_READY_POLL_INTERVAL_MS);
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
        const hasStartupSegments = await this.hasStartupSegmentFilesReady(session);
        if (!hasStartupSegments) {
            return false;
        }

        return await this.hasManifestStartupTimelineReady(session);
    }

    private async hasStartupSegmentFilesReady(
        session: SegmentedSessionRecord,
    ): Promise<boolean> {
        const hasInit = await this.anyPathExists(
            STARTUP_INIT_SEGMENT_CANDIDATES.map((segmentName) =>
                path.resolve(session.assetDir, segmentName),
            ),
        );
        if (!hasInit) {
            return false;
        }

        const hasFirstChunk = await this.anyPathExists(
            STARTUP_FIRST_CHUNK_CANDIDATES.map((segmentName) =>
                path.resolve(session.assetDir, segmentName),
            ),
        );
        if (!hasFirstChunk) {
            return false;
        }

        const hasSecondChunk = await this.anyPathExists(
            STARTUP_SECOND_CHUNK_CANDIDATES.map((segmentName) =>
                path.resolve(session.assetDir, segmentName),
            ),
        );
        if (!hasSecondChunk) {
            return false;
        }

        return true;
    }

    private async hasManifestStartupTimelineReady(
        session: SegmentedSessionRecord,
    ): Promise<boolean> {
        try {
            const manifestContents = await fsPromises.readFile(
                session.manifestPath,
                "utf8",
            );
            const timelineCounts = countManifestTimelineSegments(manifestContents);
            if (timelineCounts.length === 0) {
                return false;
            }

            return timelineCounts.every(
                (segmentCount) => segmentCount >= STARTUP_MIN_TIMELINE_SEGMENTS,
            );
        } catch {
            return false;
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
        return parsed;
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

const wait = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
    });
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
