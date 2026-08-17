import { existsSync } from "fs";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";

export interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
}

const HEARTBEAT_TTL = 300000;
const CACHE_TTL = 60000;

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) return this.cache;

        const musicCNN = await this.checkMusicCNN();
        const vibeEmbeddings = Boolean(config.vibeProviderUrl);
        this.cache = { musicCNN, vibeEmbeddings };
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
