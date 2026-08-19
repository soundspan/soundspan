import { existsSync } from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import {
    MAX_UMAP_WORKER_ROWS,
    type UmapProjectionRow,
    type UmapWorkerData,
    type UmapWorkerMessage,
} from "../workers/umapWorkerProtocol";
import { getActiveSpace } from "./embeddingSpaces";
import {
    acquireVibeMapBuildLease,
    clearVibeMapBuildFailures,
    readVibeMapBuildFailure,
    recordVibeMapBuildFailure,
    type VibeMapBuildFailure,
    type VibeMapBuildLease,
} from "./vibeMapBuildState";

const log = logger.child("VibeMapProjection");
const MIN_TRACKS_FOR_UMAP = 5;
const MIN_OOM_SAMPLE = 2000;
const MAX_UMAP_ATTEMPTS = 3;
const CACHE_KEY_PREFIX = "vibe:map:v5:projection";
const TRACK_IDS_KEY_PREFIX = "vibe:map:v5:track_ids";
const CACHE_TTL_SECONDS = 86400;
const EMPTY_CACHE_TTL_SECONDS = 300;
const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;
const UMAP_SHUTDOWN_TIMEOUT_MS = 3 * 1000;
const activeBuilds = new Map<string, Promise<void>>();
const activeAdmissions = new Set<Promise<VibeMapProjectionState>>();
const activeWorkers = new Set<Worker>();
const heldLeases = new Set<VibeMapBuildLease>();
let acceptingBuilds = true;
let shutdownPromise: Promise<void> | null = null;

function cacheKeyForSpace(spaceId: string): string {
    return `${CACHE_KEY_PREFIX}:${spaceId}`;
}

function trackIdsKeyForSpace(spaceId: string): string {
    return `${TRACK_IDS_KEY_PREFIX}:${spaceId}`;
}

/** Track returned to the vibe-map client. */
export interface VibeMapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
    dominantMood: string;
    moodScore: number;
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

/** Cached vibe-map response for one embedding space. */
export interface VibeMapResponse {
    tracks: VibeMapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
}

const MOOD_FIELDS = [
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
    "moodAcoustic",
    "moodElectronic",
] as const;

/** Worker query data plus optional development loader registration. */
export interface UmapWorkerOptions {
    workerData: UmapWorkerData;
    execArgv?: string[];
}

/** Build worker options without passing embeddings through the parent heap. */
export function umapWorkerOptions(
    workerPath: string,
    spaceId: string,
    sampleSize: number,
): UmapWorkerOptions {
    const workerData = { spaceId, sampleSize };
    return workerPath.endsWith(".ts")
        ? { workerData, execArgv: ["--import", "tsx"] }
        : { workerData };
}

function resolveUmapWorkerPath(): string {
    const candidatePaths = [
        path.join(__dirname, "../workers/umapWorker.js"),
        path.join(__dirname, "../workers/umapWorker.ts"),
    ];
    return (
        candidatePaths.find((candidatePath) => existsSync(candidatePath)) ??
        candidatePaths[0]
    );
}

function getDominantMood(track: UmapProjectionRow): {
    mood: string;
    score: number;
} {
    let best = { mood: "neutral", score: 0 };
    for (const field of MOOD_FIELDS) {
        const value = track[field];
        if (value != null && value > best.score) {
            best = { mood: field, score: value };
        }
    }
    return best;
}

function getMoodScores(track: UmapProjectionRow): Record<string, number> {
    const moods: Record<string, number> = {};
    for (const field of MOOD_FIELDS) {
        const value = track[field];
        if (value != null) moods[field] = value;
    }
    return moods;
}

