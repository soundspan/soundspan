import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { trackMappingService } from "../services/trackMappingService";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SAMPLE_SIZE = 100;

let stalenessInterval: ReturnType<typeof setInterval> | null = null;
let stalenessRunInFlight = false;

function resolveIntervalMs(): number {
    const parsed = Number.parseInt(
        process.env.TRACK_MAPPING_STALENESS_INTERVAL_MS ??
            `${DEFAULT_INTERVAL_MS}`,
        10
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runTrackMappingStalenessCheck(): Promise<void> {
    if (stalenessRunInFlight) {
        return;
    }
    stalenessRunInFlight = true;

    try {
        const candidates = await prisma.trackMapping.findMany({
            where: { stale: false },
            select: {
                id: true,
                trackTidalId: true,
                trackYtMusicId: true,
                trackTidal: {
                    select: { id: true },
                },
                trackYtMusic: {
                    select: { id: true },
                },
            },
            orderBy: { createdAt: "asc" },
            take: DEFAULT_SAMPLE_SIZE,
        });

        let markedStale = 0;
        for (const mapping of candidates) {
            const missingTidalTarget =
                Boolean(mapping.trackTidalId) && !mapping.trackTidal;
            const missingYtTarget =
                Boolean(mapping.trackYtMusicId) && !mapping.trackYtMusic;
            if (!missingTidalTarget && !missingYtTarget) {
                continue;
            }
            try {
                await trackMappingService.markStale(mapping.id);
                markedStale += 1;
            } catch (error) {
                logger.warn(
                    `[TrackMappingStaleness] Failed to mark stale mapping ${mapping.id}`,
                    error
                );
            }
        }

        if (markedStale > 0) {
            logger.info(
                `[TrackMappingStaleness] Marked ${markedStale} stale track mappings`
            );
        }
    } catch (error) {
        logger.error(
            "[TrackMappingStaleness] Staleness check failed",
            error
        );
    } finally {
        stalenessRunInFlight = false;
    }
}

/**
 * Starts periodic stale-mapping detection for remote track mappings.
 */
export function startTrackMappingStalenessWorker(): void {
    if (stalenessInterval) return;

    const intervalMs = resolveIntervalMs();
    stalenessInterval = setInterval(() => {
        void runTrackMappingStalenessCheck();
    }, intervalMs);
    if (typeof stalenessInterval.unref === "function") {
        stalenessInterval.unref();
    }
    void runTrackMappingStalenessCheck();
    logger.info(
        `[TrackMappingStaleness] Worker started (intervalMs=${intervalMs})`
    );
}

/**
 * Stops the periodic stale-mapping worker if it is running.
 */
export function stopTrackMappingStalenessWorker(): void {
    if (!stalenessInterval) return;
    clearInterval(stalenessInterval);
    stalenessInterval = null;
}
