import { collectDefaultMetrics, Registry } from "prom-client";
import {
    createDomainMetrics,
    type FederationSyncSkipReason,
} from "./domainMetrics";
import { createHttpRequestMetrics } from "./httpMetrics";
import {
    createLoudnessMetrics,
    LOUDNESS_BACKFILL_OUTCOMES,
    loudnessBackfillOutcomeKey,
    parseLoudnessOutcomeCount,
} from "./loudnessMetrics";
import {
    createLibraryHealthMetrics,
    type LibraryHealthCachePanel,
    type LibraryHealthCacheResult,
} from "./libraryHealthMetrics";
import {
    createProviderMetrics,
    type VibeProviderEndpoint,
    type VibeProviderOutcome,
} from "./providerMetrics";
import type {
    FederationEmbeddingExportOutcome,
    FederationEmbeddingPageOutcome,
} from "../services/federationEmbeddingSpace";
import {
    createVibeEmbedMetrics,
    type VibeEmbedJobOutcome,
    type VibeEmbeddingCoverage,
    type VibeProviderConfigErrorReason,
    type VibeSpaceTransition,
    type VibeVocabularySpaceMismatchReason,
} from "./vibeEmbedMetrics";
import { VIBE_PROVIDER_QUEUE_KEY } from "../workers/legacyVibeRedisCleanup";
import { prisma } from "../utils/db";

/** Single process-local Prometheus registry. */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
    prefix: "soundspan_",
    register: metricsRegistry,
});

const httpMetrics = createHttpRequestMetrics(metricsRegistry);
const domainMetrics = createDomainMetrics(metricsRegistry);
const libraryHealthMetrics = createLibraryHealthMetrics(metricsRegistry);
const providerMetrics = createProviderMetrics(metricsRegistry);
createLoudnessMetrics(metricsRegistry, prisma, {
    getBackfillOutcomes: async () => {
        const { redisClient } = await import("../utils/redis");
        const values = await redisClient.mGet(
            LOUDNESS_BACKFILL_OUTCOMES.map(loudnessBackfillOutcomeKey),
        );
        return {
            measured_success: parseLoudnessOutcomeCount(values[0] ?? null),
            transient_failure: parseLoudnessOutcomeCount(values[1] ?? null),
            permanently_skipped: parseLoudnessOutcomeCount(values[2] ?? null),
        };
    },
});
const vibeEmbedMetrics = createVibeEmbedMetrics(metricsRegistry, {
    // Resolved at scrape time: importing the client eagerly would pull the
    // validated runtime config into every module that imports metrics.
    getProviderQueueDepth: async () => {
        const { redisClient } = await import("../utils/redis");
        return redisClient.lLen(VIBE_PROVIDER_QUEUE_KEY);
    },
    getProviderStatusFresh: async () => {
        const [{ redisClient }, { readVibeWorkerStatus }] = await Promise.all([
            import("../utils/redis"),
            import("../workers/vibeWorkerStatus"),
        ]);
        return (await readVibeWorkerStatus(redisClient)) !== null;
    },
});

/** Express middleware recording bounded HTTP request duration labels. */
export const httpMetricsMiddleware = httpMetrics.middleware;

/** Records one browse-image cache lookup. */
export function recordBrowseImageCacheResult(result: "hit" | "miss"): void {
    domainMetrics.browseImageCacheRequests.inc({ result });
}

/** Records one Library Health panel cache outcome. */
export function recordLibraryHealthCacheResult(
    panel: LibraryHealthCachePanel,
    result: LibraryHealthCacheResult,
): void {
    libraryHealthMetrics.cacheResults.inc({ panel, result });
}

/** Records one final federation sync outcome. */
export function recordFederationSyncOutcome(
    outcome: "success" | "failure",
): void {
    domainMetrics.federationSyncs.inc({ outcome });
}

/** Records bounded federation data discarded during compatibility parsing. */
export function recordFederationSyncSkip(
    reason: FederationSyncSkipReason,
    count = 1,
): void {
    domainMetrics.federationSyncSkips.inc({ reason }, count);
}

/** Records one final vibe-provider request outcome and duration. */
export function recordVibeProviderRequest(
    endpoint: VibeProviderEndpoint,
    outcome: VibeProviderOutcome,
    durationSeconds: number,
): void {
    providerMetrics.record(endpoint, outcome, durationSeconds);
}

/** Records one final backend-driven audio embedding job outcome. */
export function recordVibeEmbedJobOutcome(outcome: VibeEmbedJobOutcome): void {
    vibeEmbedMetrics.recordJob(outcome);
}

/** Records one embedding-space lifecycle transition. */
export function recordVibeSpaceTransition(
    transition: VibeSpaceTransition,
): void {
    vibeEmbedMetrics.recordSpaceTransition(transition);
}

/** Records one rejected provider configuration. */
export function recordVibeProviderConfigError(
    reason: VibeProviderConfigErrorReason,
): void {
    vibeEmbedMetrics.recordProviderConfigError(reason);
}

/** Records one skipped vocabulary blend due to space incompatibility. */
export function recordVibeVocabularySpaceMismatch(
    reason: VibeVocabularySpaceMismatchReason,
): void {
    vibeEmbedMetrics.recordVocabularySpaceMismatch(reason);
}

/** Replaces the worker target-space audio embedding coverage gauge values. */
export function setVibeEmbeddingCoverage(
    coverage: VibeEmbeddingCoverage,
): void {
    vibeEmbedMetrics.setCoverage(coverage);
}

/** Publishes the configured vibe provider queue admission capacity. */
export function setVibeProviderQueueCapacity(capacity: number): void {
    vibeEmbedMetrics.setProviderQueueCapacity(capacity);
}

/** Marks whether the worker currently owns a migrating target space. */
export function setVibeMigrationActive(active: boolean): void {
    vibeEmbedMetrics.setMigrationActive(active);
}

/** Records one completed federation page carrying peer embeddings. */
export function recordFederationEmbeddingPageOutcome(
    outcome: FederationEmbeddingPageOutcome,
): void {
    domainMetrics.federationEmbeddingPages.inc({ outcome });
}

/** Records one exporter-side embedding compatibility decision. */
export function recordFederationEmbeddingExportOutcome(
    outcome: FederationEmbeddingExportOutcome,
): void {
    domainMetrics.federationEmbeddingExports.inc({ outcome });
}