function buildMapTrack(
    row: UmapProjectionRow,
    x: number,
    y: number,
): VibeMapTrack {
    const dominant = getDominantMood(row);
    return {
        id: row.track_id,
        x,
        y,
        title: row.title,
        artist: row.artistName,
        artistId: row.artistId,
        albumId: row.albumId,
        coverUrl: row.coverUrl,
        loudnessLufs: row.loudnessLufs,
        truePeakDb: row.truePeakDb,
        albumLoudnessLufs: row.albumLoudnessLufs,
        albumTruePeakDb: row.albumTruePeakDb,
        dominantMood: dominant.mood,
        moodScore: dominant.score,
        moods: getMoodScores(row),
        energy: row.energy,
        valence: row.valence,
    };
}

async function cacheResult(
    spaceId: string,
    result: VibeMapResponse,
    trackIds: string[],
    ttlSeconds: number = CACHE_TTL_SECONDS,
): Promise<void> {
    if (!acceptingBuilds) return;
    const trackIdsKey = trackIdsKeyForSpace(spaceId);
    const pipeline = redisClient.multi();
    pipeline.setEx(
        cacheKeyForSpace(spaceId),
        ttlSeconds,
        JSON.stringify(result),
    );
    pipeline.del(trackIdsKey);
    if (trackIds.length > 0) {
        pipeline.sAdd(trackIdsKey, trackIds);
        pipeline.expire(trackIdsKey, CACHE_TTL_SECONDS);
    }
    await pipeline.exec();
}

class UmapWorkerFailure extends Error {
    readonly code: string | undefined;
    readonly materializedRowCount: number | null;

    constructor(error: Error, materializedRowCount: number | null) {
        super(error.message, { cause: error });
        this.name = "UmapWorkerFailure";
        this.code = (error as NodeJS.ErrnoException).code;
        this.materializedRowCount = materializedRowCount;
    }
}

type WorkerResult = {
    rows: UmapProjectionRow[];
    projection: number[][] | null;
};

function parseWorkerMessage(value: unknown): UmapWorkerMessage | null {
    if (!value || typeof value !== "object") return null;
    const message = value as Partial<UmapWorkerMessage>;
    if (
        message.type === "materialized" &&
        Number.isSafeInteger(message.rowCount) &&
        Number(message.rowCount) >= 0 &&
        Number(message.rowCount) <= MAX_UMAP_WORKER_ROWS
    ) {
        return message as UmapWorkerMessage;
    }
    if (
        message.type === "error" &&
        typeof message.error === "string" &&
        message.error.length > 0
    ) {
        return message as UmapWorkerMessage;
    }
    if (
        message.type === "result" &&
        Array.isArray(message.rows) &&
        message.rows.length <= MAX_UMAP_WORKER_ROWS &&
        (message.projection === null || Array.isArray(message.projection))
    ) {
        return message as UmapWorkerMessage;
    }
    return null;
}

function validateWorkerResult(
    message: Extract<UmapWorkerMessage, { type: "result" }>,
): WorkerResult {
    const { rows, projection } = message;
    if (rows.length >= MIN_TRACKS_FOR_UMAP) {
        if (!projection || projection.length !== rows.length) {
            throw new Error("UMAP worker returned a mismatched projection");
        }
        for (let index = 0; index < MAX_UMAP_WORKER_ROWS; index += 1) {
            if (index >= projection.length) break;
            const point = projection[index];
            if (
                !Array.isArray(point) ||
                point.length < 2 ||
                !Number.isFinite(point[0]) ||
                !Number.isFinite(point[1])
            ) {
                throw new Error("UMAP worker returned an invalid coordinate");
            }
        }
    } else if (projection !== null) {
        throw new Error("UMAP worker projected an undersized dataset");
    }
    return { rows, projection };
}

function requestWorkerTermination(worker: Worker): void {
    worker.terminate().catch((error: unknown) => {
        log.warn("Failed to terminate UMAP worker", error);
    });
}

async function terminateWorker(worker: Worker): Promise<void> {
    try {
        await worker.terminate();
    } catch (error) {
        log.warn("Failed to terminate UMAP worker", error);
    }
}

