/**
 * Discover Weekly scheduler + processor
 *
 * Uses Bull repeatable jobs (claim-first queue ownership) instead of in-process
 * node-cron timers so only one worker processes each tick across replicas.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { discoverQueue } from "./queues";
import { config } from "../config";
import { format, startOfWeek } from "date-fns";

const DISCOVER_WEEKLY_CRON = "0 20 * * 0"; // Sunday 20:00
const DISCOVER_CRON_REPEAT_JOB_ID = "discover:cron:tick";

function getDiscoverCronJobId(userId: string, now: Date = new Date()): string {
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const weekKey = format(weekStart, "yyyy-MM-dd");
    return `discover:cron:${weekKey}:${userId}`;
}

export async function processDiscoverCronTick(): Promise<void> {
    logger.debug(`\n === Discover Weekly Cron Tick Triggered ===`);
    logger.debug(`   Time: ${new Date().toLocaleString()}`);

    // Get all users with Discover Weekly enabled
    const configs = await prisma.userDiscoverConfig.findMany({
        where: {
            enabled: true,
        },
        select: {
            userId: true,
            playlistSize: true,
        },
    });

    logger.debug(
        `   Found ${configs.length} users with Discover Weekly enabled`
    );

    for (const userConfig of configs) {
        const jobId = getDiscoverCronJobId(userConfig.userId);
        logger.debug(
            `   Queueing recommendation job for user ${userConfig.userId} (jobId=${jobId})...`
        );

        await discoverQueue.add(
            "discover-recommendation",
            {
                userId: userConfig.userId,
            },
            {
                // Deduplicate cron-triggered work across multiple worker replicas.
                jobId,
            }
        );
    }

    logger.debug(`   Queued ${configs.length} Discover Weekly jobs`);
}

export function startDiscoverWeeklyCron() {
    logger.debug(
        `Scheduling Discover Weekly via repeatable queue: ${DISCOVER_WEEKLY_CRON} (Sundays at 8 PM, mode=${config.discover.mode})`
    );

    void discoverQueue
        .add(
            "discover-cron-tick",
            {},
            {
                jobId: DISCOVER_CRON_REPEAT_JOB_ID,
                repeat: {
                    cron: DISCOVER_WEEKLY_CRON,
                },
                removeOnComplete: true,
                removeOnFail: 10,
            }
        )
        .then(() => {
            logger.debug("Discover Weekly repeatable scheduler registered");
        })
        .catch((error: any) => {
            logger.error(
                `Discover Weekly repeatable scheduler registration failed:`,
                error.message || error
            );
        });
}

export function stopDiscoverWeeklyCron() {
    void discoverQueue
        .removeRepeatable("discover-cron-tick", { cron: DISCOVER_WEEKLY_CRON })
        .then(() => {
            logger.debug("Discover Weekly repeatable scheduler removed");
        })
        .catch((error: any) => {
            logger.warn(
                `Discover Weekly repeatable scheduler remove failed:`,
                error.message || error
            );
        });
}

