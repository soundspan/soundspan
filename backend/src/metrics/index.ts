import { collectDefaultMetrics, Registry } from "prom-client";
import { createDomainMetrics } from "./domainMetrics";
import { createHttpRequestMetrics } from "./httpMetrics";
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

/** Single process-local Prometheus registry. */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
    prefix: "soundspan_",
    register: metricsRegistry,
});

const httpMetrics = createHttpRequestMetrics(metricsRegistry);
const domainMetrics = createDomainMetrics(metricsRegistry);
const providerMetrics = createProviderMetrics(metricsRegistry);
const vibeEmbedMetrics = createVibeEmbedMetrics(metricsRegistry, {
    // Resolved at scrape time: importing the client eagerly would pull the
    // validated runtime config into every module that imports metrics.
    getProviderQueueDepth: async () => {
        const { redisClient } = await import("../utils/redis");
        return redisClient.lLen(VIBE_PROVIDER_QUEUE_KEY);
    },
});

/** Express middleware recording bounded HTTP request duration labels. */
export const httpMetricsMiddleware = httpMetrics.middleware;

/** Records one segmented transcode cache lookup. */
export function recordTranscodeCacheResult(result: "hit" | "miss"): void {
    domainMetrics.transcodeCacheRequests.inc({ result });
}

/** Records one browse-image cache lookup. */
export function recordBrowseImageCacheResult(result: "hit" | "miss"): void {
    domainMetrics.browseImageCacheRequests.inc({ result });
}

/** Records one final federation sync outcome. */
export function recordFederationSyncOutcome(
    outcome: "success" | "failure",
): void {
    domainMetrics.federationSyncs.inc({ outcome });
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