class UmapWorkerMonitor {
    private settled = false;
    private materializedRowCount: number | null = null;
    private readonly warnTimer: NodeJS.Timeout;
    private readonly timeoutTimer: NodeJS.Timeout;

    constructor(
        private readonly worker: Worker,
        requestedSampleSize: number,
        private readonly resolve: (result: WorkerResult) => void,
        private readonly reject: (error: Error) => void,
    ) {
        this.warnTimer = setTimeout(() => {
            log.warn("UMAP worker running for more than five minutes", {
                requestedSampleSize,
            });
        }, UMAP_WARN_MS);
        this.timeoutTimer = setTimeout(() => {
            if (this.settled) return;
            this.finish();
            requestWorkerTermination(this.worker);
            this.reject(
                new Error(
                    `UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`,
                ),
            );
        }, UMAP_TIMEOUT_MS);
        worker.on("message", (payload: unknown) => this.onMessage(payload));
        worker.on("error", (error: Error) => this.fail(error));
        worker.on("exit", (code: number) => this.onExit(code));
    }

    private finish(): void {
        this.settled = true;
        clearTimeout(this.warnTimer);
        clearTimeout(this.timeoutTimer);
    }

    private fail(error: Error): void {
        if (this.settled) return;
        this.finish();
        this.reject(new UmapWorkerFailure(error, this.materializedRowCount));
    }

    private onExit(code: number): void {
        if (this.settled) return;
        const message =
            code === 0
                ? "UMAP worker exited before returning a result"
                : `UMAP worker exited with code ${code}`;
        this.fail(new Error(message));
    }

    private onMessage(payload: unknown): void {
        if (this.settled) return;
        const message = parseWorkerMessage(payload);
        if (!message) {
            this.fail(new Error("UMAP worker returned an invalid message"));
            return;
        }
        if (message.type === "materialized") {
            this.materializedRowCount = message.rowCount;
            return;
        }
        if (message.type === "error") {
            this.fail(new Error(message.error));
            return;
        }
        this.finish();
        try {
            this.resolve(validateWorkerResult(message));
        } catch (error) {
            this.reject(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }
}

function monitorUmapWorker(
    worker: Worker,
    requestedSampleSize: number,
): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
        new UmapWorkerMonitor(worker, requestedSampleSize, resolve, reject);
    });
}

function runUmapInWorker(
    spaceId: string,
    sampleSize: number,
): Promise<WorkerResult> {
    const workerPath = resolveUmapWorkerPath();
    const worker = new Worker(workerPath, {
        ...umapWorkerOptions(workerPath, spaceId, sampleSize),
        resourceLimits: {
            maxOldGenerationSizeMb: config.vibeMapWorkerMemoryMb,
        },
    });
    activeWorkers.add(worker);
    worker.on("exit", () => {
        activeWorkers.delete(worker);
    });
    return monitorUmapWorker(worker, sampleSize);
}

