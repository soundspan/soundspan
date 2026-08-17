import { collectDefaultMetrics, Registry } from "prom-client";
import { createDomainMetrics } from "./domainMetrics";
import { createHttpRequestMetrics } from "./httpMetrics";
import {
    createProviderMetrics,
    type VibeProviderEndpoint,
    type VibeProviderOutcome,
} from "./providerMetrics";

/** Single process-local Prometheus registry. */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
    prefix: "soundspan_",
    register: metricsRegistry,
});

const httpMetrics = createHttpRequestMetrics(metricsRegistry);
const domainMetrics = createDomainMetrics(metricsRegistry);
const providerMetrics = createProviderMetrics(metricsRegistry);

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
