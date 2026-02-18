import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { prisma } from "../src/utils/db";

type TrackSnapshot = {
    id: string;
    analysisStatus: string;
    analysisError: string | null;
    analysisRetryCount: number;
    analysisStartedAt: Date | null;
};

type TrackState = {
    analysisStatus: string;
    analysisRetryCount: number;
    analysisError: string | null;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(
    logsRef: { value: string },
    pattern: RegExp,
    timeoutMs: number
): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (pattern.test(logsRef.value)) {
            return true;
        }
        await sleep(200);
    }
    return false;
}

function mustGetEnv(name: string, fallback?: string): string {
    const value = process.env[name] || fallback;
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

async function waitForTrackState(
    trackId: string,
    predicate: (track: TrackState | null) => boolean,
    timeoutMs: number
): Promise<TrackState | null> {
    const startedAt = Date.now();
    let last: TrackState | null = null;
    while (Date.now() - startedAt < timeoutMs) {
        last = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                analysisStatus: true,
                analysisRetryCount: true,
                analysisError: true,
            },
        });
        if (predicate(last)) {
            return last;
        }
        await sleep(300);
    }
    return last;
}

async function run(): Promise<void> {
    const databaseUrl = mustGetEnv("DATABASE_URL");
    const redisUrl = mustGetEnv("REDIS_URL", "redis://localhost:6380");
    const pythonBin = mustGetEnv("PYTHON_BIN", "python3");
    const musicPath = mustGetEnv("MUSIC_PATH", "/tmp");
    const analyzerScript = process.env.ANALYZER_SCRIPT || path.resolve(
        process.cwd(),
        "..",
        "services",
        "audio-analyzer",
        "analyzer.py"
    );

    const candidates = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            filePath: { not: "" },
        },
        select: {
            id: true,
            filePath: true,
            analysisStatus: true,
            analysisError: true,
            analysisRetryCount: true,
            analysisStartedAt: true,
        },
        take: 3,
        orderBy: { id: "asc" },
    });

    if (candidates.length < 2) {
        throw new Error("Need at least 2 completed tracks to run analyzer smoke test");
    }

    const staleTrack = candidates[0];
    const failureTrack = candidates[1];
    const forcedMissingPath = `/tmp/soundspan-smoke-missing-${failureTrack.id}-${Date.now()}.mp3`;

    const staleTrackBefore: TrackSnapshot = {
        id: staleTrack.id,
        analysisStatus: staleTrack.analysisStatus,
        analysisError: staleTrack.analysisError,
        analysisRetryCount: staleTrack.analysisRetryCount,
        analysisStartedAt: staleTrack.analysisStartedAt,
    };
    const failureTrackBefore: TrackSnapshot = {
        id: failureTrack.id,
        analysisStatus: failureTrack.analysisStatus,
        analysisError: failureTrack.analysisError,
        analysisRetryCount: failureTrack.analysisRetryCount,
        analysisStartedAt: failureTrack.analysisStartedAt,
    };

    let redis: ReturnType<typeof createClient> | null = null;
    let analyzer: ReturnType<typeof spawn> | null = null;
    const logBuffer = { value: "" };
    const smokeLogPath = process.env.ANALYZER_SMOKE_LOG_PATH || "/tmp/analyzer-phase4-regressions.log";

    try {
        // Danceability consistency snapshot for enhanced-mode tracks.
        const enhancedSummary = await prisma.track.aggregate({
            where: {
                analysisStatus: "completed",
                analysisMode: "enhanced",
                danceability: { not: null },
                danceabilityMl: { not: null },
            },
            _count: { _all: true },
        });
        console.log(
            `[smoke] enhanced danceability overlap rows: ${enhancedSummary._count._all}`
        );

        redis = createClient({ url: redisUrl });
        await redis.connect();
        await redis.del("audio:analysis:queue");

        const analyzerEnv = {
            ...process.env,
            DATABASE_URL: databaseUrl,
            REDIS_URL: redisUrl,
            MUSIC_PATH: musicPath,
            BATCH_SIZE: "2",
            BRPOP_TIMEOUT: "5",
            MODEL_IDLE_TIMEOUT: "20",
            MAX_FILE_SIZE_MB: process.env.MAX_FILE_SIZE_MB || "250",
            BATCH_ANALYSIS_TIMEOUT_SECONDS:
                process.env.BATCH_ANALYSIS_TIMEOUT_SECONDS || "60",
            THREADS_PER_WORKER: process.env.THREADS_PER_WORKER || "1",
        };

        analyzer = spawn(pythonBin, [analyzerScript], {
            env: analyzerEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        analyzer.stdout.on("data", (chunk) => {
            logBuffer.value += chunk.toString();
        });
        analyzer.stderr.on("data", (chunk) => {
            logBuffer.value += chunk.toString();
        });

        const ready = await waitForLog(
            logBuffer,
            /Starting Audio Analysis Worker \(BRPOP MODE\)/,
            15000
        );
        if (!ready) {
            throw new Error("Analyzer did not start within timeout");
        }

        // Queue stale (already-completed) entry first, then pending entry for failure path.
        await redis.rPush(
            "audio:analysis:queue",
            JSON.stringify({
                trackId: staleTrack.id,
                filePath: staleTrack.filePath,
            })
        );

        await redis.publish("audio:analysis:control", "pause");
        await sleep(800);
        await redis.publish("audio:analysis:control", "resume");
        await sleep(800);
        await redis.publish(
            "audio:analysis:control",
            JSON.stringify({ command: "set_workers", count: 1 })
        );
        await sleep(800);

        // Flip track to pending immediately before enqueue to avoid startup reconciliation races.
        await prisma.track.update({
            where: { id: failureTrack.id },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisStartedAt: null,
            },
        });

        await redis.rPush(
            "audio:analysis:queue",
            JSON.stringify({
                trackId: failureTrack.id,
                filePath: forcedMissingPath,
            })
        );

        const failureTrackAfter = await waitForTrackState(
            failureTrack.id,
            (track) => track?.analysisStatus === "failed",
            120000
        );
        if (!failureTrackAfter || failureTrackAfter.analysisStatus !== "failed") {
            const tail = logBuffer.value.slice(-4000);
            throw new Error(
                `Failure track did not reach failed status within timeout (last status: ${failureTrackAfter?.analysisStatus ?? "missing"}). Log tail:\n${tail}`
            );
        }

        await redis.publish("audio:analysis:control", "stop");

        const exitCode = await new Promise<number | null>((resolve) => {
            const timeout = setTimeout(() => {
                analyzer?.kill("SIGTERM");
            }, 15000);
            analyzer?.on("exit", (code) => {
                clearTimeout(timeout);
                resolve(code);
            });
        });

        const requiredLogPatterns = [
            /Cleaning up stale processing tracks\.\.\./,
            /Checking for failed tracks to retry\.\.\./,
            /Audio analysis PAUSED/,
            /Audio analysis RESUMED/,
            /Worker resize queued:/,
            /Skipped \d+ stale queue entries \(non-pending status\)/,
            /No pending tracks left in batch after status guard/,
            /Received control signal: stop/,
            /Worker stopped/,
        ];

        const missingPatterns = requiredLogPatterns.filter(
            (pattern) => !pattern.test(logBuffer.value)
        );
        if (missingPatterns.length > 0) {
            throw new Error(
                `Missing expected log patterns: ${missingPatterns
                    .map((pattern) => pattern.toString())
                    .join(", ")}`
            );
        }

        if (failureTrackAfter.analysisStatus !== "failed") {
            throw new Error(
                `Expected failure track to end in failed status, got ${failureTrackAfter.analysisStatus}`
            );
        }
        if (failureTrackAfter.analysisRetryCount <= failureTrackBefore.analysisRetryCount) {
            throw new Error(
                `Expected failure track retry count to increment from ${failureTrackBefore.analysisRetryCount}, got ${failureTrackAfter.analysisRetryCount}`
            );
        }

        console.log(`[smoke] analyzer exit code: ${exitCode}`);
        console.log(
            `[smoke] failure track state: ${failureTrackAfter.analysisStatus}, retries=${failureTrackAfter.analysisRetryCount}`
        );
        console.log("[smoke] Phase 4 analyzer regression checks passed");
    } finally {
        if (analyzer && !analyzer.killed) {
            analyzer.kill("SIGTERM");
        }
        if (redis) {
            await redis.quit().catch(() => undefined);
        }
        fs.writeFileSync(smokeLogPath, logBuffer.value, "utf8");
        console.log(`[smoke] wrote analyzer logs to ${smokeLogPath}`);

        // Restore modified tracks to pre-smoke state for idempotent reruns.
        await prisma.track.update({
            where: { id: staleTrackBefore.id },
            data: {
                analysisStatus: staleTrackBefore.analysisStatus,
                analysisError: staleTrackBefore.analysisError,
                analysisRetryCount: staleTrackBefore.analysisRetryCount,
                analysisStartedAt: staleTrackBefore.analysisStartedAt,
            },
        });
        await prisma.track.update({
            where: { id: failureTrackBefore.id },
            data: {
                analysisStatus: failureTrackBefore.analysisStatus,
                analysisError: failureTrackBefore.analysisError,
                analysisRetryCount: failureTrackBefore.analysisRetryCount,
                analysisStartedAt: failureTrackBefore.analysisStartedAt,
            },
        });
    }
}

run()
    .catch((error) => {
        console.error("[smoke] analyzer phase4 regression failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