function isWorkerOutOfMemory(error: unknown): boolean {
    return (
        error instanceof Error &&
        ((error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" ||
            error.message.includes("memory limit"))
    );
}

async function projectWithOomDegradation(
    spaceId: string,
): Promise<WorkerResult & { degraded: boolean }> {
    let sampleSize = MAX_UMAP_WORKER_ROWS;
    for (let attempt = 0; attempt < MAX_UMAP_ATTEMPTS; attempt += 1) {
        try {
            const result = await runUmapInWorker(spaceId, sampleSize);
            return { ...result, degraded: attempt > 0 };
        } catch (error) {
            const materializedCount =
                error instanceof UmapWorkerFailure
                    ? error.materializedRowCount
                    : null;
            const reductionBase = materializedCount ?? sampleSize;
            if (
                !isWorkerOutOfMemory(error) ||
                reductionBase <= MIN_OOM_SAMPLE ||
                attempt === MAX_UMAP_ATTEMPTS - 1
            ) {
                throw error;
            }
            sampleSize = Math.max(
                MIN_OOM_SAMPLE,
                Math.floor(reductionBase / 2),
            );
            log.warn(
                "UMAP worker memory limit reached; retrying with a smaller sample",
                { sampleSize: reductionBase, nextSampleSize: sampleSize },
            );
        }
    }
    throw new Error("UMAP projection exhausted its bounded attempts");
}

async function buildCircularLayout(
    spaceId: string,
    rows: UmapProjectionRow[],
): Promise<VibeMapResponse> {
    const tracks = rows.map((row, index) => {
        const angle = (2 * Math.PI * index) / rows.length;
        return buildMapTrack(
            row,
            0.5 + 0.3 * Math.cos(angle),
            0.5 + 0.3 * Math.sin(angle),
        );
    });
    const result = {
        tracks,
        trackCount: tracks.length,
        computedAt: new Date().toISOString(),
    };
    await cacheResult(
        spaceId,
        result,
        rows.map((row) => row.track_id),
    );
    return result;
}

function normalizeProjection(
    rows: UmapProjectionRow[],
    projection: number[][],
): VibeMapTrack[] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < MAX_UMAP_WORKER_ROWS; index += 1) {
        if (index >= projection.length) break;
        const [x, y] = projection[index];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    return rows.map((row, index) =>
        buildMapTrack(
            row,
            (projection[index][0] - minX) / rangeX,
            (projection[index][1] - minY) / rangeY,
        ),
    );
}

async function doCompute(spaceId: string): Promise<VibeMapResponse> {
    const startedAt = Date.now();
    const { rows, projection, degraded } =
        await projectWithOomDegradation(spaceId);
    if (rows.length === 0) {
        const empty = {
            tracks: [],
            trackCount: 0,
            computedAt: new Date().toISOString(),
        };
        await cacheResult(spaceId, empty, [], EMPTY_CACHE_TTL_SECONDS);
        return empty;
    }
    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(spaceId, rows);
    }
    if (!projection) throw new Error("UMAP worker omitted its projection");
    const tracks = normalizeProjection(rows, projection);
    const result: VibeMapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(degraded || rows.length === MAX_UMAP_WORKER_ROWS
            ? { sampled: true }
            : {}),
        computedAt: new Date().toISOString(),
    };
    await cacheResult(
        spaceId,
        result,
        rows.map((row) => row.track_id),
    );
    log.info("UMAP projection computed", {
        elapsedMs: Date.now() - startedAt,
        trackCount: tracks.length,
        sampled: result.sampled ?? false,
    });
    return result;
}

async function releaseLease(lease: VibeMapBuildLease): Promise<void> {
    if (!heldLeases.delete(lease)) return;
    try {
        await lease.release();
    } catch (error) {
        log.warn("Failed to release vibe map build lease", error);
    }
}

async function recordBuildFailure(
    spaceId: string,
    error: unknown,
): Promise<void> {
    log.error("Vibe map build failed", error);
    try {
        await recordVibeMapBuildFailure(
            spaceId,
            isWorkerOutOfMemory(error)
                ? "UMAP worker exceeded its memory limit"
                : "Vibe map projection build failed",
        );
    } catch (markerError) {
        log.error("Failed to record vibe map build cooldown", markerError);
    }
}

async function superviseBuild(
    spaceId: string,
    lease: VibeMapBuildLease,
): Promise<void> {
    try {
        await doCompute(spaceId);
        if (!acceptingBuilds) return;
        try {
            await clearVibeMapBuildFailures(spaceId);
        } catch (error) {
            log.warn("Failed to clear vibe map build failure history", error);
        }
    } catch (error) {
        if (acceptingBuilds) {
            await recordBuildFailure(spaceId, error);
        } else {
            log.debug("Vibe map build stopped during shutdown", { spaceId });
        }
    } finally {
        if (acceptingBuilds) await releaseLease(lease);
    }
}

/** Cached data, an active build, or a failed build waiting for retry. */
export type VibeMapProjectionState =
    | { status: "ready"; data: VibeMapResponse }
    | { status: "building" }
    | ({ status: "failed" } & VibeMapBuildFailure);

