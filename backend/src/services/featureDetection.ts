import { existsSync } from "fs";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getActiveSpace } from "./embeddingSpaces";
import {
    readVibeWorkerStatus,
    type VibeWorkerStatus,
} from "../workers/vibeWorkerStatus";

const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";

export interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    vibe: VibeFeatureStatus;
}

/** Compact provider and embedding-migration state for the system API. */
export interface VibeFeatureStatus {
    provider: {
        configured: boolean;
        reachable: boolean | null;
        checkedAt: string | null;
    };
    activeSpace: { id: string; family: string } | null;
    migration: {
        spaceId: string;
        family: string;
        coverage: VibeWorkerStatus["coverage"];
        cutoverThreshold: number;
    } | null;
}

const HEARTBEAT_TTL = 300000;
const CACHE_TTL = 60000;

function buildMigration(
    workerStatus: VibeWorkerStatus | null,
    activeSpace: VibeFeatureStatus["activeSpace"],
): VibeFeatureStatus["migration"] {
    if (workerStatus?.targetSpace?.status !== "migrating") return null;
    if (workerStatus.targetSpace.id === activeSpace?.id) return null;
    return {
        spaceId: workerStatus.targetSpace.id,
        family: workerStatus.targetSpace.family,
        coverage: workerStatus.coverage,
        cutoverThreshold: config.vibeSpaceCutoverThreshold,
    };
}

async function loadVibeStatus(): Promise<VibeFeatureStatus> {
    const configured = Boolean(config.vibeProviderUrl);
    const [activeResult, workerResult] = await Promise.allSettled([
        getActiveSpace(),
        configured ? readVibeWorkerStatus(redisClient) : Promise.resolve(null),
    ]);
    if (activeResult.status === "rejected") {
        logger.error(
            "Failed to read cached active vibe space",
            activeResult.reason,
        );
    }
    if (workerResult.status === "rejected") {
        logger.error(
            "Failed to read cached vibe worker status",
            workerResult.reason,
        );
    }
    const activeSpace =
        activeResult.status === "fulfilled"
            ? { id: activeResult.value.id, family: activeResult.value.family }
            : null;
    const workerStatus =
        workerResult.status === "fulfilled" ? workerResult.value : null;
    const reachability = configured
        ? (workerStatus?.providerReachability ?? null)
        : null;
    return {
        provider: {
            configured,
            reachable: reachability?.reachable ?? null,
            checkedAt: reachability?.checkedAt ?? null,
        },
        activeSpace,
        migration: configured
            ? buildMigration(workerStatus, activeSpace)
            : null,
    };
}

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) return this.cache;

        const musicCNN = await this.checkMusicCNN();
        const vibeEmbeddings = Boolean(config.vibeProviderUrl);
        const vibe = await loadVibeStatus();
        this.cache = { musicCNN, vibeEmbeddings, vibe };
        this.lastCheck = now;
        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}`,
        );
        return this.cache;
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            if (existsSync(ESSENTIA_ANALYZER_PATH)) return true;
            const heartbeat = await redisClient.get("audio:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL)
                    return true;
            }
            const trackWithEnergy = await prisma.track.findFirst({
                where: { energy: { not: null } },
                select: { id: true },
            });
            return trackWithEnergy !== null;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking MusicCNN:", error);
            return false;
        }
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
