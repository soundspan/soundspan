import type { Job } from "bull";
import { config } from "../config";
import { prisma } from "../utils/db";
import { federationQueue } from "./queues";
import { processFederationHealth } from "./processors/federationHealthProcessor";
import { processFederationSync } from "./processors/federationSyncProcessor";

export const FEDERATION_SYNC_JOB_NAME = "peer-sync";
export const FEDERATION_SYNC_TICK_JOB_NAME = "sync-tick";
export const FEDERATION_HEALTH_JOB_NAME = "peer-health";
const ONE_HOUR_MS = 60 * 60 * 1_000;
const MAX_CONSUMER_PEERS = 500;

async function removeTerminalJob(jobId: string): Promise<string | null> {
    const job = await federationQueue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    if (state === "failed" || state === "completed") await job.remove();
    return state;
}

/** Enqueues or coalesces one peer's sync through a deterministic Bull job id. */
export async function enqueueFederationSyncNow(peerId: string): Promise<void> {
    const primaryJobId = `federation-sync:${peerId}`;
    const state = await removeTerminalJob(primaryJobId);
    const jobId =
        state === "active" ? `${primaryJobId}:followup` : primaryJobId;
    if (jobId !== primaryJobId) await removeTerminalJob(jobId);
    await federationQueue.add(
        FEDERATION_SYNC_JOB_NAME,
        { peerId },
        {
            jobId,
            attempts: 3,
            backoff: { type: "exponential", delay: 1_000 },
            removeOnComplete: true,
            removeOnFail: 10,
        },
    );
}

async function enqueueConsumerPeerSyncs(): Promise<void> {
    const peers = await prisma.federationPeer.findMany({
        where: {
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: { not: "REVOKED" },
            baseUrl: { not: null },
            outboundToken: { not: null },
        },
        orderBy: { id: "asc" },
        take: MAX_CONSUMER_PEERS,
        select: { id: true },
    });
    for (let index = 0; index < MAX_CONSUMER_PEERS; index += 1) {
        const peer = peers[index];
        if (!peer) break;
        await enqueueFederationSyncNow(peer.id);
    }
}

/** Registers bounded federation queue processors when the feature is enabled. */
export function registerFederationProcessors(): void {
    federationQueue.process(FEDERATION_SYNC_JOB_NAME, 2, processFederationSync);
    federationQueue.process(FEDERATION_HEALTH_JOB_NAME, 1, async () =>
        processFederationHealth(),
    );
    federationQueue.process(
        FEDERATION_SYNC_TICK_JOB_NAME,
        1,
        async (_job: Job) => enqueueConsumerPeerSyncs(),
    );
}

/** Registers startup and repeat jobs for consumer sync and hourly health checks. */
export async function registerFederationSchedules(): Promise<void> {
    await federationQueue.isReady();
    await federationQueue.add(
        FEDERATION_HEALTH_JOB_NAME,
        {},
        {
            jobId: "federation-health:startup",
            removeOnComplete: true,
            removeOnFail: 20,
        },
    );
    await federationQueue.add(
        FEDERATION_HEALTH_JOB_NAME,
        {},
        {
            jobId: "federation-health:repeat",
            repeat: { every: ONE_HOUR_MS },
            removeOnComplete: true,
            removeOnFail: 20,
        },
    );
    await federationQueue.add(
        FEDERATION_SYNC_TICK_JOB_NAME,
        {},
        {
            jobId: "federation-sync-tick:startup",
            delay: 10_000,
            removeOnComplete: true,
            removeOnFail: 20,
        },
    );
    await federationQueue.add(
        FEDERATION_SYNC_TICK_JOB_NAME,
        {},
        {
            jobId: "federation-sync-tick:repeat",
            repeat: {
                every: config.workers.federationSyncIntervalMinutes * 60_000,
            },
            removeOnComplete: true,
            removeOnFail: 20,
        },
    );
}