async function readPublishedState(
    spaceId: string,
): Promise<VibeMapProjectionState | null> {
    const [cached, failure] = await Promise.all([
        redisClient.get(cacheKeyForSpace(spaceId)),
        readVibeMapBuildFailure(spaceId),
    ]);
    if (cached) {
        try {
            const data = JSON.parse(cached) as VibeMapResponse;
            log.debug("Vibe map cache hit", { spaceId });
            return { status: "ready", data };
        } catch {
            log.warn("Ignoring malformed vibe map projection cache", {
                spaceId,
            });
        }
    }
    return failure ? { status: "failed", ...failure } : null;
}

async function settleShutdownWork(
    canReleaseLeases: () => boolean,
): Promise<void> {
    await Promise.allSettled(Array.from(activeAdmissions));
    const terminations = Array.from(activeWorkers, terminateWorker);
    await Promise.allSettled(terminations);
    const builds = Array.from(activeBuilds.values());
    await Promise.allSettled(builds);
    // A missed shutdown deadline leaves residual work uncertain. Stop lease
    // refreshes, but let Redis TTL recovery prevent overlap with that work.
    if (!canReleaseLeases()) return;
    const releases = Array.from(heldLeases, releaseLease);
    await Promise.allSettled(releases);
}

async function settleWithinShutdownTimeout(): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let deadlineExpired = false;
        const finish = (completed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(completed);
        };
        const timeoutId = setTimeout(() => {
            deadlineExpired = true;
            for (const lease of heldLeases) lease.abandon();
            finish(false);
        }, UMAP_SHUTDOWN_TIMEOUT_MS);
        settleShutdownWork(() => !deadlineExpired).then(
            () => finish(true),
            () => finish(true),
        );
    });
}

async function performShutdown(): Promise<void> {
    const completed = await settleWithinShutdownTimeout();
    if (completed) return;
    log.warn("UMAP projection shutdown timed out", {
        timeoutMs: UMAP_SHUTDOWN_TIMEOUT_MS,
        activeBuilds: activeBuilds.size,
        activeWorkers: activeWorkers.size,
        heldLeases: heldLeases.size,
    });
}

/** Stop projection admission and boundedly terminate owned workers and leases. */
export function shutdownUmapProjection(): Promise<void> {
    acceptingBuilds = false;
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
}

async function admitMapProjection(): Promise<VibeMapProjectionState> {
    if (!acceptingBuilds) return { status: "building" };
    const activeSpace = await getActiveSpace();
    const spaceId = activeSpace.id;
    const published = await readPublishedState(spaceId);
    if (published) return published;
    if (!acceptingBuilds) return { status: "building" };
    if (activeBuilds.size > 0) return { status: "building" };
    const lease = await acquireVibeMapBuildLease(spaceId);
    if (!lease) {
        log.debug("Vibe map build lease held by another replica", { spaceId });
        return { status: "building" };
    }
    heldLeases.add(lease);
    let buildStarted = false;
    try {
        if (!acceptingBuilds) return { status: "building" };
        const publishedWhileAcquiring = await readPublishedState(spaceId);
        if (publishedWhileAcquiring || !acceptingBuilds) {
            return publishedWhileAcquiring ?? { status: "building" };
        }
        const build = superviseBuild(spaceId, lease).finally(() => {
            activeBuilds.delete(spaceId);
        });
        activeBuilds.set(spaceId, build);
        buildStarted = true;
        return { status: "building" };
    } finally {
        if (!buildStarted) await releaseLease(lease);
    }
}

/** Serve cached data or supervise one leased background build per space. */
export async function computeMapProjection(): Promise<VibeMapProjectionState> {
    if (!acceptingBuilds) return { status: "building" };
    const admission = admitMapProjection();
    activeAdmissions.add(admission);
    try {
        return await admission;
    } finally {
        activeAdmissions.delete(admission);
    }
}
